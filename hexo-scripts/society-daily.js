const Anthropic = require('@anthropic-ai/sdk');
const { HttpsProxyAgent } = require('https-proxy-agent');
const RSSParser = require('rss-parser');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const PROXY_URL = (process.env.PROXY_URL || '').trim();
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

const client = new Anthropic({
  apiKey: process.env.AUTH_TOKEN,
  baseURL: process.env.BASE_URL,
  timeout: 180000, // 3分钟超时
});

const parser = new RSSParser({
  requestOptions: proxyAgent ? { agent: proxyAgent } : {},
});

const HEXO_DIR = path.resolve(__dirname, '..');
const RSSHUB_URL = (process.env.RSSHUB_URL || '').trim().replace(/\/$/, '');

// ============ RSS源 ============

// 直连源（不需要RSSHub，始终可用）
const DIRECT_SOURCES = [
  { url: 'https://sspai.com/feed', name: '少数派' },
  { url: 'https://www.ruanyifeng.com/blog/atom.xml', name: '阮一峰周刊' },
  { url: 'https://aeon.co/feed.xml', name: 'Aeon' },
  { url: 'https://longreads.com/feed/', name: 'Longreads' },
];

// RSSHub源（需要自建RSSHub实例，配置RSSHUB_URL后自动启用）
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

// 合并所有源
function getAllSources() {
  const sources = [...DIRECT_SOURCES];
  if (RSSHUB_URL) {
    console.log(`[配置] RSSHub已启用: ${RSSHUB_URL}`);
    for (const s of RSSHUB_SOURCES) {
      sources.push({ url: `${RSSHUB_URL}${s.path}`, name: s.name });
    }
  } else {
    console.log('[配置] RSSHub未配置，跳过RSSHub源（设置RSSHUB_URL环境变量启用）');
  }
  return sources;
}

// ============ RSS抓取 ============
async function fetchNews() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const allItems = [];
  const sources = getAllSources();

  for (const source of sources) {
    try {
      console.log(`[抓取] ${source.name}...`);
      const feed = await parser.parseURL(source.url);

      const recentItems = (feed.items || [])
        .filter(item => {
          const pubDate = new Date(item.pubDate || item.isoDate);
          return pubDate >= yesterday;
        })
        .map(item => ({
          title: item.title,
          link: item.link,
          date: item.pubDate || item.isoDate,
          source: source.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 300),
        }));

      allItems.push(...recentItems);
      console.log(`  -> 获取 ${recentItems.length} 条`);
    } catch (err) {
      console.log(`  -> ${source.name} 抓取失败: ${err.message}`);
    }
  }

  allItems.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allItems;
}

// ============ 生成日报 ============
async function generateReport(newsItems, dateStr) {

  const newsText = newsItems.slice(0, 30).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   链接: ${item.link}\n   摘要: ${item.snippet}`
  ).join('\n\n');

  const prompt = `你是一位兼具社会学家和精神分析师视角的观察者。你的任务是从今日新闻中，挖掘这个时代的集体心理、人际关系的深层结构、以及人们不愿说出口的真实欲望和恐惧。

你不是记者，不报道事件本身。你是透过事件看到人心的人。

今日新闻源：
${newsText}

要求：
1. 标题：社会思想日报 - ${dateStr}
2. 结构（按优先级排列）：
   - 时代切片（1-2条新闻，重点不是事件本身，而是它们揭示了什么样的集体心理。比如：一个消费现象背后是怎样的身份焦虑？一个文化潮流背后是怎样的存在性需求？）
   - 关系透视（社会关系的变化：亲密关系的形态、代际之间的张力、个体与群体的博弈、人与人之间的信任/疏离模式）
   - 心理地貌（这个时代人们普遍的心理状态：焦虑的来源、逃避的方式、自我认同的困境、意义感的缺失或重建）
   - 时代精神（正在形成或瓦解的集体信念、价值排序的位移、"什么是好的生活"的定义正在如何被改写）
   - 一面镜子（一个问题或观察，让读者停下来想一想自己：你是否也在这个模式里？你真正想要的是什么？）
3. 风格：
   - 像一个深夜和你聊天的朋友，聪明、真诚、不装
   - 像读弗洛姆或韩炳哲的书，但更口语化、更接地气
   - 不要学术腔，但要有思想深度
   - 敢于指出人们自欺的地方，但不居高临下
4. 核心关注：
   - 人的心理：欲望、恐惧、防御机制、自我欺骗、身份焦虑、孤独感、亲密渴望
   - 社会关系：亲密与疏离、控制与依赖、表演与真实、信任崩塌与重建
   - 时代精神：这个时代的人在追求什么？在逃避什么？在集体性地遗忘什么？
5. 严格排除：不要写政治、国际关系、军事、外交、政党相关内容。只关注人的心理和社会关系。
6. 如果某个分类没有相关内容，跳过该分类
7. 总字数控制在1200-1800字
8. 直接输出文章内容，不要加markdown代码块标记`;

  console.log('[生成] 调用LLM生成社会思想日报...');
  const response = await client.messages.create({
    model: process.env.MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(c => c.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// ============ 发布到Hexo ============
function publishToHexo(report, dateStr, dateISO) {
  const fileName = `society-daily-${dateStr}.md`;
  const filePath = path.join(HEXO_DIR, 'source', '_posts', fileName);

  const frontMatter = `---
title: 社会思想日报 - ${dateStr}
date: ${dateISO} 08:30:00
categories: [社会日报]
tags: [社会心理, 精神分析, 时代精神]
---

`;

  fs.writeFileSync(filePath, frontMatter + report, 'utf-8');
  console.log(`[发布] 已写入: ${filePath}`);
}

// ============ 主流程 ============
async function main() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const dateISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  console.log('========================================');
  console.log('  社会思想日报生成器');
  console.log('========================================\n');

  console.log('[步骤1] 抓取社会新闻...');
  const newsItems = await fetchNews();
  console.log(`\n共获取 ${newsItems.length} 条新闻\n`);

  if (newsItems.length === 0) {
    console.log('没有获取到新闻，退出');
    return;
  }

  console.log('[步骤2] 生成社会思想日报...');
  const report = await generateReport(newsItems, dateStr);

  if (!report) {
    console.log('LLM未返回内容，退出');
    return;
  }
  console.log(`\n--- 日报预览 ---\n${report.slice(0, 500)}...\n`);

  console.log('[步骤3] 发布到Hexo...');
  publishToHexo(report, dateStr, dateISO);

  console.log('\n========================================');
  console.log('  完成！社会思想日报已生成');
  console.log('========================================');
}

main().catch(err => {
  console.error('运行失败:', err);
  process.exit(1);
});
