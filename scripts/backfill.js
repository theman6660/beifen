const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MISSING_DATES = [
  '2026-08-20',
  '2026-08-19',
  '2026-08-17',
  '2026-08-16',
  '2026-08-15',
  '2026-08-14',
];

const HEXO_POSTS_DIR = path.join(__dirname, '..', 'source', '_posts');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runScript(scriptName, date) {
  return new Promise((resolve) => {
    console.log(`\n========================================`);
    console.log(`[补齐] 开始生成 ${date} 的 ${scriptName}...`);
    console.log(`========================================`);

    const env = {
      ...process.env,
      BJ_DATE: date,
      PROXY_URL: process.env.PROXY_URL || 'http://127.0.0.1:7892',
      AUTH_TOKEN: process.env.AUTH_TOKEN || process.env.GEMINI_API_KEY || '',
      BASE_URL: process.env.BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
      MODEL: process.env.MODEL || 'gemini-3.5-flash-lite',
    };

    const child = spawn('node', [scriptName, '--no-deploy'], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: 'inherit',
    });

    child.on('close', code => {
      if (code === 0) {
        console.log(`[补齐] ${date} 的 ${scriptName} 生成成功！`);
      } else {
        console.error(`[补齐] ${date} 的 ${scriptName} 退出码: ${code}`);
      }
      resolve();
    });

    child.on('error', err => {
      console.error(`[补齐] 执行失败: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  console.log(`[补齐] 准备补齐以下日期的日报:`, MISSING_DATES);

  for (const date of MISSING_DATES) {
    const aiFile = path.join(HEXO_POSTS_DIR, `ai-daily-${date}.md`);
    const societyFile = path.join(HEXO_POSTS_DIR, `society-daily-${date}.md`);

    if (!fs.existsSync(aiFile)) {
      await runScript('ai-daily.js', date);
      console.log('[冷却] 避免触发 15 RPM 频率限制，等待 18 秒...');
      await sleep(18000);
    } else {
      console.log(`[跳过] ${aiFile} 已存在`);
    }

    if (!fs.existsSync(societyFile)) {
      await runScript('society-daily.js', date);
      console.log('[冷却] 避免触发 15 RPM 频率限制，等待 18 秒...');
      await sleep(18000);
    } else {
      console.log(`[跳过] ${societyFile} 已存在`);
    }
  }

  console.log(`\n========================================`);
  console.log(`[完成] 所有缺失日期的补齐处理完毕！`);
  console.log(`========================================`);
}

main().catch(console.error);
