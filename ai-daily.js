require('dotenv').config();
const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

const API_KEY = (process.env.AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || '').trim();
const BASE_URL = (process.env.BASE_URL || 'https://api.deepseek.com').trim();
const MODEL = (process.env.MODEL || 'deepseek-v4-pro').trim();
const RSS_TIMEOUT_MS = Number.parseInt(process.env.RSS_TIMEOUT_MS || '12000', 10) || 12000;
const PROMPT_NEWS_LIMIT = 40;
const PROMPT_SNIPPET_CHARS = 500;

let client;

function getClient() {
  if (!API_KEY) {
    console.error('错误: 环境变量 AUTH_TOKEN 或 DEEPSEEK_API_KEY 未设置');
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
  return { deploy, force };
}

function toGitPath(filePath) {
  return path.relative(HEXO_DIR, filePath).replace(/\\/g, '/');
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

function assertNoUnexpectedPostChanges(allowedRelPaths) {
  const allowed = new Set(allowedRelPaths.map(p => p.replace(/\\/g, '/')));
  const raw = execSync('git status --porcelain -z -- source/_posts', { cwd: HEXO_DIR });
  const entries = raw.toString('utf8').split('\0').filter(Boolean)
    .map(entry => ({ status: entry.slice(0, 2), file: entry.slice(3).replace(/\\/g, '/') }))
    .filter(entry => entry.file && !allowed.has(entry.file));

  if (entries.length > 0) {
    const details = entries.map(entry => `${entry.status} ${entry.file}`).join('\n');
    throw new Error(`拒绝本地部署：source/_posts 中存在非本次生成的本地变更。\n${details}`);
  }
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
  { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face Blog' },
  { url: 'https://stratechery.com/feed/', name: 'Stratechery', requireAIKeyword: true },
  { url: 'https://openai.com/news/rss.xml', name: 'OpenAI News' },
  { url: 'https://www.marktechpost.com/feed/', name: 'MarkTechPost' },
];

const RSS_SOURCES_CN = [
  { url: 'https://www.36kr.com/feed', name: '36氪', requireAIKeyword: true },
  { url: 'https://sspai.com/feed', name: '少数派', requireAIKeyword: true },
  { url: 'https://www.qbitai.com/feed', name: '量子位' },
];

const CN_SOURCES = new Set(RSS_SOURCES_CN.map(source => source.name));

const SOURCE_IMPORTANCE_WEIGHTS = new Map([
  ['OpenAI News', 9],
  ['MIT Tech Review', 7],
  ['Stratechery', 7],
  ['TechCrunch', 6],
  ['The Verge', 6],
  ['VentureBeat', 5],
  ['Ars Technica', 5],
  ['Hugging Face Blog', 5],
  ['量子位', 5],
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
  'ai agent',
  'aigc',
  '人工智能',
  '生成式',
  '大模型',
  '语言模型',
  '多模态',
  '智能体',
  '机器人',
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
  { token: 'openai', label: 'OpenAI', weight: 8 },
  { token: 'anthropic', label: 'Anthropic', weight: 7 },
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

      const recentItems = relevantItems
        .map(item => ({
          title: item.title || '(无标题)',
          link: item.link || '',
          date: item.pubDate || item.isoDate,
          source: source.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 800),
          _timestamp: new Date(item.pubDate || item.isoDate).getTime(),
        }));

      const filteredOut = datedItems.length - relevantItems.length;
      console.log(`  -> ${source.name}：获取 ${recentItems.length} 条${filteredOut > 0 ? `，过滤 ${filteredOut} 条非AI素材` : ''}`);
      return recentItems;
    })
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

  allItems.sort((a, b) => {
    const ta = a._timestamp;
    const tb = b._timestamp;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });
  return rankNewsItems(allItems);
}

// ============ LLM生成报告 ============
async function generateReport(newsItems) {
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();
  const MAX_NEWS = PROMPT_NEWS_LIMIT;

  if (newsItems.length > MAX_NEWS) {
    console.log(`[提示] 新闻共 ${newsItems.length} 条，取前 ${MAX_NEWS} 条用于生成`);
  }

  const newsText = newsItems.slice(0, MAX_NEWS).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   重要性线索: ${item._priorityReason || '来源覆盖'}\n   链接: ${item.link}\n   摘要: ${(item.snippet || '').slice(0, PROMPT_SNIPPET_CHARS)}`
  ).join('\n\n');

  const prompt = `你是资深AI行业信息编辑和分析师。根据以下近期AI新闻，生成一份中文行业日报。

核心目标：让读者尽可能广地掌握今日AI行业信息版图。优先覆盖重要信息、不同来源、不同主题；深度分析点到为止，不为了显得深而展开长文。

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
     **信息**：1-2句话概述。
     **看点**：1-2句话说明重要性或后续影响。
     不要写成长篇专题，每条重点信号之间用 \`---\` 分隔线隔开。
   - 行业动态：竞争格局、巨头动作、市场趋势。用短段落或项目符号覆盖多条信息，不要求每条长分析。
   - 技术进展：模型、开源、论文、基准、工具链、硬件。优先多覆盖，不必逐条深入。
   - 商业动态：融资、IPO、收购、产品发布、客户落地。优先覆盖信息面。
   - 政策与监管：全球AI监管政策、合规动态、版权/安全争议。素材不足则跳过。
   - **观察备忘**：用3-6条短判断收束今天的信息格局，指出接下来值得继续观察的方向。
4. 格式要求：
   - 使用项目符号和短段落，帮助快速扫读
   - 每个输出板块至少2处 **加粗关键句或关键词**
   - 不使用编号列表（1. 2. 3.）
5. 风格：信息密度高、专业但不端着。像一份清醒的行业雷达，不像长篇论文。
6. 长度不作为硬目标。素材多可以写长，素材少就保持简洁；宁可覆盖更多重要信息，也不要为了凑字扩写。
7. 不要编造来源；不要输出参考来源列表，脚本会自动追加
8. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成AI行业日报...');
  const response = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 9000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response?.choices?.[0]?.message?.content;
  return content?.trim() || '';
}

async function checkQuality(report) {
  const localResult = localQualityCheck(report);
  if (!localResult.pass) {
    console.log(`[质检] 本地硬检查失败: ${localResult.reason}`);
    return localResult;
  }

  const checkPrompt = `评估以下AI行业日报的质量。只需回复"PASS"或"FAIL: <原因>"。

检查标准：
1. 是否有"今日速览"板块？速览是否包含至少5条要点？
2. 是否有"重点信号"板块？重点信号是否使用 **信息**/**看点** 结构？
3. 是否覆盖多个主题方向，而不是只围绕1-2条新闻展开？
4. 是否避免编造来源、参考来源列表、markdown代码块？
5. 字数长短、分析深度不作为失败理由；只在结构明显缺失或信息覆盖明显过窄时 FAIL。

文章内容：
${report.slice(0, 4000)}`;

  try {
    console.log('[质检] 评估生成质量...');
    const response = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: checkPrompt }],
    });

    const result = response?.choices?.[0]?.message?.content?.trim() || '';
    console.log(`[质检] 结果: ${result}`);
    if (!result) {
      console.log('[质检] 模型返回空内容，默认通过');
      return { pass: true, reason: '模型返回空，默认通过' };
    }
    return { pass: result.startsWith('PASS'), reason: result };
  } catch (err) {
    console.log(`[质检] 评估失败，默认通过: ${err.message}`);
    return { pass: true, reason: '质检异常，跳过' };
  }
}

function localQualityCheck(report) {
  const plainText = report
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`[\]()!\-]/g, '')
    .replace(/\s+/g, '');
  const sectionCount = (report.match(/^##\s+/gm) || []).length;
  const overviewLineCount = (report.match(/^\s*-\s+\*\*.+?\*\*[：:]/gm) || []).length;

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

function scoreReport(report) {
  const plainText = report
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`[\]()!\-]/g, '')
    .replace(/\s+/g, '');
  const sectionCount = (report.match(/^##\s+/gm) || []).length;
  const bulletCount = (report.match(/^\s*[-*]\s+/gm) || []).length;
  return Math.min(plainText.length, 2500) + sectionCount * 500 + bulletCount * 80;
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
  let bestReport = '';
  let bestScore = 0;

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

    const { pass, reason } = await checkQuality(report);

    if (pass) {
      console.log('[质检] 通过！');
      return report;
    }

    console.log(`[质检] 未通过: ${reason}`);
    const score = scoreReport(report);
    if (score > bestScore) {
      bestScore = score;
      bestReport = report;
    }
  }

  console.log('[质检] 所有重试未通过，返回评分最高的结果');
  return bestReport || '';
}

function normalizeReport(report, title) {
  return report
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === title))
    .join('\n')
    .trim();
}

function buildSourceList(newsItems, maxSources = 30) {
  const seen = new Set();
  const sources = [];
  for (const item of newsItems) {
    if (!item.link) continue;
    const key = `${item.title}|${item.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(`- [${item.source}] [${item.title}](${item.link})`);
    if (sources.length >= maxSources) break;
  }

  if (sources.length === 0) return '';
  return `\n\n## 参考来源\n\n${sources.join('\n')}`;
}

// ============ 编年史更新 ============
async function updateChronicle(newsItems) {
  const { year, month } = getBeijingDateParts();
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();

  let existingChronicle = '';
  if (fs.existsSync(CHRONICLE_FILE)) {
    existingChronicle = fs.readFileSync(CHRONICLE_FILE, 'utf-8');
  }

  const newsText = newsItems.slice(0, 20).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}${item.snippet ? `\n   摘要: ${item.snippet.slice(0, 200)}` : ''}`
  ).join('\n\n');

  const prompt = `判断以下AI行业新闻中，是否有值得记录到编年史的重大事件。

今日新闻（含来源和摘要用于交叉验证）：
${newsText}

记录标准（必须同时满足）：
1. 技术上有质的飞跃（不是渐进改进）
2. 对社会或行业有深远影响

注意：
- 利用摘要和来源判断事件的真实性和重要性，忽略标题党
- 排除：常规产品更新、小版本迭代、融资传闻、未证实的推测
- 同一事件被多个来源报道时只记录一次

如果没有符合条件的事件，只输出：无更新

如果有，输出格式：
- **${dateStrCN}**：事件描述
  - **意义**：社会/思想影响（2-3句）

注意：输出中不要包含任何以 ## 或 ### 开头的行（Markdown标题格式），这会破坏文档结构。
直接输出，不要解释。`;

  try {
    console.log('[编年史] 分析今日新闻...');
    const response = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response?.choices?.[0]?.message?.content?.trim() || '';
    console.log(`[编年史] 结果: "${rawText.slice(0, 200)}"`);

    if (rawText.includes('无更新') || !rawText) {
      console.log('[编年史] 今日无重大事件，不更新');
      return;
    }

    const result = insertChronicleEntry(existingChronicle, rawText, {
      year,
      month,
      dateISO,
      dateStrCN,
    });

    if (!result.updated && result.reason === 'date-exists-merge-failed') {
      console.log('[编年史] 同日合并失败，跳过');
      return;
    }

    if (!result.updated) {
      console.log(`[编年史] 未产生可写入条目: ${result.reason}`);
      return;
    }

    if (result.reason === 'appended-to-date') {
      console.log('[编年史] 同日已有条目，追加合并');
    }

    if (CHRONICLE_ENTRY_FILE) {
      writeChronicleEntryArtifact(CHRONICLE_ENTRY_FILE, result.entryText);
      console.log(`[编年史] 已写入新增条目 artifact: ${CHRONICLE_ENTRY_FILE}`);
    }

    fs.writeFileSync(CHRONICLE_FILE, result.content, 'utf-8');
    console.log(`[编年史] 已更新: ${result.entryText.split('\n')[0]}`);
  } catch (err) {
    console.error('[编年史] 更新失败:', err.message);
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
  const { deploy, force } = parseRunMode();
  console.log('========================================');
  console.log('  AI行业日报生成器');
  if (!deploy) console.log('  (仅生成，不部署；如需本地部署请显式传 --deploy)');
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
  const postFile = publishToHexo(report, dateStrCN, dateISO, promptNewsItems);

  // 4. 更新编年史
  console.log('\n[步骤4] 更新编年史...\n');
  await updateChronicle(newsItems);

  // 5. 部署
  if (deploy) {
    assertNoUnexpectedPostChanges([toGitPath(postFile), toGitPath(CHRONICLE_FILE)]);
    console.log('\n[步骤5] 部署网站...\n');
    const env = { ...process.env };
    if (PROXY_URL) {
      env.HTTP_PROXY = PROXY_URL;
      env.HTTPS_PROXY = PROXY_URL;
    }
    try {
      execSync('npx hexo clean && npx hexo generate && npx hexo deploy', {
        cwd: HEXO_DIR,
        env,
        stdio: 'inherit',
      });
      console.log('[部署] 完成！');
    } catch (err) {
      console.error('[部署] 失败:', err.message || String(err));
      process.exit(1);
    }
  }

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
