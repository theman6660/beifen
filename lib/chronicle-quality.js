'use strict';

const OFFICIAL_SOURCE_PATTERN = /(?:official|openai news|anthropic official|google deepmind|nvidia blog|meta ai official)/i;

function parseJsonObject(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('模型没有返回 JSON 对象');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseEventDate(dateText) {
  const value = String(dateText || '').trim();
  let match = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      label: `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`,
    };
  }
  match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    label: `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`,
  };
}

function normalizeSourceIds(sourceIds) {
  if (!Array.isArray(sourceIds)) return [];
  return [...new Set(sourceIds
    .map(value => Number.parseInt(value, 10))
    .filter(Number.isInteger))];
}

function sourceIsOfficial(item) {
  return Boolean(item && OFFICIAL_SOURCE_PATTERN.test(item.source || ''));
}

function validateChronicleCandidate(candidate, evidenceItems) {
  if (!candidate || typeof candidate !== 'object') {
    return { pass: false, reason: '候选不是对象' };
  }
  const eventDate = parseEventDate(candidate.eventDate);
  const event = String(candidate.event || '').replace(/\s+/g, ' ').trim();
  const why = String(candidate.why || '').replace(/\s+/g, ' ').trim();
  const sourceIds = normalizeSourceIds(candidate.sourceIds);
  const sources = sourceIds.map(id => evidenceItems[id - 1]).filter(Boolean);
  const distinctLinks = new Set(sources.map(item => item.link).filter(Boolean));

  if (!eventDate) return { pass: false, reason: '事件日期无效' };
  if (event.length < 16) return { pass: false, reason: '事件描述过短' };
  if (why.length < 30) return { pass: false, reason: '历史意义说明过短' };
  if (/^(?:传闻|据称)|如果|若成功|尚未证实/.test(event)) {
    return { pass: false, reason: '事件描述仍是传闻或条件推测' };
  }
  if (sources.length !== sourceIds.length) return { pass: false, reason: '引用了不存在的来源编号' };
  if (distinctLinks.size < 2 && !sources.some(sourceIsOfficial)) {
    return { pass: false, reason: '缺少两个独立来源或一个官方一手来源' };
  }

  return {
    pass: true,
    candidate: { eventDate: eventDate.label, event, why, sourceIds },
    sources,
  };
}

function safeMarkdownLabel(value) {
  return String(value || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function ensureSentenceEnd(value) {
  const text = String(value || '').trim();
  return /[。！？.!?）】”’]$/.test(text) ? text : `${text}。`;
}

function buildChronicleEntry(candidate, evidenceItems) {
  const checked = validateChronicleCandidate(candidate, evidenceItems);
  if (!checked.pass) throw new Error(checked.reason);
  const sources = checked.candidate.sourceIds
    .map(id => evidenceItems[id - 1])
    .filter(Boolean)
    .map(item => `[${safeMarkdownLabel(item.source)}](${item.link})`);
  return [
    `- **${checked.candidate.eventDate}**：${ensureSentenceEnd(checked.candidate.event)}`,
    `  - **来源**：${sources.join('、')}`,
  ].join('\n');
}

function validateChronicleEntry(entryText) {
  const text = String(entryText || '').trim();
  const firstLine = text.split(/\r?\n/)[0] || '';
  const eventText = firstLine.replace(/^- \*\*[^*]+\*\*：/, '').trim();
  const sourceMatch = text.match(/^\s+- \*\*来源\*\*：(.+)$/m);
  if (!/^- \*\*\d{4}年\d{1,2}月\d{1,2}日\*\*：\S+/.test(firstLine)) {
    return { pass: false, reason: '缺少规范的事件日期与描述' };
  }
  if (!sourceMatch || !/https?:\/\//.test(sourceMatch[1])) {
    return { pass: false, reason: '缺少可追溯来源' };
  }
  if (/^#{2,6}\s+/m.test(text)) return { pass: false, reason: '条目包含 Markdown 标题' };
  if (!/[。！？.!?）】”’]$/.test(eventText)) return { pass: false, reason: '事件描述疑似被截断' };
  if (/(?:完全基于|基于国产|以及|包括|和|与|、|，|：)$/.test(eventText.replace(/[。.!?！？]$/, ''))) {
    return { pass: false, reason: '事件描述以未完成短语结尾' };
  }
  return { pass: true, reason: '编年史条目结构完整' };
}

function splitChronicleEntries(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  const matches = [...text.matchAll(/^- \*\*\d{4}年\d{1,2}月[^\n*]+\*\*：/gm)];
  if (matches.length === 0) return [text];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return text.slice(start, end).trim();
  });
}

function extractChronicleEntryDate(entryText) {
  const match = String(entryText || '').match(/^- \*\*(\d{4})年(\d{1,2})月([^*]+)\*\*：/m);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    dateStrCN: `${Number(match[1])}年${Number(match[2])}月${match[3]}`,
  };
}

function parseDailySourceItems(markdown, dateISO) {
  const items = [];
  const sourcePattern = /^- \[([^\]]+)\] \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm;
  let match;
  while ((match = sourcePattern.exec(String(markdown || ''))) !== null) {
    items.push({
      source: safeMarkdownLabel(match[1]),
      title: safeMarkdownLabel(match[2]),
      link: match[3],
      date: `${dateISO}T12:00:00+08:00`,
      snippet: `${dateISO} 日报回看来源`,
      _timestamp: new Date(`${dateISO}T12:00:00+08:00`).getTime(),
    });
  }
  return items;
}

function extractRecentChronicleContext(content, maxChars = 12000, currentYear = new Date().getFullYear()) {
  const text = String(content || '');
  const start = text.indexOf(`## ${currentYear}年`);
  if (start === -1) return text.slice(-maxChars);
  const nextYear = text.slice(start + 1).search(/\n## \d{4}年/);
  const section = nextYear === -1 ? text.slice(start) : text.slice(start, start + 1 + nextYear);
  return section.slice(0, maxChars);
}

module.exports = {
  buildChronicleEntry,
  extractChronicleEntryDate,
  extractRecentChronicleContext,
  parseDailySourceItems,
  parseEventDate,
  parseJsonObject,
  sourceIsOfficial,
  splitChronicleEntries,
  validateChronicleCandidate,
  validateChronicleEntry,
};
