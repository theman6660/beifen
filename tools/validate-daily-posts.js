'use strict';

const fs = require('fs');
const path = require('path');
const { hasUnsafeMarkdownSeparator } = require('../lib/markdown-safety');

const postsDir = path.resolve(__dirname, '..', 'source', '_posts');
const files = fs.readdirSync(postsDir)
  .filter((name) => /^(ai|society)-daily-.*\.md$/.test(name))
  .sort();
const recentFiles = new Set([
  ...files.filter((name) => /^ai-daily-\d{4}-\d{2}-\d{2}\.md$/.test(name)).slice(-30),
  ...files.filter((name) => /^society-daily-\d{4}-\d{2}-\d{2}\.md$/.test(name)).slice(-30),
]);
const errors = [];

for (const name of files) {
  const content = fs.readFileSync(path.join(postsDir, name), 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    errors.push(`${name}: missing frontmatter`);
    continue;
  }
  for (const field of ['title', 'date']) {
    if (!new RegExp(`^${field}:\\s+\\S`, 'm').test(frontmatter[1])) errors.push(`${name}: missing ${field}`);
  }
  if (/<\/?(?:script|iframe|object|embed|form|svg|math)\b/i.test(content)) {
    errors.push(`${name}: contains unsafe raw HTML`);
  }
  if (recentFiles.has(name) && hasUnsafeMarkdownSeparator(content.slice(frontmatter[0].length))) {
    errors.push(`${name}: contains a bare Markdown separator`);
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`[daily-posts] ${error}`));
  process.exit(1);
}

console.log(`[daily-posts] validated ${files.length} posts (${recentFiles.size} with strict separator checks)`);
