const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const HEXO_DIR = path.resolve(__dirname, '..');
const SNIPPETS_DIR = path.join(HEXO_DIR, 'data', 'snippets');
const POSTS_DIR = path.join(HEXO_DIR, 'source', '_posts');

const client = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDateStrCN(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

// ============ 读snippets ============
function loadSnippets(dateStr) {
  const file = path.join(SNIPPETS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[读取] ${dateStr} 文件损坏:`, err.message);
    return null;
  }
}

// ============ DeepSeek写日记 ============
async function generateDiary(snippets, dateStr) {
  const dateCN = getDateStrCN(dateStr);
  const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(dateStr).getDay()];

  const snippetsText = snippets.map(s =>
    `[${s.time}] 问了「${s.ask}」→ 他回「${s.reply}」`
  ).join('\n');

  const prompt = `你是一个日记写手。下面是一天中收集到的对话碎片，请把它们写成一篇自然的第一人称日记。

日期：${dateCN} ${dayOfWeek}

对话碎片：
${snippetsText}

写作要求：
- 用第一人称"我"，像自己晚上坐下来写今天的日记
- 不要太长，200-400字，挑有意思的事情写
- 语言轻松自然，不要文艺腔，不要像作文
- 可以适当补充心理活动（"今天在图书馆待了一天，效率还不错"）
- 对话碎片只是素材，重新组织和润色，不要逐条罗列
- 如果素材之间有联系，自然地串联起来
- 不要提到"日记"、"素材"、"碎片"这些词
- 不要用markdown，就是纯文本的日记

直接写日记内容，不要加标题。`;

  console.log('[DeepSeek] 正在生成日记...');
  const response = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0.8,
    max_tokens: 1500,
  });

  return response.choices[0].message.content.trim();
}

// ============ 发布 ============
function publishToHexo(diaryContent, dateStr) {
  const fileName = `diary-${dateStr}.md`;
  const filePath = path.join(POSTS_DIR, fileName);
  const dateCN = getDateStrCN(dateStr);

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
  const dateStr = process.argv[2] || getTodayStr();
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
  console.log(`\n[日记] ${diary.slice(0, 100)}...\n`);

  publishToHexo(diary, dateStr);

  console.log('\n========================================');
  console.log('  日记生成完成！');
  console.log('========================================');
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
