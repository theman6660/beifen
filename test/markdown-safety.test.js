'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSourceList,
  hasUnsafeMarkdownSeparator,
  normalizeReport,
  sanitizeHttpUrl,
  sanitizeNewsItem,
} = require('../lib/markdown-safety');

test('only http and https source URLs survive', () => {
  assert.equal(sanitizeHttpUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeHttpUrl('data:text/html,test'), '');
  assert.equal(sanitizeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('RSS text and links are safe before entering generated Markdown', () => {
  const item = sanitizeNewsItem({
    source: 'Feed',
    title: '<img src=x onerror=alert(1)> title',
    snippet: '<script>alert(1)</script> useful',
    link: 'javascript:alert(1)',
  });
  assert.equal(item.title, 'title');
  assert.equal(item.snippet, 'useful');
  assert.equal(item.link, '');
  assert.equal(buildSourceList([item]), '');
});

test('generated reports lose raw HTML, unsafe links and bare separators', () => {
  const report = normalizeReport([
    '```markdown',
    '## 今日速览',
    '<script>alert(1)</script>',
    '[bad](javascript:alert(1))',
    '---',
    '```',
  ].join('\n'), 'unused');
  assert.doesNotMatch(report, /script|javascript:/i);
  assert.equal(hasUnsafeMarkdownSeparator(report), false);
});
