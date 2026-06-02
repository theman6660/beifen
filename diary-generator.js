require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const HEXO_DIR = __dirname;
const SNIPPETS_DIR = path.join(HEXO_DIR, 'data', 'snippets');
const POSTS_DIR = path.join(HEXO_DIR, 'source', '_posts');

// ============ 北京时间工具函数 ============
function beijingNow() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function beijingTodayStr() {
  const bj = beijingNow();
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
}

// 启动时验证必需的环境变量
if (!process.env.DEEPSEEK_API_KEY) {
  console.error('错误: DEEPSEEK_API_KEY 未设置');
  process.exit(1);
}

const client = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
  timeout: 60000,
  maxRetries: 2,
});

function getTodayStr() {
  return beijingTodayStr();
}

function getDateStrCN(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`日期格式无效: ${dateStr}，应为 YYYY-MM-DD`);
  }
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) {
    throw new Error(`日期格式无效: ${dateStr}`);
  }
  return `${y}年${m}月${d}日`;
}

// 校验 dateStr 是安全的文件名（防止路径穿越）
function validateDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`日期格式无效: "${dateStr}"，必须为 YYYY-MM-DD`);
  }
}

// ============ 读snippets ============
function loadSnippets(dateStr) {
  const file = path.join(SNIPPETS_DIR, `${dateStr}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.error(`[读取] ${dateStr} 格式错误：期望数组，实际为 ${typeof data}`);
      return null;
    }
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error(`[读取] ${dateStr} 文件错误:`, err.message);
    return null;
  }
}

// ============ DeepSeek写日记 ============
async function generateDiary(snippets, dateStr) {
  const dateCN = getDateStrCN(dateStr);
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
  // 用 UTC 计算星期几，避免本地时区偏移
  const jsDate = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][jsDate.getUTCDay()];

  // 过滤缺少 time/reply 的碎片
  const validSnippets = snippets.filter(s => s && s.time && s.reply);
  if (validSnippets.length === 0) {
    console.log('[跳过] 无有效日记素材');
    return null;
  }

  const snippetsText = validSnippets.map(s =>
    `[${s.time}] ${s.reply}`
  ).join('\n');

  const prompt = `根据以下事件碎片，写一篇简洁的日记，纯记录事件，不要任何主观感受。

日期：${dateCN} ${dayOfWeek}

事件碎片：
${snippetsText}

写作规则：
- 用第一人称"我"
- 只记录做了什么、发生了什么，不写心情、感想、评价
- 不要心理活动（如"心里还是挺有成就感的"）
- 不要主观形容词（如"好吃"、"累死了"、"还不错"）
- 不要抒情和感慨
- 碎片之间自然串联，保持时间顺序
- 100-200字即可，简洁

直接写日记，不要标题。`;

  console.log('[DeepSeek] 正在生成日记...');
  const response = await client.chat.completions.create({
    model: process.env.MODEL || 'deepseek-v4-pro',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 1500,
  });

  const content = response?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    console.log('[跳过] API 返回空内容');
    return null;
  }
  return content.trim();
}

// ============ 发布 ============
function publishToHexo(diaryContent, dateStr) {
  const fileName = `diary-${dateStr}.md`;
  const filePath = path.join(POSTS_DIR, fileName);
  const dateCN = getDateStrCN(dateStr);

  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const hexoContent = `---
title: ${dateCN}
date: ${dateStr} 22:00:00
categories: [日记]
tags: [日记, 日常]
---

${diaryContent}
`;

  fs.writeFileSync(filePath, hexoContent, 'utf-8');
  console.log(`[发布] ${fileName}`);
  return filePath;
}

// ============ 主流程 ============
async function main() {
  const rawDate = process.argv[2];
  if (rawDate) {
    validateDateStr(rawDate);
  }
  const dateStr = rawDate || getTodayStr();
  console.log(`========================================`);
  console.log(`  日记生成器 — ${getDateStrCN(dateStr)}`);
  console.log(`========================================\n`);

  const snippets = loadSnippets(dateStr);
  if (!snippets || snippets.length === 0) {
    console.log('[跳过] 当日无日记素材');
    return;
  }

  console.log(`[素材] ${snippets.length}条碎片\n`);

  const diary = await generateDiary(snippets, dateStr);
  if (!diary) {
    console.log('[跳过] 日记生成失败或内容为空');
    return;
  }

  console.log(`\n[日记] ${diary.slice(0, 100)}...\n`);

  publishToHexo(diary, dateStr);

  console.log('\n========================================');
  console.log('  日记生成完成！');
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
