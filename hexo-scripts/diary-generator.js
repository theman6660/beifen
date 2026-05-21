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
    `[${s.time}] ${s.reply}`
  ).join('\n');

  const prompt = `你是一个日记写手。下面是一天中记录下来的碎片信息，请把它们写成一篇自然的第一人称日记。

日期：${dateCN} ${dayOfWeek}

今日碎片（这些是日记主人一天中的只言片语，记录了他在做什么、想什么）：
${snippetsText}

写作要求：
- 你就是写日记的人，用第一人称"我"写
- 不要太长，200-400字
- 语言轻松自然，像自己晚上坐下来回顾今天
- 可以补充合理的心理活动和细节，让日记更完整
- 碎片只是线索，重新组织成连贯叙事，不要逐条罗列
- 碎片之间如果有联系，自然地串联
- 日记就是日记，不要提"碎片"、"记录"、"收集"这些词
- 纯文字，不用markdown

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
