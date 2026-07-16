'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function findLatestCompleteReportDate(postsDir) {
  const names = fs.readdirSync(postsDir);
  const aiDates = new Set(names.map((name) => name.match(/^ai-daily-(\d{4}-\d{2}-\d{2})\.md$/)?.[1]).filter(Boolean));
  const societyDates = new Set(names.map((name) => name.match(/^society-daily-(\d{4}-\d{2}-\d{2})\.md$/)?.[1]).filter(Boolean));
  const complete = [...aiDates].filter((date) => societyDates.has(date)).sort();
  if (complete.length === 0) throw new Error('No complete AI + society daily-report pair exists');
  return complete.at(-1);
}

function buildStatus({ date, sourceCommit, deployedAt = new Date().toISOString() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid report date: ${date}`);
  if (!/^[0-9a-f]{7,40}$/i.test(sourceCommit)) throw new Error(`Invalid source commit: ${sourceCommit}`);
  const [year, month, day] = date.split('-');
  return {
    schemaVersion: 1,
    date,
    sourceCommit: sourceCommit.toLowerCase(),
    deployedAt,
    sourceRepository: 'theman6660/beifen',
    pagesRepository: 'theman6660/theman6660.github.io',
    reports: {
      ai: `/${year}/${month}/${day}/ai-daily-${date}/`,
      society: `/${year}/${month}/${day}/society-daily-${date}/`,
    },
  };
}

function writeStatus({ rootDir, output, date, sourceCommit, deployedAt }) {
  const postsDir = path.join(rootDir, 'source', '_posts');
  const reportDate = date || findLatestCompleteReportDate(postsDir);
  const outputPath = path.resolve(rootDir, output || 'public/daily-report-status.json');
  const rootPrefix = `${path.resolve(rootDir)}${path.sep}`;
  if (!outputPath.startsWith(rootPrefix)) throw new Error('Output path must stay inside the repository');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const status = buildStatus({ date: reportDate, sourceCommit, deployedAt });
  fs.writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return { outputPath, status };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args['source-commit']) throw new Error('--source-commit is required');
    const result = writeStatus({
      rootDir: process.cwd(),
      output: args.output,
      date: args.date,
      sourceCommit: args['source-commit'],
    });
    console.log(`[deploy-status] ${result.outputPath}: ${result.status.date} @ ${result.status.sourceCommit}`);
  } catch (error) {
    console.error(`[deploy-status] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { buildStatus, findLatestCompleteReportDate, parseArgs, writeStatus };
