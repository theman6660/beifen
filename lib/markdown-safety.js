'use strict';

const UNSAFE_HTML_BLOCK = /<(script|style|iframe|object|embed|form|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_TAG = /<\/?[a-z][^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function sanitizePlainText(value, maxLength = 1200) {
  return String(value ?? '')
    .replace(UNSAFE_HTML_BLOCK, ' ')
    .replace(HTML_COMMENT, ' ')
    .replace(HTML_TAG, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}

function escapeMarkdownText(value) {
  return sanitizePlainText(value, 500)
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]<>])/g, '\\$1');
}

function hasUnsafeMarkdownSeparator(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .some((line) => /^\s{0,3}[-*_]{3,}\s*$/.test(line));
}

function stripUnsafeMarkdownSeparators(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s{0,3}[-*_]{3,}\s*$/.test(line))
    .join('\n');
}

function sanitizeGeneratedMarkdown(markdown) {
  const withoutHtml = String(markdown || '')
    .replace(UNSAFE_HTML_BLOCK, '')
    .replace(HTML_COMMENT, '')
    .replace(HTML_TAG, '');

  const safeLinks = withoutHtml.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g,
    (match, label, rawUrl) => {
      const safeUrl = sanitizeHttpUrl(rawUrl);
      return safeUrl ? `[${escapeMarkdownText(label)}](${safeUrl})` : escapeMarkdownText(label);
    },
  );

  return stripUnsafeMarkdownSeparators(safeLinks);
}

function normalizeReport(report, title) {
  const withoutFence = String(report || '')
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === title))
    .join('\n');
  return sanitizeGeneratedMarkdown(withoutFence).trim();
}

function sanitizeNewsItem(item) {
  return {
    ...item,
    title: sanitizePlainText(item?.title, 300),
    snippet: sanitizePlainText(item?.snippet, 1200),
    link: sanitizeHttpUrl(item?.link),
  };
}

function buildSourceList(newsItems, maxSources = 30) {
  const seen = new Set();
  const sources = [];
  for (const rawItem of newsItems) {
    const item = sanitizeNewsItem(rawItem);
    if (!item.link || !item.title) continue;
    const key = `${item.title}|${item.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(`- [${escapeMarkdownText(item.source)}] [${escapeMarkdownText(item.title)}](${item.link})`);
    if (sources.length >= maxSources) break;
  }

  if (sources.length === 0) return '';
  return `\n\n## 参考来源\n\n${sources.join('\n')}`;
}

module.exports = {
  buildSourceList,
  escapeMarkdownText,
  hasUnsafeMarkdownSeparator,
  normalizeReport,
  sanitizeGeneratedMarkdown,
  sanitizeHttpUrl,
  sanitizeNewsItem,
  sanitizePlainText,
  stripUnsafeMarkdownSeparators,
};
