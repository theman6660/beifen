'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const errors = [];
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => fs.existsSync(path.join(root, file)));

for (const file of tracked) {
  if (/^data\/snippets\/.*\.json$/i.test(file.replace(/\\/g, '/'))) {
    errors.push(`private snippet JSON is tracked: ${file}`);
  }
  if (/(^|\/)\.env(?:\.|$)/i.test(file.replace(/\\/g, '/')) && !/\.env\.example$/i.test(file)) {
    errors.push(`environment secret file is tracked: ${file}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (/hexo\s+deploy/i.test(packageJson.scripts?.deploy || '')) {
  errors.push('package.json deploy script bypasses the audited workflow');
}

for (const file of ['ai-daily.js', 'society-daily.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (/npx\s+hexo[^\r\n'"`]*deploy/i.test(source)) {
    errors.push(`${file} still contains a direct Hexo deploy command`);
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`[source-safety] ${error}`));
  process.exit(1);
}

console.log(`[source-safety] checked ${tracked.length} tracked files`);
