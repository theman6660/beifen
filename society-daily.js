require('dotenv').config();
const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

if (!API_KEY) {
  console.error('错误: 环境变量 AUTH_TOKEN 或 DEEPSEEK_API_KEY 未设置');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  timeout: 180000,
  maxRetries: 2,
});

const parser = new RSSParser({
  requestOptions: proxyAgent ? { agent: proxyAgent } : {},
  timeout: 12000,
});

const HEXO_DIR = process.env.HEXO_DIR || '.';
const RSSHUB_URL = (process.env.RSSHUB_URL || '').trim().replace(/\/$/, '');

// ============ 北京时间工具函数 ============
function beijingNow() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function beijingDateParts(d) {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function beijingDateISO(d) {
  const p = beijingDateParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function beijingDateCN(d) {
  const p = beijingDateParts(d);
  return `${p.year}年${p.month}月${p.day}日`;
}

// ============ RSS源 ============
const DIRECT_SOURCES = [
  { url: 'https://sspai.com/feed', name: '少数派' },
  { url: 'https://www.ruanyifeng.com/blog/atom.xml', name: '阮一峰周刊' },
  { url: 'https://aeon.co/feed.xml', name: 'Aeon' },
  { url: 'https://longreads.com/feed/', name: 'Longreads' },
];

const RSSHUB_SOURCES = [
  { path: '/thepaper/featured', name: '澎湃新闻·思想' },
  { path: '/neweekly/tag/社会', name: '新周刊' },
  { path: '/omnystudio/program/yixiang', name: '看理想' },
  { path: '/dandureading/article', name: '单读' },
  { path: '/shudan/book', name: '书单' },
  { path: '/zhihu/daily', name: '知乎日报' },
  { path: '/zhihu/hotlist', name: '知乎热榜' },
  { path: '/weibo/search/hot', name: '微博热搜' },
];

const CN_SOURCES = new Set([
  '少数派',
  '阮一峰周刊',
  ...RSSHUB_SOURCES.map(source => source.name),
]);

function selectWithSourceCap(items, limit, maxPerSource, exclude = new Set()) {
  const counts = new Map();
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

function selectNewsForPrompt(newsItems, maxNews = 30) {
  const internationalItems = newsItems.filter(item => !CN_SOURCES.has(item.source));
  const cnItems = newsItems.filter(item => CN_SOURCES.has(item.source));
  const selectedKeys = new Set();

  const selected = selectWithSourceCap(internationalItems, Math.min(12, maxNews), 5, selectedKeys);
  selected.push(...selectWithSourceCap(cnItems, maxNews - selected.length, 4, selectedKeys));

  if (selected.length < maxNews) {
    selected.push(...selectWithSourceCap(newsItems, maxNews - selected.length, 5, selectedKeys));
  }

  selected.sort((a, b) => b._timestamp - a._timestamp);
  console.log(`[取样] 用于生成: ${selected.length} 条（国际 ${selected.filter(item => !CN_SOURCES.has(item.source)).length}，中文 ${selected.filter(item => CN_SOURCES.has(item.source)).length}）`);
  return selected.slice(0, maxNews);
}

function getAllSources() {
  const sources = [...DIRECT_SOURCES];
  if (RSSHUB_URL) {
    console.log(`[配置] RSSHub已启用: ${RSSHUB_URL}`);
    for (const s of RSSHUB_SOURCES) {
      sources.push({ url: `${RSSHUB_URL}${s.path}`, name: s.name });
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
  const yesterday = new Date(bjToday);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const allItems = [];
  const sources = getAllSources();

  for (const source of sources) {
    try {
      console.log(`[抓取] ${source.name}...`);
      const feed = await parser.parseURL(source.url);

      const recentItems = (feed.items || [])
        .filter(item => {
          const dateStr = item.pubDate || item.isoDate;
          if (!dateStr) return false;
          const pubDate = new Date(dateStr);
          return !isNaN(pubDate.getTime()) && pubDate >= yesterday;
        })
        .map(item => ({
          title: item.title || '(无标题)',
          link: item.link || '',
          date: item.pubDate || item.isoDate,
          source: source.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 300),
          _timestamp: new Date(item.pubDate || item.isoDate).getTime(),
        }));

      allItems.push(...recentItems);
      console.log(`  -> 获取 ${recentItems.length} 条`);
    } catch (err) {
      console.log(`  -> ${source.name} 抓取失败: ${err.message || String(err)}`);
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
  return allItems;
}

// ============ 生成日报 ============
async function generateReport(newsItems, dateStr) {
  const MAX_NEWS = 30;
  const truncated = newsItems.length > MAX_NEWS;
  if (truncated) {
    console.log(`[提示] 新闻共 ${newsItems.length} 条，取前 ${MAX_NEWS} 条用于生成`);
  }

  const newsText = newsItems.slice(0, MAX_NEWS).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   链接: ${item.link}\n   摘要: ${item.snippet}`
  ).join('\n\n');

  const prompt = `你是一位兼具社会学家和精神分析师视角的观察者。你的任务是从今日新闻中，挖掘这个时代的集体心理、人际关系的深层结构、以及人们不愿说出口的真实欲望和恐惧。

你不是记者，不报道事件本身。你是透过事件看到人心的人。

今日新闻源：
${newsText}

要求：
1. 不要输出文章总标题，标题会由 Hexo frontmatter 提供
2. 使用 Markdown 二级标题组织结构，例如：
   ## 时代切片
   ## 关系透视
   ## 心理地貌
   ## 时代精神
   ## 一面镜子
3. 结构（按优先级排列）：
   - 时代切片（1-2条新闻，重点不是事件本身，而是它们揭示了什么样的集体心理。比如：一个消费现象背后是怎样的身份焦虑？一个文化潮流背后是怎样的存在性需求？）
   - 关系透视（社会关系的变化：亲密关系的形态、代际之间的张力、个体与群体的博弈、人与人之间的信任/疏离模式）
   - 心理地貌（这个时代人们普遍的心理状态：焦虑的来源、逃避的方式、自我认同的困境、意义感的缺失或重建）
   - 时代精神（正在形成或瓦解的集体信念、价值排序的位移、"什么是好的生活"的定义正在如何被改写）
   - 一面镜子（一个问题或观察，让读者停下来想一想自己：你是否也在这个模式里？你真正想要的是什么？）
4. 风格：
   - 像一个深夜和你聊天的朋友，聪明、真诚、不装
   - 像读弗洛姆或韩炳哲的书，但更口语化、更接地气
   - 不要学术腔，但要有思想深度
   - 敢于指出人们自欺的地方，但不居高临下
5. 核心关注：
   - 人的心理：欲望、恐惧、防御机制、自我欺骗、身份焦虑、孤独感、亲密渴望
   - 社会关系：亲密与疏离、控制与依赖、表演与真实、信任崩塌与重建
   - 时代精神：这个时代的人在追求什么？在逃避什么？在集体性地遗忘什么？
6. 严格排除：不要写政治、国际关系、军事、外交、政党相关内容。只关注人的心理和社会关系。
7. 如果某个分类没有相关内容，跳过该分类
8. 总字数控制在1200-1800字
9. 不要编造来源；不要输出参考来源列表，脚本会自动追加
10. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成社会思想日报...');
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response?.choices?.[0]?.message?.content;
  return content?.trim() || '';
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

function buildSourceList(newsItems, maxSources = 20) {
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
  const postsDir = path.join(HEXO_DIR, 'source', '_posts');
  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  // 使用 ISO 日期做文件名，避免中文 URL 编码
  const fileName = `society-daily-${dateISO}.md`;
  const filePath = path.join(postsDir, fileName);

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
}

// ============ 参数解析 ============
function parseArgs() {
  const noDeploy = process.argv.includes('--no-deploy');

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

  return { noDeploy, daysAgo };
}

// ============ 主流程 ============
async function main() {
  const { noDeploy, daysAgo } = parseArgs();
  const bjNow = beijingNow();
  const targetDate = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()));
  targetDate.setUTCDate(targetDate.getUTCDate() - daysAgo);

  const dateStrCN = beijingDateCN(targetDate);
  const dateISO = beijingDateISO(targetDate);

  console.log('========================================');
  console.log('  社会思想日报生成器');
  if (daysAgo > 0) console.log(`  生成日期: ${dateStrCN} (${daysAgo}天前)`);
  console.log('========================================\n');

  console.log('[步骤1] 抓取社会新闻...');
  const newsItems = await fetchNews(targetDate);
  console.log(`\n共获取 ${newsItems.length} 条新闻\n`);

  if (newsItems.length === 0) {
    console.log('没有获取到新闻，退出');
    return;
  }

  console.log('[步骤2] 生成社会思想日报...');
  const promptNewsItems = selectNewsForPrompt(newsItems);
  const report = await generateReport(promptNewsItems, dateStrCN);

  if (!report) {
    console.log('LLM未返回内容，退出');
    return;
  }
  console.log(`\n--- 日报预览 ---\n${report.slice(0, 500)}...\n`);

  console.log('[步骤3] 写入文章...');
  publishToHexo(report, dateStrCN, dateISO, promptNewsItems);

  if (!noDeploy) {
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

main().catch(err => {
  console.error('运行失败:', err.stack || err.message || String(err));
  process.exit(1);
});
