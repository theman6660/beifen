#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { insertChronicleEntry } = require('../chronicle-utils');
const {
  getBeijingDateParts,
  beijingDateISO,
  beijingDateCN,
} = require('../lib/date-utils');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const entryFile = args.entry || process.env.CHRONICLE_ENTRY_FILE || '.local-artifacts/chronicle-entry/ai-chronicle-entry.md';
  const chronicleFile = args.chronicle || process.env.CHRONICLE_FILE || 'source/_posts/ai-chronicle.md';

  if (!fs.existsSync(entryFile)) {
    console.log(`[编年史] 无新增条目 artifact，跳过: ${entryFile}`);
    return;
  }

  const entryText = fs.readFileSync(entryFile, 'utf-8').trim();
  if (!entryText) {
    console.log('[编年史] 新增条目为空，跳过');
    return;
  }

  const { year, month, day } = getBeijingDateParts();
  const dateISO = beijingDateISO();
  const dateStrCN = beijingDateCN();
  const existingChronicle = fs.existsSync(chronicleFile)
    ? fs.readFileSync(chronicleFile, 'utf-8')
    : '';

  const result = insertChronicleEntry(existingChronicle, entryText, {
    year,
    month,
    dateISO,
    dateStrCN,
  });

  if (!result.updated) {
    console.log(`[编年史] 跳过新增条目: ${result.reason}`);
    return;
  }

  fs.mkdirSync(path.dirname(chronicleFile), { recursive: true });
  fs.writeFileSync(chronicleFile, result.content, 'utf-8');
  console.log(`[编年史] 已应用新增条目: ${result.entryText.split('\n')[0]}`);
}

try {
  main();
} catch (err) {
  console.error('[编年史] 应用新增条目失败:', err.stack || err.message || String(err));
  process.exit(1);
}
