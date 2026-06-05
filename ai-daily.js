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
});

const HEXO_DIR = process.env.HEXO_DIR || '.';
const CHRONICLE_FILE = path.join(HEXO_DIR, 'source', '_posts', 'ai-chronicle.md');

// ============ 北京时间工具函数 ============
function beijingNow() {
  const now = new Date();
  // UTC+8
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function getBeijingDateParts(d = beijingNow()) {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function beijingDateISO(d = beijingNow()) {
  const p = getBeijingDateParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function beijingDateCN(d = beijingNow()) {
  const p = getBeijingDateParts(d);
  return `${p.year}年${p.month}月${p.day}日`;
}

// AI新闻RSS源
const RSS_SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', name: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica' },
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT Tech Review' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat' },
  { url: 'https://9to5google.com/feed/', name: '9to5Google' },
];

const RSS_SOURCES_CN = [
  { url: 'https://www.36kr.com/feed', name: '36氪' },
  { url: 'https://sspai.com/feed', name: '少数派' },
];

const CN_SOURCES = new Set(RSS_SOURCES_CN.map(source => source.name));

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

  const selected = selectWithSourceCap(internationalItems, Math.min(18, maxNews), 5, selectedKeys);
  selected.push(...selectWithSourceCap(cnItems, maxNews - selected.length, 4, selectedKeys));

  if (selected.length < maxNews) {
    selected.push(...selectWithSourceCap(newsItems, maxNews - selected.length, 5, selectedKeys));
  }

  selected.sort((a, b) => b._timestamp - a._timestamp);
  console.log(`[取样] 用于生成: ${selected.length} 条（国际 ${selected.filter(item => !CN_SOURCES.has(item.source)).length}，中文 ${selected.filter(item => CN_SOURCES.has(item.source)).length}）`);
  return selected.slice(0, maxNews);
}

// ============ RSS抓取 ============
async function fetchNews() {
  const bj = beijingNow();
  const todayBeijing = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  const yesterday = new Date(todayBeijing);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const allItems = [];
  const sources = [...RSS_SOURCES, ...RSS_SOURCES_CN];

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
      console.log(`  -> ${source.name} 抓取失败: ${err.message}`);
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

// ============ LLM生成报告 ============
async function generateReport(newsItems) {
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();
  const MAX_NEWS = 30;

  if (newsItems.length > MAX_NEWS) {
    console.log(`[提示] 新闻共 ${newsItems.length} 条，取前 ${MAX_NEWS} 条用于生成`);
  }

  const newsText = newsItems.slice(0, MAX_NEWS).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   链接: ${item.link}\n   摘要: ${item.snippet}`
  ).join('\n\n');

  const prompt = `你是AI行业分析师。根据以下今日AI新闻，生成一份中文行业日报。

今日新闻源：
${newsText}

要求：
1. 不要输出文章总标题，标题会由 Hexo frontmatter 提供
2. 使用 Markdown 二级标题组织结构，例如：
   ## 今日要闻
   ### 1. 重要新闻标题
   ## 行业动态
   ## 技术进展
   ## 商业动态
   ## 政策与监管
   ## 影响分析
3. 今日要闻选择最重要的2-3条新闻并详细分析
4. 风格：专业但易懂，有深度分析，不是简单罗列
5. 如果某个分类没有相关新闻，跳过该分类
6. 总字数控制在1500-2500字
7. 不要编造来源；不要输出参考来源列表，脚本会自动追加
8. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成AI行业日报...');
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

// ============ 编年史更新 ============
async function updateChronicle(newsItems) {
  const { year, month, day } = getBeijingDateParts();
  const dateStrCN = beijingDateCN();
  const dateISO = beijingDateISO();

  let existingChronicle = '';
  if (fs.existsSync(CHRONICLE_FILE)) {
    existingChronicle = fs.readFileSync(CHRONICLE_FILE, 'utf-8');
  }

  if (!existingChronicle) {
    existingChronicle = `---
title: AI编年史：从图灵到此刻
date: ${dateISO} 08:00:00
categories: [AI编年史]
tags: [编年史, 时间线, AI]
---

# AI编年史：从图灵到此刻

> 这是一份持续更新的AI发展编年史。它不记录每一天的新闻，只记录那些真正改变游戏规则的时刻——技术的突破、思想的碰撞、社会的转折。

---

## ${year}年

### ${month}月

`;
  }

  const newsText = newsItems.slice(0, 20).map((item, i) =>
    `${i + 1}. ${item.title}`
  ).join('\n');

  const prompt = `判断以下AI行业新闻中，是否有值得记录到编年史的重大事件。

今日新闻标题：
${newsText}

记录标准（必须同时满足）：
1. 技术上有质的飞跃（不是渐进改进）
2. 对社会或行业有深远影响

如果没有符合条件的事件，只输出：无更新

如果有，输出格式：
- **${dateStrCN}**：事件描述
  - **为什么重要**：社会/思想影响（2-3句）

注意：输出中不要包含任何以 ## 或 ### 开头的行（Markdown标题格式），这会破坏文档结构。
直接输出，不要解释。`;

  try {
    console.log('[编年史] 分析今日新闻...');
    const response = await client.chat.completions.create({
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

    // 清理LLM输出中的Markdown标题，防止破坏文档结构
    const resultText = rawText
      .replace(/^## /gm, '**##** ')
      .replace(/^### /gm, '**###** ');

    // 检查今天是否已有条目（防止重复）
    const todayMarker = `**${dateStrCN}**`;
    if (existingChronicle.includes(todayMarker)) {
      console.log('[编年史] 今日已有条目，跳过');
      return;
    }

    // 在编年史中插入新条目
    const monthHeader = `### ${month}月`;
    const yearHeader = `## ${year}年`;
    const yearIndex = existingChronicle.indexOf(yearHeader);

    let yearSectionEnd = existingChronicle.length;
    if (yearIndex !== -1) {
      const afterYearHdr = yearIndex + yearHeader.length;
      const nextYearMatch = existingChronicle.slice(afterYearHdr).match(/\n## \d{4}年/);
      if (nextYearMatch) yearSectionEnd = afterYearHdr + nextYearMatch.index;
    }

    let updatedChronicle;

    if (yearIndex !== -1 && existingChronicle.slice(yearIndex, yearSectionEnd).includes(monthHeader)) {
      // 当月 section 已存在：插在当月已有内容之后、下一个月/年之前
      const monthIndexInYear = existingChronicle.indexOf(monthHeader, yearIndex);
      const afterMonth = monthIndexInYear + monthHeader.length;
      const nextBoundary = existingChronicle.slice(afterMonth).search(/\n(?:## \d{4}年|### \d{1,2}月)/);
      const insertPoint = nextBoundary === -1 ? yearSectionEnd : afterMonth + nextBoundary;

      updatedChronicle = existingChronicle.slice(0, insertPoint) + '\n' + resultText + '\n' + existingChronicle.slice(insertPoint);
    } else if (yearIndex !== -1) {
      // 当月 section 不存在：按月份顺序插入
      const yearSection = existingChronicle.slice(yearIndex, yearSectionEnd);
      const monthRegex = /### (\d+)月/g;
      let insertAfter = yearIndex + yearHeader.length;
      let m;
      while ((m = monthRegex.exec(yearSection)) !== null) {
        const existingMonth = parseInt(m[1], 10);
        if (existingMonth < month) {
          const absPos = yearIndex + m.index;
          const afterExistingMonth = absPos + m[0].length;
          const nextBoundary = existingChronicle.slice(afterExistingMonth).search(/\n(?:## \d{4}年|### \d{1,2}月)/);
          const secEnd = nextBoundary === -1 ? yearSectionEnd : afterExistingMonth + nextBoundary;
          insertAfter = secEnd;
        }
      }
      updatedChronicle = existingChronicle.slice(0, insertAfter) + '\n\n' + monthHeader + '\n' + resultText + '\n' + existingChronicle.slice(insertAfter);
    } else {
      // 今年 section 不存在
      const firstYearMatch = existingChronicle.match(/\n## \d{4}年/);
      if (firstYearMatch) {
        const insertAt = existingChronicle.indexOf(firstYearMatch[0]);
        updatedChronicle = existingChronicle.slice(0, insertAt) + '\n\n## ' + year + '年\n\n' + monthHeader + '\n' + resultText + '\n' + existingChronicle.slice(insertAt);
      } else {
        updatedChronicle = existingChronicle + '\n## ' + year + '年\n\n' + monthHeader + '\n' + resultText + '\n';
      }
    }

    // 只在 frontmatter 中更新日期
    updatedChronicle = updatedChronicle.replace(
      /^(---[\s\S]*?^date: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m,
      `$1${dateISO} 08:00:00`
    );

    fs.writeFileSync(CHRONICLE_FILE, updatedChronicle, 'utf-8');
    console.log(`[编年史] 已更新: ${resultText.split('\n')[0]}`);
  } catch (err) {
    console.error('[编年史] 更新失败:', err.message);
  }
}

// ============ 发布到Hexo ============
function publishToHexo(report, dateStrCN, dateISO, newsItems, noDeploy = false) {
  const postsDir = path.join(HEXO_DIR, 'source', '_posts');
  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  // 使用 ISO 日期做文件名，避免中文 URL 编码
  const fileName = `ai-daily-${dateISO}.md`;
  const filePath = path.join(postsDir, fileName);

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
}

// ============ 主流程 ============
async function main() {
  const noDeploy = process.argv.includes('--no-deploy');
  console.log('========================================');
  console.log('  AI行业日报生成器');
  if (noDeploy) console.log('  (仅生成，不部署)');
  console.log('========================================\n');

  const dateISO = beijingDateISO();
  const dateStrCN = beijingDateCN();

  // 1. 抓取新闻
  console.log('[步骤1] 抓取AI新闻...\n');
  const newsItems = await fetchNews();
  console.log(`\n共获取 ${newsItems.length} 条新闻\n`);

  if (newsItems.length === 0) {
    console.log('今日无新闻，跳过生成');
    return;
  }

  // 2. 生成报告
  console.log('[步骤2] 生成行业报告...\n');
  const promptNewsItems = selectNewsForPrompt(newsItems);
  const report = await generateReport(promptNewsItems);

  if (!report) {
    console.log('[跳过] LLM 未返回内容');
    return;
  }

  // 3. 发布到Hexo
  console.log('\n[步骤3] 写入文章...\n');
  publishToHexo(report, dateStrCN, dateISO, promptNewsItems, noDeploy);

  // 4. 更新编年史
  console.log('\n[步骤4] 更新编年史...\n');
  await updateChronicle(newsItems);

  // 5. 部署
  if (!noDeploy) {
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

main().catch(err => {
  console.error('错误:', err.stack || err.message || String(err));
  process.exit(1);
});
