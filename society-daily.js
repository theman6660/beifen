require('dotenv').config();
const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
const RSSHUB_URL = (process.env.RSSHUB_URL || '').trim().replace(/\/$/, '');

function toGitPath(filePath) {
  return path.relative(HEXO_DIR, filePath).replace(/\\/g, '/');
}

function getDailyPostPath(dateISO) {
  const postsDir = path.join(HEXO_DIR, 'source', '_posts');
  const fileName = `society-daily-${dateISO}.md`;
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
// 见 ./lib/date-utils.js（共享模块，与 ai-daily.js / apply-chronicle-entry.js 复用）

// ============ RSS源 ============
const DIRECT_SOURCES = [
  { url: 'https://sspai.com/feed', name: '少数派', lookbackDays: 1 },
  { url: 'https://www.ruanyifeng.com/blog/atom.xml', name: '阮一峰周刊', lookbackDays: 7 },
  { url: 'https://aeon.co/feed.xml', name: 'Aeon', lookbackDays: 7 },
  { url: 'https://longreads.com/feed/', name: 'Longreads', lookbackDays: 7 },
  { url: 'https://www.psypost.org/feed/', name: 'PsyPost', lookbackDays: 7 },
  { url: 'https://thesocietypages.org/feed/', name: 'The Society Pages', lookbackDays: 7 },
  { url: 'https://www.themarginalian.org/feed/', name: 'The Marginalian', lookbackDays: 7 },
  { url: 'https://theconversation.com/us/topics/social-sciences-184/articles.atom', name: 'The Conversation·Social Sciences', lookbackDays: 7 },
  { url: 'https://www.theguardian.com/society/rss', name: 'The Guardian·Society', lookbackDays: 3 },
];

const RSSHUB_SOURCES = [
  { path: '/thepaper/featured', name: '澎湃新闻·思想', lookbackDays: 3 },
  { path: '/neweekly/tag/社会', name: '新周刊', lookbackDays: 7 },
  { path: '/omnystudio/program/yixiang', name: '看理想', lookbackDays: 7 },
  { path: '/dandureading/article', name: '单读', lookbackDays: 7 },
  { path: '/shudan/book', name: '书单', lookbackDays: 7 },
  { path: '/zhihu/daily', name: '知乎日报', lookbackDays: 1 },
  { path: '/zhihu/hotlist', name: '知乎热榜', lookbackDays: 1 },
  { path: '/weibo/search/hot', name: '微博热搜', lookbackDays: 1 },
];

const CN_SOURCES = new Set([
  '少数派',
  '阮一峰周刊',
  ...RSSHUB_SOURCES.map(source => source.name),
]);

const SOURCE_IMPORTANCE_WEIGHTS = new Map([
  ['The Guardian·Society', 7],
  ['PsyPost', 7],
  ['The Conversation·Social Sciences', 7],
  ['Aeon', 6],
  ['The Marginalian', 6],
  ['The Society Pages', 6],
  ['Longreads', 5],
  ['澎湃新闻·思想', 5],
  ['新周刊', 4],
  ['看理想', 4],
  ['单读', 4],
  ['知乎热榜', 4],
  ['微博热搜', 4],
  ['少数派', 3],
  ['阮一峰周刊', 3],
  ['知乎日报', 3],
  ['书单', 2],
]);

const IMPORTANCE_SIGNALS = [
  { token: 'mental health', label: '心理健康', weight: 6 },
  { token: 'loneliness', label: '孤独', weight: 5 },
  { token: 'anxiety', label: '焦虑', weight: 5 },
  { token: 'relationship', label: '关系', weight: 4 },
  { token: 'family', label: '家庭', weight: 4 },
  { token: 'education', label: '教育', weight: 4 },
  { token: 'work', label: '工作', weight: 3 },
  { token: 'labor', label: '劳动', weight: 3 },
  { token: 'youth', label: '青年', weight: 4 },
  { token: 'gender', label: '性别', weight: 4 },
  { token: 'identity', label: '身份', weight: 4 },
  { token: 'trust', label: '信任', weight: 3 },
  { token: 'community', label: '共同体', weight: 3 },
  { token: '心理', label: '心理', weight: 5 },
  { token: '焦虑', label: '焦虑', weight: 5 },
  { token: '孤独', label: '孤独', weight: 5 },
  { token: '抑郁', label: '心理健康', weight: 5 },
  { token: '亲密关系', label: '亲密关系', weight: 5 },
  { token: '婚恋', label: '婚恋', weight: 4 },
  { token: '家庭', label: '家庭', weight: 4 },
  { token: '教育', label: '教育', weight: 4 },
  { token: '就业', label: '就业', weight: 4 },
  { token: '青年', label: '青年', weight: 4 },
  { token: '女性', label: '性别', weight: 4 },
  { token: '代际', label: '代际', weight: 4 },
  { token: '信任', label: '信任', weight: 3 },
  { token: '消费', label: '消费', weight: 3 },
  { token: '城市', label: '城市生活', weight: 3 },
  { token: '热搜', label: '公共情绪', weight: 3 },
  { token: '争议', label: '公共情绪', weight: 3 },
];

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
    const recencyScore = Math.max(0, 6 - ageHours / 10);
    const priorityScore = Math.round(sourceScore + signalScore + repeatedScore + recencyScore);
    const reasonParts = [
      labels.slice(0, 3).join('/'),
      repeatedSignals.length ? `多源信号:${repeatedSignals.slice(0, 2).join('/')}` : '',
      sourceScore >= 6 ? '高质量源' : '',
    ].filter(Boolean);

    return {
      ...item,
      _priorityScore: priorityScore,
      _priorityReason: reasonParts.join('，') || '时间较新/材料补充',
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

  const selected = selectWithSourceCap(internationalItems, Math.min(18, maxNews), 6, selectedKeys, selectedCounts);
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

function getAllSources() {
  const sources = [...DIRECT_SOURCES];
  if (RSSHUB_URL) {
    console.log(`[配置] RSSHub已启用: ${RSSHUB_URL}`);
    for (const s of RSSHUB_SOURCES) {
      sources.push({ url: `${RSSHUB_URL}${encodeURI(s.path)}`, name: s.name, lookbackDays: s.lookbackDays });
    }
  } else {
    console.log('[配置] RSSHub未配置，跳过RSSHub源（在.env中设置RSSHUB_URL启用）');
  }
  return sources;
}

// ============ RSS抓取 ============
async function fetchNews(targetDate) {
  const t = targetDate || beijingNow();
  const bjToday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));

  const sources = getAllSources();

  // 并行抓取所有源：每源 lookbackDays 不同，在各自 task 内计算 cutoff。
  // 失败源不应中断整体抓取。
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const lookbackDays = source.lookbackDays || 1;
      const cutoff = new Date(bjToday);
      cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
      console.log(`[抓取] ${source.name} (回溯${lookbackDays}天)...`);
      const feed = await parser.parseURL(source.url);

      const recentItems = (feed.items || [])
        .filter(item => {
          const dateStr = item.pubDate || item.isoDate;
          if (!dateStr) return false;
          const pubDate = new Date(dateStr);
          return !isNaN(pubDate.getTime()) && pubDate >= cutoff;
        })
        .map(item => ({
          title: item.title || '(无标题)',
          link: item.link || '',
          date: item.pubDate || item.isoDate,
          source: source.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 800),
          _timestamp: new Date(item.pubDate || item.isoDate).getTime(),
        }));

      console.log(`  -> ${source.name}：获取 ${recentItems.length} 条`);
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

// ============ 生成日报 ============
async function generateReport(newsItems) {
  const MAX_NEWS = PROMPT_NEWS_LIMIT;
  const truncated = newsItems.length > MAX_NEWS;
  if (truncated) {
    console.log(`[提示] 新闻共 ${newsItems.length} 条，取前 ${MAX_NEWS} 条用于生成`);
  }

  const newsText = newsItems.slice(0, MAX_NEWS).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   重要性线索: ${item._priorityReason || '材料覆盖'}\n   链接: ${item.link}\n   摘要: ${(item.snippet || '').slice(0, PROMPT_SNIPPET_CHARS)}`
  ).join('\n\n');

  const prompt = `你是一位兼具社会学家和精神分析师视角的信息观察者。你的任务是从近期新闻中，广泛捕捉这个时代的集体心理、社会关系和精神世界。

是透过事件看到人心的人。

核心目标：优先保证信息广度和信号覆盖。不要把日报写成一篇长论文；用短观察连接多个材料，让读者看到今天社会心理和生活现场的整体轮廓。

近期新闻源：
${newsText}

要求：
1. 不要输出文章总标题，标题会由 Hexo frontmatter 提供
2. 使用 Markdown 二级标题组织结构。以下板块按顺序输出：
   ## 今日关键词（固定输出）
   ## 今日信号（固定输出）
   ## 关系透视（有足够素材时输出）
   ## 心理地貌（有足够素材时输出）
   ## 生活现场（有足够素材时输出）
   ## 时代精神（有足够素材时输出）
   ## 时代回响（固定输出）
3. 各板块说明：
   - **今日关键词**：4-8个词或短语，一行一个，格式：\`- **关键词** — 一句话注解\`。勾勒今日情绪地图，不展开。
   - **今日信号**：选择5-10条值得知道的材料。每条格式：\`- **事件/现象**：一句话概述 + 一句话说明它折射的心理或社会关系。\`
   - **关系透视**：亲密关系、代际、信任/疏离、个体与群体。用短段落或项目符号覆盖多条信息。
   - **心理地貌**：焦虑、孤独、自我认同、防御机制、意义感。重点是抓到多种心理信号。
   - **生活现场**：消费、工作、教育、城市、家庭、娱乐、公共讨论等日常经验的变化。
   - **时代精神**：价值排序、生活理想、集体信念的形成或瓦解。不要过度理论化。
   - **时代回响**：3-6句话收束全文，把前文线索编织起来，给出一个有力但不冗长的观察。
4. 对每条分析，请遵循轻分析结构：
   （1）发生了什么
   （2）它折射了什么心理/社会关系
   （3）为什么值得继续看
5. 格式：
   - 板块之间不要使用 \`---\` 分割线。用自然段落过渡。
   - 使用项目符号和短段落，帮助快速扫读
   - 每个输出板块至少2处 **加粗关键句或关键词**
   - 不使用编号列表（1. 2. 3.）
6. 风格：
   - 像一个深夜和你聊天的朋友，聪明、真诚、不装
   - 像读弗洛姆或韩炳哲的书，但更口语化、更接地气
   - 不要学术腔，但要有思想深度
   - 敢于指出人们自欺的地方，但不居高临下
   - 信息密度要高，观点短而准，不要为追求深度把少数素材写得过长
7. 核心关注：
   - 人的心理：欲望、恐惧、防御机制、自我欺骗、身份焦虑、孤独感、亲密渴望
   - 社会关系：亲密与疏离、控制与依赖、表演与真实、信任崩塌与重建
   - 时代精神：这个时代的人在追求什么？在逃避什么？在集体性地遗忘什么？
8. 严格排除：不要写政治、国际关系、军事、外交、政党相关内容。只关注人的心理和社会关系。
9. 长度不作为硬目标。素材多可以写长，素材少就保持简洁；宁可覆盖更多社会心理信号，也不要为了凑字扩写。
10. 不要编造来源；不要输出参考来源列表，脚本会自动追加
11. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成社会思想日报...');
  const response = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response?.choices?.[0]?.message?.content;
  return content?.trim() || '';
}

async function checkQuality(report, dateStrCN) {
  const localResult = localQualityCheck(report);
  if (!localResult.pass) {
    console.log(`[质检] 本地硬检查失败: ${localResult.reason}`);
    return localResult;
  }

  const checkPrompt = `评估以下社会思想日报的质量。只需回复"PASS"或"FAIL: <原因>"。

检查标准：
1. 是否有"今日关键词"板块？是否包含至少4个关键词？
2. 是否有"今日信号"板块？是否覆盖至少5条材料或现象？
3. 是否有"时代回响"收尾板块？
4. 是否覆盖多个社会心理方向，而不是只围绕1-2条材料展开？
5. 是否避免了政治、国际关系、军事、外交内容？
6. 是否避免了参考来源列表、markdown代码块和 --- 分割线？
7. 字数长短、分析深度不作为失败理由；只在结构明显缺失、信息覆盖明显过窄或明显跑题时 FAIL。

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
  function extractSection(heading) {
    const lines = report.split(/\r?\n/);
    const headingPattern = new RegExp(`^##\\s+${heading}(?:\\s|：|:|$)`);
    const start = lines.findIndex(line => headingPattern.test(line));
    if (start === -1) return '';
    const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
    return lines.slice(start, next === -1 ? undefined : next).join('\n');
  }

  const plainText = report
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`[\]()!\-]/g, '')
    .replace(/\s+/g, '');
  const sectionCount = (report.match(/^##\s+/gm) || []).length;
  const keywordLineCount = (report.match(/^\s*-\s+\*\*.+?\*\*\s*[—-]/gm) || []).length;
  const signalSection = extractSection('今日信号');
  const signalLineCount = (signalSection.match(/^\s*-\s+\*\*.+?\*\*[：:]/gm) || []).length;

  if (plainText.length < 700) {
    return { pass: false, reason: `正文异常过短：${plainText.length} 字，可能生成不完整` };
  }

  if (sectionCount < 3) {
    return { pass: false, reason: `板块过少：${sectionCount} 个，少于 3 个` };
  }

  if (!/^##\s+今日关键词/m.test(report)) {
    return { pass: false, reason: '缺少今日关键词板块' };
  }

  if (!/^##\s+今日信号/m.test(report)) {
    return { pass: false, reason: '缺少今日信号板块' };
  }

  if (!/^##\s+时代回响/m.test(report)) {
    return { pass: false, reason: '缺少时代回响板块' };
  }

  if (keywordLineCount < 3) {
    return { pass: false, reason: `关键词过少：${keywordLineCount} 个，少于 3 个` };
  }

  if (signalLineCount < 4) {
    return { pass: false, reason: `今日信号过少：${signalLineCount} 条，少于 4 条` };
  }

  return { pass: true, reason: '本地硬检查通过' };
}

const SOURCE_COVERAGE_THRESHOLDS = {
  idealNewsItems: 10,
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
  return Math.min(plainText.length, 2200) + sectionCount * 500 + bulletCount * 80;
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

async function generateWithRetry(promptNewsItems, dateStrCN, maxRetries = 2) {
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

    const { pass, reason } = await checkQuality(report, dateStrCN);

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

// ============ 发布到Hexo ============
function publishToHexo(report, dateStrCN, dateISO, newsItems) {
  const { postsDir, fileName, filePath } = getDailyPostPath(dateISO);
  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  const title = `社会思想日报 - ${dateStrCN}`;
  const normalizedReport = normalizeReport(report, title);
  const sourceList = buildSourceList(newsItems);

  const frontMatter = `---
title: ${title}
date: ${dateISO} 08:30:00
categories: [社会日报]
tags: [社会心理, 精神分析, 时代精神]
---

`;

  fs.writeFileSync(filePath, frontMatter + normalizedReport + sourceList + '\n', 'utf-8');
  console.log(`[发布] 已写入: ${fileName}`);
  return filePath;
}

// ============ 参数解析 ============
function parseArgs() {
  const deploy = process.argv.includes('--deploy');
  const noDeploy = process.argv.includes('--no-deploy');
  const force = process.argv.includes('--force');
  if (deploy && noDeploy) {
    console.error('错误: --deploy 和 --no-deploy 不能同时使用');
    process.exit(1);
  }

  // 安全解析 --days-ago：找到标志后的值，校验为合法非负整数
  let daysAgo = 0;
  const daysAgoIdx = process.argv.indexOf('--days-ago');
  if (daysAgoIdx !== -1 && daysAgoIdx + 1 < process.argv.length) {
    const val = process.argv[daysAgoIdx + 1];
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 0 && String(num) === val) {
      daysAgo = num;
    } else {
      console.error(`错误: --days-ago 需要非负整数，收到: "${val}"`);
      process.exit(1);
    }
  }

  return { deploy, force, daysAgo };
}

// ============ 主流程 ============
async function main() {
  const { deploy, force, daysAgo } = parseArgs();
  const bjNow = beijingNow();
  const targetDate = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()));
  targetDate.setUTCDate(targetDate.getUTCDate() - daysAgo);

  const dateStrCN = beijingDateCN(targetDate);
  const dateISO = beijingDateISO(targetDate);
  const { fileName, filePath } = getDailyPostPath(dateISO);

  console.log('========================================');
  console.log('  社会思想日报生成器');
  if (!deploy) console.log('  (仅生成，不部署；如需本地部署请显式传 --deploy)');
  if (daysAgo > 0) console.log(`  生成日期: ${dateStrCN} (${daysAgo}天前)`);
  console.log('========================================\n');

  if (!force && fs.existsSync(filePath)) {
    console.log(`[跳过] ${fileName} 已存在；传 --force 可重新生成。`);
    return;
  }
  if (force && fs.existsSync(filePath)) {
    console.log(`[force] ${fileName} 已存在，将重新生成并覆盖。`);
  }

  console.log('[步骤1] 抓取社会新闻...');
  const newsItems = await fetchNews(targetDate);
  console.log(`\n共获取 ${newsItems.length} 条新闻\n`);

  if (newsItems.length === 0) {
    console.error('没有获取到新闻，生成失败');
    process.exit(1);
  }

  console.log('[步骤2] 生成社会思想日报（含质量评估+自动重试）...');
  const promptNewsItems = selectNewsForPrompt(newsItems);
  const coverage = validateSourceCoverage(promptNewsItems);
  if (!coverage.pass) {
    console.error(`素材覆盖不足: ${coverage.reason}`);
    process.exit(1);
  }
  if (coverage.reason !== '素材覆盖通过') {
    console.warn(`[素材覆盖警告] ${coverage.reason}`);
  }

  const report = await generateWithRetry(promptNewsItems, dateStrCN);

  if (!report) {
    console.error('LLM 未返回内容，生成失败');
    process.exit(1);
  }
  console.log(`\n--- 日报预览 ---\n${report.slice(0, 500)}...\n`);

  console.log('[步骤3] 写入文章...');
  const postFile = publishToHexo(report, dateStrCN, dateISO, promptNewsItems);

  if (deploy) {
    assertNoUnexpectedPostChanges([toGitPath(postFile)]);
    console.log('[步骤4] 部署网站...');
    const env = { ...process.env };
    if (PROXY_URL) {
      env.HTTP_PROXY = PROXY_URL;
      env.HTTPS_PROXY = PROXY_URL;
    }
    try {
      execSync('npx hexo clean && npx hexo generate && npx hexo deploy', {
        cwd: HEXO_DIR,
        stdio: 'inherit',
        env,
      });
      console.log('[部署] 完成！');
    } catch (err) {
      console.error('[部署] 失败:', err.message || String(err));
      process.exit(1);
    }
  }

  console.log('\n========================================');
  console.log('  完成！社会思想日报已发布');
  console.log(`  https://hanxiaofan.site`);
  console.log('========================================');
}

process.on('unhandledRejection', (reason) => {
  console.error('未处理的异常:', reason);
  process.exit(1);
});

main().then(() => process.exit(0)).catch(err => {
  console.error('运行失败:', err.stack || err.message || String(err));
  process.exit(1);
});
