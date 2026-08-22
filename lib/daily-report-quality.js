'use strict';

function extractPublishedAt(html) {
  const normalized = String(html || '').replace(/\\"/g, '"');
  const patterns = [
    /"publishedOn"\s*:\s*"([^"]+)"/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']article:published_time["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const value = normalized.match(pattern)?.[1]?.trim();
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return '';
}

function isPublishedWithin(publishedAt, earliest, latest) {
  const timestamp = Date.parse(String(publishedAt || ''));
  const earliestTimestamp = earliest instanceof Date ? earliest.getTime() : Number(earliest);
  const latestTimestamp = latest instanceof Date ? latest.getTime() : Number(latest);
  return Number.isFinite(timestamp)
    && Number.isFinite(earliestTimestamp)
    && Number.isFinite(latestTimestamp)
    && timestamp >= earliestTimestamp
    && timestamp <= latestTimestamp;
}

function formatNewsItemForPrompt(item, index, snippetChars = 500) {
  return [
    `${index + 1}. [${item.source}] ${item.title}`,
    `   发布日期: ${item.date || '未知'}`,
    `   重要性线索: ${item._priorityReason || '来源覆盖'}`,
    `   链接: ${item.link}`,
    `   摘要: ${(item.snippet || '').slice(0, snippetChars)}`,
  ].join('\n');
}

function interpretQualityResponse(value) {
  const result = String(value || '').trim();
  if (!result) {
    return { pass: false, reason: '质检模型返回空内容' };
  }
  const clean = result.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  const firstLine = clean.split('\n')[0].trim();
  if (/^(?:\*\*)?PASS(?:\*\*)?(?:[:：\s]|$)/i.test(firstLine)) {
    return { pass: true, reason: clean };
  }
  if (/^(?:\*\*)?FAIL(?:\*\*)?(?:[:：\s]|$)/i.test(firstLine)) {
    return { pass: false, reason: clean };
  }
  const failMatch = clean.match(/(?:^|\n)(?:\*\*)?FAIL(?:\*\*)?[:：\s]*([^\n]*)/i);
  if (failMatch) {
    return { pass: false, reason: clean };
  }
  const passMatch = clean.match(/(?:^|\n)(?:\*\*)?PASS(?:\*\*)?(?:[:：\s]|$)/i);
  if (passMatch && !failMatch) {
    return { pass: true, reason: clean };
  }
  return {
    pass: false,
    reason: `质检模型返回无法识别的结果: ${result.slice(0, 120)}`,
  };
}

module.exports = {
  extractPublishedAt,
  formatNewsItemForPrompt,
  interpretQualityResponse,
  isPublishedWithin,
};
