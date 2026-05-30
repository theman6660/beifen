require('dotenv').config();
const OpenAI = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ 配置 ============
const PROXY_URL = process.env.PROXY_URL;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

const client = new OpenAI({
  apiKey: process.env.AUTH_TOKEN,
  baseURL: process.env.BASE_URL,
});

const parser = new RSSParser({
  requestOptions: proxyAgent ? { agent: proxyAgent } : {},
});

const HEXO_DIR = process.env.HEXO_DIR || '.';
const CHRONICLE_FILE = path.join(HEXO_DIR, 'source', '_posts', 'ai-chronicle.md');

// AI新闻RSS源
const RSS_SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', name: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica' },
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT Tech Review' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat' },
  { url: 'https://9to5google.com/feed/', name: '9to5Google' },
];

// 中文AI新闻源
const RSS_SOURCES_CN = [
  { url: 'https://www.36kr.com/feed', name: '36氪' },
  { url: 'https://sspai.com/feed', name: '少数派' },
];

// ============ RSS抓取 ============
async function fetchNews() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

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
          title: item.title,
          link: item.link,
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

  // 按时间排序，最新的在前；无效日期的放末尾
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
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  const newsText = newsItems.map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   链接: ${item.link}\n   摘要: ${item.snippet}`
  ).join('\n\n');

  const prompt = `你是AI行业分析师。根据以下今日AI新闻，生成一份中文行业日报。

今日新闻源：
${newsText}

要求：
1. 标题：AI行业日报 - ${dateStr}
2. 结构：
   - 今日要闻（最重要的2-3条新闻，详细分析）
   - 行业动态（其他值得关注的新闻，简要概述）
   - 技术进展（新技术、新模型、新论文）
   - 商业动态（融资、收购、产品发布）
   - 政策与监管（相关政策变化）
   - 影响分析（这些变化对行业、就业、社会的影响）
3. 风格：专业但易懂，有深度分析，不是简单罗列
4. 如果某个分类没有相关新闻，跳过该分类
5. 总字数控制在1500-2500字
6. 直接输出文章内容，不要加markdown代码块标记`;

  const response = await client.chat.completions.create({
    model: process.env.MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.choices[0].message.content || '';
}

// ============ 编年史更新 ============
async function updateChronicle(newsItems) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const dateISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 读取现有编年史
  let existingChronicle = '';
  if (fs.existsSync(CHRONICLE_FILE)) {
    existingChronicle = fs.readFileSync(CHRONICLE_FILE, 'utf-8');
  }

  // 如果编年史不存在，创建初始结构
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

## ${today.getFullYear()}年

### ${today.getMonth() + 1}月

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
### ${today.getMonth() + 1}月
- **${dateStr}**：事件描述
  - **为什么重要**：社会/思想影响（2-3句）

直接输出，不要解释。`;

  try {
    console.log('[编年史] 分析今日新闻...');
    const response = await client.chat.completions.create({
      model: process.env.MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const resultText = response.choices[0].message.content?.trim() || '';
    console.log(`[编年史] 最终结果: "${resultText.slice(0, 200)}"`);

    if (resultText.includes('无更新') || !resultText) {
      console.log('[编年史] 今日无重大事件，不更新');
      return;
    }

    // 在编年史的适当位置插入新条目
    const monthHeader = `### ${today.getMonth() + 1}月`;
    let updatedChronicle;

    const yearHeader = `## ${today.getFullYear()}年`;
    const yearIndex = existingChronicle.indexOf(yearHeader);
    let yearSectionEnd = -1;
    if (yearIndex !== -1) {
      const nextYear = existingChronicle.indexOf('\n## ', yearIndex + yearHeader.length);
      yearSectionEnd = nextYear === -1 ? existingChronicle.length : nextYear;
    }

    if (yearIndex !== -1 && existingChronicle.slice(yearIndex, yearSectionEnd).includes(monthHeader)) {
      const monthIndexInYear = existingChronicle.indexOf(monthHeader, yearIndex);
      const afterMonth = monthIndexInYear + monthHeader.length;
      const nextSection = existingChronicle.indexOf('\n###', afterMonth + 1);
      const nextChapter = existingChronicle.indexOf('\n##', afterMonth + 1);
      const insertPoint = Math.min(
        nextSection === -1 ? Infinity : nextSection,
        nextChapter === -1 ? Infinity : nextChapter
      );

      if (insertPoint === Infinity) {
        updatedChronicle = existingChronicle + '\n' + resultText + '\n';
      } else {
        updatedChronicle = existingChronicle.slice(0, insertPoint) + '\n' + resultText + '\n' + existingChronicle.slice(insertPoint);
      }
    } else if (yearIndex !== -1) {
      const afterYear = yearIndex + yearHeader.length;
      updatedChronicle = existingChronicle.slice(0, afterYear) + '\n\n' + monthHeader + '\n' + resultText + '\n' + existingChronicle.slice(afterYear);
    } else {
      const firstYearMatch = existingChronicle.match(/\n## \d{4}年/);
      if (firstYearMatch) {
        const insertAt = existingChronicle.indexOf(firstYearMatch[0]);
        updatedChronicle = existingChronicle.slice(0, insertAt) + '\n\n## ' + today.getFullYear() + '年\n\n' + monthHeader + '\n' + resultText + '\n' + existingChronicle.slice(insertAt);
      } else {
        updatedChronicle = existingChronicle + '\n## ' + today.getFullYear() + '年\n\n' + monthHeader + '\n' + resultText + '\n';
      }
    }

    updatedChronicle = updatedChronicle.replace(
      /date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
      `date: ${dateISO} 08:00:00`
    );

    fs.writeFileSync(CHRONICLE_FILE, updatedChronicle, 'utf-8');
    console.log(`[编年史] 已更新: ${resultText.split('\n')[0]}...`);
  } catch (err) {
    console.error('[编年史] 更新失败:', err.message);
  }
}

// ============ 发布到Hexo ============
function publishToHexo(report, dateStrCN, dateISO, noDeploy = false) {
  const fileName = `ai-daily-${dateStrCN}.md`;
  const filePath = path.join(HEXO_DIR, 'source', '_posts', fileName);

  const hexoContent = `---
title: AI行业日报 - ${dateStrCN}
date: ${dateISO} 08:00:00
categories: [AI日报]
tags: [AI, 行业日报, 科技新闻]
---

${report}
`;

  fs.writeFileSync(filePath, hexoContent, 'utf-8');
  console.log(`[发布] 已生成: ${fileName}`);
  if (noDeploy) return;
}

// ============ 主流程 ============
async function main() {
  const noDeploy = process.argv.includes('--no-deploy');
  console.log('========================================');
  console.log('  AI行业日报生成器');
  if (noDeploy) console.log('  (仅生成，不部署)');
  console.log('========================================\n');

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dateStrCN = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

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
  const report = await generateReport(newsItems);

  // 3. 发布到Hexo（仅写文件，不部署）
  console.log('\n[步骤3] 写入文章...\n');
  publishToHexo(report, dateStrCN, dateStr, noDeploy);

  // 4. 更新编年史
  console.log('\n[步骤4] 更新编年史...\n');
  await updateChronicle(newsItems);

  // 5. 部署（仅在非 no-deploy 模式下）
  if (!noDeploy) {
    console.log('\n[步骤5] 部署网站...\n');
    try {
      execSync('npx hexo clean && npx hexo generate && npx hexo deploy', {
        cwd: HEXO_DIR,
        env: {
          ...process.env,
          HTTP_PROXY: PROXY_URL,
          HTTPS_PROXY: PROXY_URL,
        },
        stdio: 'inherit',
      });
      console.log('[部署] 完成！');
    } catch (err) {
      console.error('[部署] 失败:', err.message);
    }
  }

  console.log('\n========================================');
  console.log('  日报生成完成！');
  console.log('  访问: https://hanxiaofan.site');
  console.log('========================================');
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
