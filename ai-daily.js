require('dotenv').config();
const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const {
  insertChronicleEntry,
  writeChronicleEntryArtifact,
} = require('./chronicle-utils');
const {
  beijingNow,
  getBeijingDateParts,
  beijingDateISO,
  beijingDateCN,
} = require('./lib/date-utils');
const {
  buildSourceList: buildSafeSourceList,
  hasUnsafeMarkdownSeparator,
  normalizeReport: normalizeSafeReport,
  sanitizeNewsItem,
} = require('./lib/markdown-safety');
const {
  buildChronicleEntry,
  extractRecentChronicleContext,
  parseDailySourceItems,
  parseJsonObject,
  validateChronicleCandidate,
  validateChronicleEntry,
} = require('./lib/chronicle-quality');
const {
  extractPublishedAt,
  formatNewsItemForPrompt,
  interpretQualityResponse,
  isPublishedWithin,
} = require('./lib/daily-report-quality');

// ============ 配置 ============
const PROXY_URL = (process.env.PROXY_URL || '').trim();
let proxyAgent;
if (PROXY_URL) {
  try {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
  } catch (err) {
    console.error(`[配置] 代理 URL 无效，将跳过代理: ${err.message}`);
  }
}

const API_KEY = (process.env.AUTH_TOKEN || process.env.GEMINI_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
const BASE_URL = (process.env.BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').trim();
const MODEL = (process.env.MODEL || 'gemini-3.6-flash').trim();
const MAX_REPORT_TOKENS = Number.parseInt(process.env.MAX_TOKENS || '8192', 10) || 8192;
const RSS_TIMEOUT_MS = Number.parseInt(process.env.RSS_TIMEOUT_MS || '12000', 10) || 12000;
const PROMPT_NEWS_LIMIT = 40;
const PROMPT_SNIPPET_CHARS = 500;
const CHRONICLE_NEWS_LIMIT = 50;
const CHRONICLE_LOOKBACK_DAYS = 7;

let client;

function getClient() {
  if (!API_KEY) {
    console.error('错误: 环境变量 AUTH_TOKEN, GEMINI_API_KEY 或 DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }

  if (!client) {
    client = new OpenAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      timeout: 180000,
      maxRetries: 2,
      defaultHeaders: {
        'Accept-Encoding': 'identity',
      },
    });
  }

  return client;
}

const parser = new RSSParser({
  requestOptions: proxyAgent ? { agent: proxyAgent } : {},
  timeout: RSS_TIMEOUT_MS,
});

const HEXO_DIR = process.env.HEXO_DIR || '.';
const CHRONICLE_FILE = path.join(HEXO_DIR, 'source', '_posts', 'ai-chronicle.md');
const CHRONICLE_ENTRY_FILE = (process.env.CHRONICLE_ENTRY_FILE || '').trim();

function parseRunMode() {
  const deploy = process.argv.includes('--deploy');
  const noDeploy = process.argv.includes('--no-deploy');
  const force = process.argv.includes('--force');
  if (deploy && noDeploy) {
    console.error('错误: --deploy 和 --no-deploy 不能同时使用');
    process.exit(1);
  }
  if (deploy) {
    console.error('错误: --deploy 已停用。请先提交并推送源文件，再运行 npm run deploy 触发安全部署。');
    process.exit(1);
  }
  return { force };
}

function getDailyPostPath(dateISO) {
  const postsDir = path.join(HEXO_DIR, 'source', '_posts');
  const fileName = `ai-daily-${dateISO}.md`;
  return {
    postsDir,
    fileName,
    filePath: path.join(postsDir, fileName),
  };
}

// ============ 北京时间工具函数 ============
// 见 ./lib/date-utils.js（共享模块，与 society-daily.js / apply-chronicle-entry.js 复用）

// AI新闻RSS源
const RSS_SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', name: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica', requireAIKeyword: true },
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT Tech Review', requireAIKeyword: true },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat' },
  { url: 'https://9to5google.com/feed/', name: '9to5Google', requireAIKeyword: true },
  { url: 'https://importai.net/feed/', name: 'Import AI' },
  { url: 'https://www.interconnects.ai/feed', name: 'Interconnects' },
  { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face Blog' },
  { url: 'https://stratechery.com/feed/', name: 'Stratechery', requireAIKeyword: true },
  { url: 'https://openai.com/news/rss.xml', name: 'OpenAI News' },
  { url: 'https://blogs.nvidia.com/feed/', name: 'NVIDIA Blog', requireAIKeyword: true },
  { url: 'https://www.microsoft.com/en-us/research/feed/', name: 'Microsoft Research', requireAIKeyword: true },
  { url: 'https://machinelearning.apple.com/rss.xml', name: 'Apple ML Research' },
  { url: 'https://bair.berkeley.edu/blog/feed.xml', name: 'Berkeley AI Research' },
  { url: 'https://rss.arxiv.org/rss/cs.AI', name: 'arXiv cs.AI' },
  { url: 'https://rss.arxiv.org/rss/cs.CL', name: 'arXiv cs.CL' },
  { url: 'https://rss.arxiv.org/rss/cs.RO', name: 'arXiv cs.RO' },
  { url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss', name: 'IEEE Spectrum AI' },
  { url: 'https://spectrum.ieee.org/feeds/topic/robotics.rss', name: 'IEEE Spectrum Robotics' },
  { url: 'https://www.semianalysis.com/feed', name: 'SemiAnalysis', requireAIKeyword: true },
  { url: 'https://www.gov.uk/government/organisations/ai-security-institute.atom', name: 'UK AI Security Institute' },
  { url: 'https://www.nist.gov/news-events/news/rss.xml', name: 'NIST', requireAIKeyword: true },
  { url: 'https://www.marktechpost.com/feed/', name: 'MarkTechPost' },
];

// Anthropic 与 Google DeepMind 当前没有稳定可用的新闻 RSS，改从官方
// sitemap 读取近期发布页。只接受 news/blog 路径，避免把产品页更新时间
// 误当成新闻发布。
const SITEMAP_SOURCES = [
  {
    url: 'https://www.anthropic.com/sitemap.xml',
    name: 'Anthropic Official',
    pathPattern: /^https:\/\/www\.anthropic\.com\/news\//,
    maxItems: 10,
  },
  {
    url: 'https://deepmind.google/sitemap.xml',
    name: 'Google DeepMind',
    pathPattern: /^https:\/\/deepmind\.google\/blog\//,
    maxItems: 8,
  },
];

const RSS_SOURCES_CN = [
  { url: 'https://www.36kr.com/feed', name: '36氪', requireAIKeyword: true },
  { url: 'https://sspai.com/feed', name: '少数派', requireAIKeyword: true },
  { url: 'https://www.qbitai.com/feed', name: '量子位' },
];

const CN_SOURCES = new Set(RSS_SOURCES_CN.map(source => source.name));

const SOURCE_IMPORTANCE_WEIGHTS = new Map([
  ['Anthropic Official', 12],
  ['OpenAI News', 12],
  ['Google DeepMind', 11],
  ['NVIDIA Blog', 9],
  ['UK AI Security Institute', 9],
  ['Microsoft Research', 8],
  ['Apple ML Research', 8],
  ['NIST', 8],
  ['MIT Tech Review', 7],
  ['Stratechery', 7],
  ['Berkeley AI Research', 7],
  ['SemiAnalysis', 7],
  ['TechCrunch', 6],
  ['The Verge', 6],
  ['Interconnects', 6],
  ['IEEE Spectrum AI', 6],
  ['IEEE Spectrum Robotics', 6],
  ['VentureBeat', 5],
  ['Ars Technica', 5],
  ['Hugging Face Blog', 5],
  ['量子位', 5],
  ['arXiv cs.AI', 4],
  ['arXiv cs.CL', 4],
  ['arXiv cs.RO', 4],
  ['36氪', 4],
  ['Import AI', 4],
  ['MarkTechPost', 3],
  ['9to5Google', 3],
  ['少数派', 3],
]);

const AI_KEYWORDS = [
  'artificial intelligence',
  'generative ai',
  'machine learning',
  'deep learning',
  'large language model',
  'language model',
  'openai',
  'chatgpt',
  'anthropic',
  'claude',
  'gemini',
  'deepseek',
  'mistral',
  'hugging face',
  'nvidia',
  'gpu',
  'neural',
  'multimodal',
  'diffusion',
  'inference',
  'reasoning model',
  'frontier model',
  'foundation model',
  'coding agent',
  'agentic',
  'copilot',
  'cursor',
  'windsurf',
  'perplexity',
  'xai',
  'grok',
  'sora',
  'llama',
  'qwen',
  'kimi',
  'moonshot',
  'runway',
  'midjourney',
  'stable diffusion',
  'ai agent',
  'aigc',
  '人工智能',
  '生成式',
  '大模型',
  '语言模型',
  '多模态',
  '智能体',
  '机器人',
  '智能助手',
  '代码助手',
  '编程助手',
  '推理模型',
  '基础模型',
  '前沿模型',
  '世界模型',
  '自动驾驶',
  '无人车',
  '具身',
  '深度学习',
  '机器学习',
  '开源模型',
  '算力',
  '智算',
  '推理',
  '英伟达',
  'ai芯片',
].map(keyword => keyword.toLowerCase());

const IMPORTANCE_SIGNALS = [
  { token: 'openai', label: 'OpenAI', weight: 10 },
  { token: 'anthropic', label: 'Anthropic', weight: 10 },
  { token: 'google', label: 'Google', weight: 6 },
  { token: 'deepmind', label: 'DeepMind', weight: 6 },
  { token: 'microsoft', label: 'Microsoft', weight: 6 },
  { token: 'nvidia', label: 'NVIDIA', weight: 6 },
  { token: 'meta', label: 'Meta', weight: 5 },
  { token: 'deepseek', label: 'DeepSeek', weight: 5 },
  { token: 'mistral', label: 'Mistral', weight: 4 },
  { token: 'hugging face', label: 'Hugging Face', weight: 4 },
  { token: 'model', label: 'model', weight: 3 },
  { token: 'benchmark', label: 'benchmark', weight: 3 },
  { token: 'agent', label: 'agent', weight: 3 },
  { token: 'robot', label: 'robotics', weight: 3 },
  { token: 'chip', label: 'chip', weight: 3 },
  { token: 'gpu', label: 'GPU', weight: 3 },
  { token: 'regulation', label: 'regulation', weight: 3 },
  { token: 'lawsuit', label: 'legal', weight: 3 },
  { token: 'launch', label: 'launch', weight: 2 },
  { token: 'release', label: 'release', weight: 2 },
  { token: 'unveil', label: 'release', weight: 2 },
  { token: 'raise', label: 'funding', weight: 2 },
  { token: 'acquire', label: 'deal', weight: 2 },
  { token: '人工智能', label: 'AI', weight: 4 },
  { token: '大模型', label: '大模型', weight: 4 },
  { token: '模型', label: '模型', weight: 3 },
  { token: '开源', label: '开源', weight: 3 },
  { token: '智能体', label: '智能体', weight: 3 },
  { token: '算力', label: '算力', weight: 3 },
  { token: '芯片', label: '芯片', weight: 3 },
  { token: '监管', label: '监管', weight: 3 },
  { token: '发布', label: '发布', weight: 2 },
  { token: '融资', label: '融资', weight: 2 },
  { token: '收购', label: '收购', weight: 2 },
];

function isAIRelevantItem(item) {
  const text = [
    item.title,
    item.contentSnippet,
    item.content,
    item.summary,
  ].filter(Boolean).join(' ');
  const lowerText = text.toLowerCase();
  return /\b(ai|llms?)\b/i.test(text) || AI_KEYWORDS.some(keyword => lowerText.includes(keyword));
}

function getItemText(item) {
  return [
    item.title,
    item.contentSnippet,
    item.content,
    item.summary,
    item.snippet,
  ].filter(Boolean).join(' ');
}

function collectImportanceSignals(item) {
  const lowerText = getItemText(item).toLowerCase();
  const matches = [];
  for (const signal of IMPORTANCE_SIGNALS) {
    if (lowerText.includes(signal.token)) {
      matches.push(signal);
    }
  }
  return matches;
}

function rankNewsItems(items) {
  const signalCounts = new Map();
  const signalsByKey = new Map();

  for (const item of items) {
    const key = `${item.title}|${item.link}`;
    const signals = collectImportanceSignals(item);
    signalsByKey.set(key, signals);
    for (const signal of new Set(signals.map(s => s.label))) {
      signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
    }
  }

  const now = Date.now();
  return items.map(item => {
    const key = `${item.title}|${item.link}`;
    const signals = signalsByKey.get(key) || [];
    const labels = [...new Set(signals.map(signal => signal.label))];
    const repeatedSignals = labels.filter(label => (signalCounts.get(label) || 0) > 1);
    const sourceScore = SOURCE_IMPORTANCE_WEIGHTS.get(item.source) || 2;
    const signalScore = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const repeatedScore = repeatedSignals.length * 3;
    const ageHours = Number.isFinite(item._timestamp) ? Math.max(0, (now - item._timestamp) / 36e5) : 24;
    const recencyScore = Math.max(0, 6 - ageHours / 8);
    const priorityScore = Math.round(sourceScore + signalScore + repeatedScore + recencyScore);
    const reasonParts = [
      labels.slice(0, 3).join('/'),
      repeatedSignals.length ? `多源信号:${repeatedSignals.slice(0, 2).join('/')}` : '',
      sourceScore >= 6 ? '权威/主流源' : '',
    ].filter(Boolean);

    return {
      ...item,
      _priorityScore: priorityScore,
      _priorityReason: reasonParts.join('，') || '时间较新/来源补充',
    };
  }).sort((a, b) => {
    if (b._priorityScore !== a._priorityScore) return b._priorityScore - a._priorityScore;
    return b._timestamp - a._timestamp;
  });
}

function selectWithSourceCap(items, limit, maxPerSource, exclude = new Set(), counts = new Map()) {
  const selected = [];

  for (const item of items) {
    const key = `${item.title}|${item.link}`;
    if (exclude.has(key)) continue;

    const count = counts.get(item.source) || 0;
    if (count >= maxPerSource) continue;

    selected.push(item);
    exclude.add(key);
    counts.set(item.source, count + 1);

    if (selected.length >= limit) break;
  }

  return selected;
}

function formatSourceDistribution(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, count]) => `${source}:${count}`)
    .join(', ');
}

function selectNewsForPrompt(newsItems, maxNews = PROMPT_NEWS_LIMIT) {
  const internationalItems = newsItems.filter(item => !CN_SOURCES.has(item.source));
  const cnItems = newsItems.filter(item => CN_SOURCES.has(item.source));
  const selectedKeys = new Set();
  const selectedCounts = new Map();

  const selected = selectWithSourceCap(internationalItems, Math.min(24, maxNews), 6, selectedKeys, selectedCounts);
  selected.push(...selectWithSourceCap(cnItems, maxNews - selected.length, 4, selectedKeys, selectedCounts));

  if (selected.length < maxNews) {
    selected.push(...selectWithSourceCap(newsItems, maxNews - selected.length, 6, selectedKeys, selectedCounts));
  }

  selected.sort((a, b) => {
    if (b._priorityScore !== a._priorityScore) return b._priorityScore - a._priorityScore;
    return b._timestamp - a._timestamp;
  });
  console.log(`[取样] 用于生成: ${selected.length} 条（国际 ${selected.filter(item => !CN_SOURCES.has(item.source)).length}，中文 ${selected.filter(item => CN_SOURCES.has(item.source)).length}）`);
  console.log(`[取样] 来源分布: ${formatSourceDistribution(selected)}`);
  return selected.slice(0, maxNews);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function titleFromUrl(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || 'official update';
    return slug.split('-').filter(Boolean).map(word => {
      if (/^(ai|api|agi|rl)$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
  } catch {
    return 'Official update';
  }
}

async function fetchText(url, timeoutMs = RSS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'hanxiaofan-ai-chronicle/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapNews(source, yesterday) {
  console.log(`[抓取] ${source.name} sitemap...`);
  const xml = await fetchText(source.url);
  const matches = [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)];
  const nowPlusOneDay = Date.now() + 864e5;
  const candidates = matches
    .map(match => ({ link: decodeXml(match[1]), lastmod: decodeXml(match[2]) }))
    .filter(item => source.pathPattern.test(item.link))
    .map(item => ({ ...item, timestamp: new Date(item.lastmod).getTime() }))
    .filter(item => Number.isFinite(item.timestamp) && item.timestamp >= yesterday.getTime() && item.timestamp <= nowPlusOneDay)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, source.maxItems * 3);

  // sitemap.lastmod 只表示页面最近被修改，旧发布页可能因站点重建而批量变新。
  // 逐页读取真实发布日期，避免把历史模型发布误报成今日新闻。
  const pageResults = await Promise.allSettled(candidates.map(async (item) => {
    const html = await fetchText(item.link);
    const publishedAt = extractPublishedAt(html);
    if (!isPublishedWithin(publishedAt, yesterday, nowPlusOneDay)) return null;
    const publishedTimestamp = Date.parse(publishedAt);
    return sanitizeNewsItem({
      title: titleFromUrl(item.link),
      link: item.link,
      date: publishedAt,
      source: source.name,
      snippet: `${source.name} 官方发布，发布日期 ${publishedAt.slice(0, 10)}`,
      _timestamp: publishedTimestamp,
    });
  }));

  const verifiedItems = pageResults
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value)
    .sort((a, b) => b._timestamp - a._timestamp)
    .slice(0, source.maxItems);
  const rejectedCount = pageResults.filter(result => result.status === 'fulfilled' && !result.value).length;
  const failedCount = pageResults.filter(result => result.status === 'rejected').length;
  console.log(`  -> ${source.name}：验证 ${candidates.length} 个近期修改页，接受 ${verifiedItems.length} 条真实近期发布，排除 ${rejectedCount} 条旧页面${failedCount ? `，${failedCount} 页读取失败` : ''}`);
  return verifiedItems;
}

function dedupeNewsItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.link || `${item.source}|${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============ RSS抓取 ============
async function fetchNews() {
  const bj = beijingNow();
  const todayBeijing = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  const yesterday = new Date(todayBeijing);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const sources = [...RSS_SOURCES, ...RSS_SOURCES_CN];

  // 并行抓取所有源：每个源最坏 12s 超时，串行 14 源最坏 ~168s，
  // Promise.allSettled 后整体降到 ~单个最慢源的超时上限。失败源不应中断整体。
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      console.log(`[抓取] ${source.name}...`);
      const feed = await parser.parseURL(source.url);

      const datedItems = (feed.items || [])
        .filter(item => {
          const dateStr = item.pubDate || item.isoDate;
          if (!dateStr) return false;
          const pubDate = new Date(dateStr);
          return !isNaN(pubDate.getTime()) && pubDate >= yesterday;
        });

      const relevantItems = datedItems
        .filter(item => !source.requireAIKeyword || isAIRelevantItem(item));
      const filteredItems = source.requireAIKeyword
        ? datedItems.filter(item => !isAIRelevantItem(item))
        : [];

      const recentItems = relevantItems
        .map(item => sanitizeNewsItem({
          title: item.title || '(无标题)',
          link: item.link || '',
          date: item.pubDate || item.isoDate,
          source: source.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 800),
          _timestamp: new Date(item.pubDate || item.isoDate).getTime(),
        }));

      const filteredOut = datedItems.length - relevantItems.length;
      const filteredSample = filteredItems
        .slice(0, 3)
        .map(item => (item.title || '(无标题)').replace(/\s+/g, ' ').slice(0, 80))
        .join('；');
      console.log(`  -> ${source.name}：获取 ${recentItems.length} 条${filteredOut > 0 ? `，过滤 ${filteredOut} 条非AI素材` : ''}`);
      if (filteredSample) {
        console.log(`     过滤样例: ${filteredSample}`);
      }
      return recentItems;
    })
  );

  const sitemapResults = await Promise.allSettled(
    SITEMAP_SOURCES.map(source => fetchSitemapNews(source, yesterday))
  );

  const allItems = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      allItems.push(...r.value);
    } else {
      console.log(`  -> ${sources[i].name} 抓取失败: ${r.reason?.message || String(r.reason)}`);
    }
  }

  for (let i = 0; i < sitemapResults.length; i += 1) {
    const result = sitemapResults[i];
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      console.log(`  -> ${SITEMAP_SOURCES[i].name} 抓取失败: ${result.reason?.message || String(result.reason)}`);
    }
  }

  const dedupedItems = dedupeNewsItems(allItems);
  dedupedItems.sort((a, b) => {
    const ta = a._timestamp;
    const tb = b._timestamp;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });
  return rankNewsItems(dedupedItems);
}

// ============ LLM生成报告 ============
async function generateReport(newsItems) {
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();
  const MAX_NEWS = PROMPT_NEWS_LIMIT;

  if (newsItems.length > MAX_NEWS) {
    console.log(`[提示] 新闻共 ${newsItems.length} 条，取前 ${MAX_NEWS} 条用于生成`);
  }

  const newsText = newsItems.slice(0, MAX_NEWS)
    .map((item, i) => formatNewsItemForPrompt(item, i, PROMPT_SNIPPET_CHARS))
    .join('\n\n');

  const prompt = `你是资深AI行业信息编辑和分析师。根据以下近期AI新闻，生成一份中文行业日报。

日报日期：${dateISO}

核心目标：让读者尽可能广地掌握今日AI行业信息版图。优先覆盖重要信息、不同来源、不同主题；深度分析点到为止，不为了显得深而展开长文。

写作策略：先在脑中选出3-5条最重要的"重点信号"。这些事件可以在"今日速览"中一行出现，但在后续分类板块里不要再换句话复述同一事实；分类板块优先补充未在重点信号中展开过的次级信息。若同一事件确实需要跨板块引用，只能增加新的角度、数字或后续影响，不要重复"发生了什么"。

近期新闻源：
${newsText}

要求：
1. 不要输出文章总标题，标题会由 Hexo frontmatter 提供
2. 使用 Markdown 二级标题组织结构。以下板块按顺序输出：
   ## 今日速览（固定输出）
   ## 重点信号（固定输出）
   ## 行业动态（有足够素材时输出）
   ## 技术进展（有足够素材时输出）
   ## 商业动态（有足够素材时输出）
   ## 政策与监管（有足够素材时输出）
   ## 观察备忘（固定输出）
3. 各板块说明与格式：
   - **今日速览**：5-10条要点，每条一行。格式：\`- **关键词**：一句话说明发生了什么，以及为什么值得知道\`。覆盖模型、产品、公司、资本、监管、开源/研究等不同方向。
   - **重点信号**：选择最重要的3-5条。每条使用以下结构，用加粗标签分隔：
      - **信息**：1-2句话概述。
        **看点**：1-2句话说明重要性或后续影响。
      不要写成长篇专题；每条重点信号用项目符号分隔，不要使用 \`---\`、\`***\`、\`___\` 等裸分隔线，它们会被 Markdown 渲染成大标题。
   - 行业动态：竞争格局、巨头动作、市场趋势。用短段落或项目符号覆盖多条信息，不要求每条长分析。
   - 技术进展：模型、开源、论文、基准、工具链、硬件。优先多覆盖，不必逐条深入。
   - 商业动态：融资、IPO、收购、产品发布、客户落地。优先覆盖信息面。
   - 政策与监管：全球AI监管政策、合规动态、版权/安全争议。素材不足则跳过。
   - **观察备忘**：用3-5条短判断收束今天的信息格局，只写跨事件的综合判断或待观察变量，不要把前文新闻再复述一遍。
4. 格式要求：
   - 使用项目符号和短段落，帮助快速扫读
   - 每个输出板块至少2处 **加粗关键句或关键词**
   - 不使用编号列表（1. 2. 3.）
5. 风格：信息密度高、专业但不端着。像一份清醒的行业雷达，不像长篇论文。
6. 长度不作为硬目标。素材多可以写长，素材少就保持简洁；宁可覆盖更多重要信息，也不要为了凑字扩写。
7. 去重要求：
   - 同一新闻事实最多在"今日速览"和一个正文分析板块中出现；不要在"重点信号""行业动态""商业动态""观察备忘"之间反复出现。
   - 同一公司名可以因不同事件多次出现，但同一事件不要换标题重复写。
   - 如果某个分类板块没有足够未重复材料，可以缩短或跳过，不要为了凑板块复述。
8. 不要编造来源；不要输出参考来源列表，脚本会自动追加
9. 严格按每条素材的"发布日期"判断时效；不得把历史发布写成今日、近日、一周内发生，不得自行推断未在素材中出现的发布时间或发布顺序
10. 严格基于提供的【素材列表】进行事实归纳，严禁虚构或编造未在素材中出现的公司发布、模型上线或新闻事实
11. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成AI行业日报...');
  const response = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: MAX_REPORT_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response?.choices?.[0]?.message?.content;
  return content?.trim() || '';
}

async function checkQuality(report, newsItems) {
  const localResult = localQualityCheck(report);
  if (!localResult.pass) {
    console.log(`[质检] 本地硬检查失败: ${localResult.reason}`);
    return localResult;
  }

  const evidence = newsItems.slice(0, PROMPT_NEWS_LIMIT).map((item, index) => [
    `${index + 1}. [${item.source}] ${item.title}`,
    `日期: ${item.date || '未知'}`,
    `摘要: ${(item.snippet || '').slice(0, 220)}`,
  ].join(' | ')).join('\n');
  const checkPrompt = `评估以下AI行业日报的质量。必须在第一行直接输出判定结果："PASS" 或 "FAIL: <原因>"。

检查标准：
1. 是否有"今日速览"板块？速览是否包含至少5条要点？
2. 是否有"重点信号"板块？重点信号是否使用 **信息**/**看点** 结构？
3. 是否覆盖多个主题方向，而不是只围绕1-2条新闻展开？
4. 是否避免编造来源、参考来源列表、markdown代码块？
5. 是否避免同一新闻事实在"重点信号""行业动态""商业动态""观察备忘"之间反复重述？如果同一事件只是换句话重复出现，应 FAIL。
6. 对照素材日期，是否把历史发布误写成今日、近日、一周内发生，或编造素材没有支持的发布顺序？出现即 FAIL。
7. 字数长短、分析深度不作为失败理由；只在结构明显缺失、信息覆盖明显过窄、事实时间错误或重复明显时 FAIL。

素材证据：
${evidence}

文章内容：
${report.slice(0, 4000)}`;

  try {
    console.log('[质检] 评估生成质量...');
    const response = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: checkPrompt }],
    });

    const choice = response?.choices?.[0];
    const result = choice?.message?.content?.trim() || '';
    console.log(`[质检] finish_reason=${choice?.finish_reason || 'unknown'}，结果: ${result}`);
    return interpretQualityResponse(result);
  } catch (err) {
    console.log(`[质检] 评估失败，拒绝放行: ${err.message}`);
    return { pass: false, reason: `质检异常: ${err.message}` };
  }
}

function localQualityCheck(report) {
  const plainText = report
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`[\]()!\-]/g, '')
    .replace(/\s+/g, '');
  const sectionCount = (report.match(/^##\s+/gm) || []).length;
  const overviewLineCount = (report.match(/^\s*-\s+\*\*.+?\*\*[：:]/gm) || []).length;

  if (hasUnsafeMarkdownSeparator(report)) {
    return { pass: false, reason: '正文包含裸 Markdown 分隔线，可能被 Hexo 渲染成异常大标题' };
  }

  if (plainText.length < 800) {
    return { pass: false, reason: `正文异常过短：${plainText.length} 字，可能生成不完整` };
  }

  if (sectionCount < 3) {
    return { pass: false, reason: `板块过少：${sectionCount} 个，少于 3 个` };
  }

  if (!/^##\s+今日速览/m.test(report)) {
    return { pass: false, reason: '缺少今日速览板块' };
  }

  if (!/^##\s+重点信号/m.test(report)) {
    return { pass: false, reason: '缺少重点信号板块' };
  }

  if (overviewLineCount < 4) {
    return { pass: false, reason: `速览要点过少：${overviewLineCount} 条，少于 4 条` };
  }

  return { pass: true, reason: '本地硬检查通过' };
}

const SOURCE_COVERAGE_THRESHOLDS = {
  idealNewsItems: 12,
  idealSources: 5,
  minimumNewsItems: 8,
  minimumSources: 3,
};

function validateSourceCoverage(newsItems) {
  const sourceCount = new Set(newsItems.map(item => item.source)).size;
  const warnings = [];

  if (newsItems.length < SOURCE_COVERAGE_THRESHOLDS.minimumNewsItems) {
    return {
      pass: false,
      reason: '素材过少：' + newsItems.length + ' 条，少于可生成下限 ' + SOURCE_COVERAGE_THRESHOLDS.minimumNewsItems + ' 条',
    };
  }

  if (sourceCount < SOURCE_COVERAGE_THRESHOLDS.minimumSources) {
    return {
      pass: false,
      reason: '来源过少：' + sourceCount + ' 个，少于可生成下限 ' + SOURCE_COVERAGE_THRESHOLDS.minimumSources + ' 个',
    };
  }

  if (newsItems.length < SOURCE_COVERAGE_THRESHOLDS.idealNewsItems) {
    warnings.push('素材 ' + newsItems.length + ' 条，低于理想值 ' + SOURCE_COVERAGE_THRESHOLDS.idealNewsItems + ' 条');
  }

  if (sourceCount < SOURCE_COVERAGE_THRESHOLDS.idealSources) {
    warnings.push('来源 ' + sourceCount + ' 个，低于理想值 ' + SOURCE_COVERAGE_THRESHOLDS.idealSources + ' 个');
  }

  if (warnings.length > 0) {
    return { pass: true, reason: '素材覆盖偏低：' + warnings.join('；') + '，降级继续生成' };
  }

  return { pass: true, reason: '素材覆盖通过' };
}

function formatErrorMessage(err) {
  return [err?.name, err?.code, err?.status, err?.message]
    .filter(Boolean)
    .join(' ') || String(err);
}

function isTransientLLMError(err) {
  const status = Number(err?.status || err?.response?.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = formatErrorMessage(err).toLowerCase();
  return [
    'premature close',
    'invalid response body',
    'socket hang up',
    'econnreset',
    'etimedout',
    'fetch failed',
    'network',
    'aborted',
    'timeout',
    'temporarily unavailable',
  ].some(token => message.includes(token));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithRetry(promptNewsItems, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) console.log(`\n[重试] 第 ${attempt} 次重新生成...`);

    let report = '';
    try {
      report = await generateReport(promptNewsItems);
    } catch (err) {
      const message = formatErrorMessage(err);
      if (attempt < maxRetries && isTransientLLMError(err)) {
        const delayMs = Math.min(30000, 5000 * 2 ** attempt);
        console.log(`[生成] LLM调用失败（${message}），${Math.round(delayMs / 1000)}秒后重试...`);
        await wait(delayMs);
        continue;
      }

      console.error(`[生成] LLM调用失败，已无可用重试: ${message}`);
      throw err;
    }

    if (!report) {
      console.log('[生成] 空内容，重试...');
      continue;
    }

    const { pass, reason } = await checkQuality(report, promptNewsItems);

    if (pass) {
      console.log('[质检] 通过！');
      return report;
    }

    console.log(`[质检] 未通过: ${reason}`);
  }

  throw new Error('所有生成结果均未通过完整质检，拒绝发布');
}

function normalizeReport(report, title) {
  return normalizeSafeReport(report, title);
}

function buildSourceList(newsItems, maxSources = 30) {
  return buildSafeSourceList(newsItems, maxSources);
}

// ============ 编年史更新 ============
function getDateBefore(dateISO, offsetDays) {
  const date = new Date(`${dateISO}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offsetDays);
  return date.toISOString().slice(0, 10);
}

function loadRecentDailyEvidence(dateISO, lookbackDays = CHRONICLE_LOOKBACK_DAYS) {
  const postsDir = path.join(HEXO_DIR, 'source', '_posts');
  const items = [];
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    const reviewDate = getDateBefore(dateISO, offset);
    const filePath = path.join(postsDir, `ai-daily-${reviewDate}.md`);
    if (!fs.existsSync(filePath)) continue;
    const markdown = fs.readFileSync(filePath, 'utf-8');
    items.push(...parseDailySourceItems(markdown, reviewDate).map(sanitizeNewsItem));
  }
  return items;
}

function selectChronicleEvidence(newsItems, dateISO) {
  const rollingItems = loadRecentDailyEvidence(dateISO);
  const combined = dedupeNewsItems([...newsItems, ...rollingItems]);
  const ranked = rankNewsItems(combined);
  // 控制单一来源占比，让扩展后的研究、机器人、政策与基础设施来源
  // 真正进入候选池，而不是被少数高频媒体淹没。
  const selected = selectWithSourceCap(ranked, CHRONICLE_NEWS_LIMIT, 5);
  console.log(`[编年史] 候选证据 ${selected.length} 条（含近 ${CHRONICLE_LOOKBACK_DAYS} 天回看 ${rollingItems.length} 条）`);
  console.log(`[编年史] 证据来源: ${formatSourceDistribution(selected)}`);
  return selected;
}

function formatChronicleEvidence(items) {
  return items.map((item, index) => [
    `${index + 1}. [${item.source}] ${item.title}`,
    `   日期: ${item.date || '未知'}`,
    `   链接: ${item.link || '无'}`,
    item.snippet ? `   摘要: ${item.snippet.slice(0, 350)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

async function callChronicleJson(prompt, label, maxTokens = 2600, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await getClient().chat.completions.create({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const choice = response?.choices?.[0];
      const finishReason = choice?.finish_reason || 'unknown';
      const rawText = choice?.message?.content?.trim() || '';
      console.log(`[编年史] ${label} 第 ${attempt} 次: finish_reason=${finishReason}, ${rawText.slice(0, 180)}`);
      if (finishReason !== 'stop') throw new Error(`输出未完整结束: ${finishReason}`);
      return parseJsonObject(rawText);
    } catch (err) {
      lastError = err;
      console.warn(`[编年史] ${label} 第 ${attempt} 次失败: ${err.message}`);
      if (attempt < attempts) await wait(1000 * attempt);
    }
  }
  throw lastError || new Error(`${label}失败`);
}

async function updateChronicle(newsItems) {
  const { year, month } = getBeijingDateParts();
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();

  let existingChronicle = '';
  if (fs.existsSync(CHRONICLE_FILE)) {
    existingChronicle = fs.readFileSync(CHRONICLE_FILE, 'utf-8');
  }

  try {
    if (CHRONICLE_ENTRY_FILE && fs.existsSync(CHRONICLE_ENTRY_FILE)) {
      fs.unlinkSync(CHRONICLE_ENTRY_FILE);
    }
    const evidenceItems = selectChronicleEvidence(newsItems, dateISO);
    const evidenceText = formatChronicleEvidence(evidenceItems);
    const candidatePrompt = `你是《AI编年史》的事件编辑。请从证据中合并重复报道，找出0-4个值得进入复审的事件候选。

这不是多维分类或机械评分任务。用三条朴素的编辑判断：
- 它是否构成了AI发展路线、产品形态、公司力量、安全治理或社会关系的真实转折；
- 事实是否具体、已发生、证据扎实，而不是标题党、融资传闻或“若成功”的想象；
- 一两年后回看这段历史，人们是否仍需要用它解释这个阶段。

重点关注 Anthropic、OpenAI，以及 Google DeepMind、Meta、DeepSeek、NVIDIA 等真正影响前沿方向的公司和机构。重点关注不等于逢更新必收：常规版本、小功能、营销表态和单纯融资仍应排除。
编辑视野要足够宽：除基础模型与智能体，也主动检查芯片和算力、开源生态、机器人与具身智能、关键研究、安全评测、政策与法律、资本和产业结构、教育劳动与社会影响。它们只是检索视野，不是页面分类，也不要求每个方向都收录。
同一事件的多篇报道必须合并。事件日期使用事实发生或正式发布的日期，不使用抓取日期。
候选事件保持现有时间线风格：用一到两句简短事实写清“谁、做了什么、达到什么结果”，不写评论文章，不另起“为什么重要”。

证据（编号将用于引用）：
${evidenceText}

只输出JSON对象，不要Markdown：
{"candidates":[{"eventDate":"${dateStrCN}","event":"已经发生的具体事实","why":"为什么未来回看仍值得记录","sourceIds":[1,2],"status":"record或watch"}]}
没有候选时输出 {"candidates":[]}。`;

    console.log('[编年史] 第一轮：聚类并提出候选...');
    const candidateResult = await callChronicleJson(candidatePrompt, '候选提取');
    const rawCandidates = Array.isArray(candidateResult.candidates) ? candidateResult.candidates : [];
    const recordCandidates = [];
    for (const candidate of rawCandidates) {
      if (candidate?.status !== 'record') continue;
      const checked = validateChronicleCandidate(candidate, evidenceItems);
      if (!checked.pass) {
        console.log(`[编年史] 候选被本地门禁拒绝: ${checked.reason}`);
        continue;
      }
      recordCandidates.push(checked.candidate);
    }
    if (recordCandidates.length === 0) {
      console.log('[编年史] 没有达到复审标准的候选，不更新');
      return;
    }

    const recentContext = extractRecentChronicleContext(existingChronicle, 12000, year);
    const reviewPrompt = `你是《AI编年史》的终审编辑。请对候选做保守但不迟钝的终审，最终保留0-2条。

终审要求：
- 对照现有编年史，拒绝同一事件换一种说法后的重复收录；
- 只保留证据真正支持的表述，不扩大结论，不把预测写成事实；
- Anthropic、OpenAI 等核心公司的重大模型、产品范式、安全治理和权力结构变化值得重点看，但普通更新仍不收；
- 不要只盯模型发布；芯片算力、开源、机器人、关键研究、安全评测、政策法律和社会结构的真实转折同样可以入选；
- “为什么重要”必须解释历史转折，不写空泛的“影响深远”；
- 不做分类，不输出分数。
- 最终 event 仍是一到两句克制的事实记录，不展示 why，不写成长段分析。

现有近期编年史：
${recentContext}

候选：
${JSON.stringify(recordCandidates, null, 2)}

证据编号表：
${evidenceText}

只输出JSON对象，不要Markdown：
{"entries":[{"eventDate":"${dateStrCN}","event":"完整、可核验的事件事实","why":"具体的历史意义","sourceIds":[1,2]}]}
没有应收录事件时输出 {"entries":[]}。`;

    console.log('[编年史] 第二轮：对照既有记录终审...');
    const reviewResult = await callChronicleJson(reviewPrompt, '终审');
    const reviewedEntries = Array.isArray(reviewResult.entries) ? reviewResult.entries.slice(0, 2) : [];
    let content = existingChronicle;
    const appliedEntries = [];
    const seen = new Set();
    for (const candidate of reviewedEntries) {
      const checked = validateChronicleCandidate(candidate, evidenceItems);
      if (!checked.pass) {
        console.log(`[编年史] 终审条目被本地门禁拒绝: ${checked.reason}`);
        continue;
      }
      const uniqueKey = `${checked.candidate.eventDate}|${checked.candidate.event}`.toLowerCase();
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);
      const entryText = buildChronicleEntry(checked.candidate, evidenceItems);
      const quality = validateChronicleEntry(entryText);
      if (!quality.pass) {
        console.log(`[编年史] 完整性门禁拒绝条目: ${quality.reason}`);
        continue;
      }
      const result = insertChronicleEntry(content, entryText, {
        year,
        month,
        dateISO,
        dateStrCN,
      });
      if (!result.updated) {
        console.log(`[编年史] 跳过新增条目: ${result.reason}`);
        continue;
      }
      content = result.content;
      appliedEntries.push(result.entryText);
    }

    if (appliedEntries.length === 0) {
      console.log('[编年史] 终审后无可安全写入条目，不更新');
      return;
    }
    const artifactText = appliedEntries.join('\n\n');
    if (CHRONICLE_ENTRY_FILE) {
      writeChronicleEntryArtifact(CHRONICLE_ENTRY_FILE, artifactText);
      console.log(`[编年史] 已写入 ${appliedEntries.length} 条新增 artifact: ${CHRONICLE_ENTRY_FILE}`);
    }
    fs.writeFileSync(CHRONICLE_FILE, content, 'utf-8');
    appliedEntries.forEach(entry => console.log(`[编年史] 已更新: ${entry.split('\n')[0]}`));
  } catch (err) {
    console.error('[编年史] 更新失败，已安全跳过，不写入残缺内容:', err.message);
  }
}

// ============ 发布到Hexo ============
function publishToHexo(report, dateStrCN, dateISO, newsItems) {
  const { postsDir, fileName, filePath } = getDailyPostPath(dateISO);
  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  const title = `AI行业日报 - ${dateStrCN}`;
  const normalizedReport = normalizeReport(report, title);
  const sourceList = buildSourceList(newsItems);

  const hexoContent = `---
title: ${title}
date: ${dateISO} 08:00:00
categories: [AI日报]
tags: [AI, 行业日报, 科技新闻]
---

${normalizedReport}${sourceList}
`;

  fs.writeFileSync(filePath, hexoContent, 'utf-8');
  console.log(`[发布] 已生成: ${fileName}`);
  return filePath;
}

// ============ 主流程 ============
async function main() {
  const { force } = parseRunMode();
  console.log('========================================');
  console.log('  AI行业日报生成器');
  console.log('  (仅生成；提交并推送后使用 npm run deploy 安全部署)');
  console.log('========================================\n');

  const dateISO = beijingDateISO();
  const dateStrCN = beijingDateCN();
  const { fileName, filePath } = getDailyPostPath(dateISO);

  if (!force && fs.existsSync(filePath)) {
    console.log(`[跳过] ${fileName} 已存在；传 --force 可重新生成。`);
    return;
  }
  if (force && fs.existsSync(filePath)) {
    console.log(`[force] ${fileName} 已存在，将重新生成并覆盖。`);
  }

  // 1. 抓取新闻
  console.log('[步骤1] 抓取AI新闻...\n');
  const newsItems = await fetchNews();
  console.log(`\n共获取 ${newsItems.length} 条新闻\n`);

  if (newsItems.length === 0) {
    console.error('今日无新闻，生成失败');
    process.exit(1);
  }

  // 2. 生成报告
  console.log('[步骤2] 生成行业报告（含质量评估+自动重试）...\n');
  const promptNewsItems = selectNewsForPrompt(newsItems)
    .filter(isAIRelevantItem);
  const coverage = validateSourceCoverage(promptNewsItems);
  if (!coverage.pass) {
    console.error(`素材覆盖不足: ${coverage.reason}`);
    process.exit(1);
  }
  if (coverage.reason !== '素材覆盖通过') {
    console.warn(`[素材覆盖警告] ${coverage.reason}`);
  }

  const report = await generateWithRetry(promptNewsItems);

  if (!report) {
    console.error('LLM 未返回内容，生成失败');
    process.exit(1);
  }

  // 3. 发布到Hexo
  console.log('\n[步骤3] 写入文章...\n');
  publishToHexo(report, dateStrCN, dateISO, promptNewsItems);

  // 4. 更新编年史
  console.log('\n[步骤4] 更新编年史...\n');
  await updateChronicle(newsItems);

  console.log('\n========================================');
  console.log('  日报生成完成！');
  console.log('  访问: https://hanxiaofan.site');
  console.log('========================================');
}

process.on('unhandledRejection', (reason) => {
  console.error('未处理的异常:', reason);
  process.exit(1);
});

main().then(() => process.exit(0)).catch(err => {
  console.error('错误:', err.stack || err.message || String(err));
  process.exit(1);
});
