const fs = require('fs');
const path = require('path');
const { extractChronicleEntryDate } = require('./lib/chronicle-quality');

const DEFAULT_CHRONICLE_PERMALINK = '/ai-chronicle/';

function normalizeChronicleEntry(rawText) {
  return (rawText || '')
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    // LLM 偶尔会在条目里带 Markdown 标题（## / ### …），会破坏编年史的
    // 年/月分章结构。直接剥离标题前缀（而非转成 **##** 这种会原样显示
    // 的字面文本），让正文回落为普通段落。
    .replace(/^#{2,6}\s+/gm, '')
    .trim();
}

function buildInitialChronicle({ year, month, dateISO, permalink = DEFAULT_CHRONICLE_PERMALINK }) {
  return `---
title: AI编年史：从图灵到此刻
permalink: ${permalink}
date: ${dateISO} 08:00:00
categories: [AI编年史]
tags: [编年史, 时间线, AI]
---

# AI编年史：从图灵到此刻

> 这是一份持续更新的AI发展编年史。它不记录每一天的新闻，只记录那些真正改变游戏规则的时刻——技术的突破、思想的碰撞、社会的转折。

---

## ${year}年

### ${month}月

`;
}

function ensureChroniclePermalink(content, permalink = DEFAULT_CHRONICLE_PERMALINK) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch || /^permalink:\s*/m.test(frontmatterMatch[1])) {
    return content;
  }

  const frontmatterLines = frontmatterMatch[1].split(/\r?\n/);
  const titleIndex = frontmatterLines.findIndex(line => /^title:\s*/.test(line));
  const insertIndex = titleIndex === -1 ? 0 : titleIndex + 1;
  frontmatterLines.splice(insertIndex, 0, `permalink: ${permalink}`);

  return `---\n${frontmatterLines.join('\n')}\n---${content.slice(frontmatterMatch[0].length)}`;
}

function updateChronicleDate(content, dateISO) {
  return content.replace(
    /^(---[\s\S]*?^date: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m,
    `$1${dateISO} 08:00:00`
  );
}

function findYearSectionEnd(content, yearHeader, yearIndex) {
  let yearSectionEnd = content.length;
  if (yearIndex !== -1) {
    const afterYearHeader = yearIndex + yearHeader.length;
    const nextYearMatch = content.slice(afterYearHeader).match(/\n## \d{4}年/);
    if (nextYearMatch) yearSectionEnd = afterYearHeader + nextYearMatch.index;
  }
  return yearSectionEnd;
}

// 在已有同日条目后找到追加位置：下一条日期条目或章节边界
function findInsertAfterExistingDateEntry(content, dateMarker) {
  const datePos = content.indexOf(dateMarker);
  if (datePos === -1) return -1;

  // 从 dateMarker 位置开始扫描，找到这一行的结尾
  const afterLine = content.indexOf('\n', datePos);
  if (afterLine === -1) return content.length;

  // 从此行之后找下一条条目或章节边界
  const rest = content.slice(afterLine + 1);
  const nextEntryMatch = rest.match(/\n- \*\*\d{4}年\d{1,2}月\d{1,2}日\*\*/);
  const nextSectionMatch = rest.match(/\n(?:## \d{4}年|### \d{1,2}月)/);

  let offset = rest.length;
  if (nextEntryMatch) offset = Math.min(offset, nextEntryMatch.index);
  if (nextSectionMatch) offset = Math.min(offset, nextSectionMatch.index);

  // 回退到末尾非空行
  let insertPoint = afterLine + 1 + offset;
  while (insertPoint > afterLine + 1 && content[insertPoint - 1] === '\n') {
    insertPoint--;
  }
  return insertPoint;
}

function getEntrySortKey(label, fallbackYear, fallbackMonth) {
  const yearMatch = String(label || '').match(/(\d{4})年/);
  const monthMatch = String(label || '').match(/(\d{1,2})月/);
  const dayMatch = String(label || '').match(/月(\d{1,2})(?:日|[-—至])/);
  let day = dayMatch ? Number(dayMatch[1]) : 0;
  const rangeMatch = String(label || '').match(/月\d{1,2}[-—至](\d{1,2})日/);
  if (rangeMatch) day = Number(rangeMatch[1]);
  if (/月初/.test(label)) day = 1;
  if (/月中/.test(label)) day = 15;
  if (/月末/.test(label)) day = 28;
  return (Number(yearMatch?.[1] || fallbackYear) * 10000)
    + (Number(monthMatch?.[1] || fallbackMonth) * 100)
    + day;
}

function sortEntryBlocks(body, year, month) {
  const matches = [...String(body || '').matchAll(/^- \*\*([^*]+)\*\*：/gm)];
  if (matches.length < 2) return String(body || '').trim();
  const prefix = String(body || '').slice(0, matches[0].index).trim();
  const entries = matches.map((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : String(body || '').length;
    return {
      key: getEntrySortKey(match[1], year, month),
      originalIndex: index,
      text: String(body || '').slice(match.index, end).trim(),
    };
  }).sort((a, b) => b.key - a.key || a.originalIndex - b.originalIndex);
  return [prefix, ...entries.map(entry => entry.text)].filter(Boolean).join('\n\n');
}

function sortMonthBlocks(yearBlock, year) {
  const headerMatch = String(yearBlock || '').match(/^## \d{4}年\s*/);
  const bodyStart = headerMatch ? headerMatch[0].length : 0;
  const body = String(yearBlock || '').slice(bodyStart).replace(/\n*---\s*$/, '').trim();
  const matches = [...body.matchAll(/^### (\d{1,2})月\s*$/gm)];
  if (matches.length === 0) return `## ${year}年${body ? `\n\n${body}` : ''}`;
  const prefix = body.slice(0, matches[0].index).trim();
  const months = matches.map((match, index) => {
    const month = Number(match[1]);
    const sectionStart = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const sectionBody = body.slice(sectionStart, end).trim();
    return {
      month,
      text: `### ${month}月${sectionBody ? `\n\n${sortEntryBlocks(sectionBody, year, month)}` : ''}`,
    };
  }).sort((a, b) => b.month - a.month);
  return [`## ${year}年`, prefix, ...months.map(item => item.text)].filter(Boolean).join('\n\n');
}

function sortChronicleContent(content) {
  const text = String(content || '');
  const matches = [...text.matchAll(/^## (\d{4})年\s*$/gm)];
  if (matches.length === 0) return text;
  const prefix = text.slice(0, matches[0].index).replace(/\n*---\s*$/, '').trimEnd();
  const years = matches.map((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return {
      year: Number(match[1]),
      text: sortMonthBlocks(text.slice(match.index, end), Number(match[1])),
    };
  }).sort((a, b) => b.year - a.year);
  return `${prefix}\n\n---\n\n${years.map(item => item.text).join('\n\n---\n\n')}\n`;
}

function stripChronicleAnalysis(content) {
  return String(content || '')
    .split(/\r?\n/)
    .filter(line => !/^\s+- \*\*(?:为什么重要|意义)\*\*：/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function insertChronicleEntry(existingChronicle, rawEntry, {
  year,
  month,
  dateISO,
  dateStrCN,
  permalink = DEFAULT_CHRONICLE_PERMALINK,
}) {
  const entryText = normalizeChronicleEntry(rawEntry);
  if (!entryText || entryText.includes('无更新')) {
    return { updated: false, reason: 'empty-entry', content: existingChronicle || '', entryText };
  }

  const parsedEntryDate = extractChronicleEntryDate(entryText);
  const targetYear = parsedEntryDate?.year || year;
  const targetMonth = parsedEntryDate?.month || month;
  const targetDateStrCN = parsedEntryDate?.dateStrCN || dateStrCN;

  let content = existingChronicle || buildInitialChronicle({
    year: targetYear,
    month: targetMonth,
    dateISO,
    permalink,
  });
  content = ensureChroniclePermalink(content, permalink);

  const todayMarker = targetDateStrCN ? `**${targetDateStrCN}**` : '';

  // 同日已有条目 → 追加而不是跳过
  if (todayMarker && content.includes(todayMarker)) {
    const insertPoint = findInsertAfterExistingDateEntry(content, todayMarker);
    if (insertPoint > 0) {
      const merged = content.slice(0, insertPoint) + '\n' + entryText + '\n' + content.slice(insertPoint);
      return {
        updated: true,
        reason: 'appended-to-date',
        content: sortChronicleContent(updateChronicleDate(merged, dateISO)),
        entryText,
      };
    }
    // 如果找不到插入点（不应发生），保守回退到跳过
    return { updated: false, reason: 'date-exists-merge-failed', content, entryText };
  }

  const monthHeader = `### ${targetMonth}月`;
  const yearHeader = `## ${targetYear}年`;
  const yearIndex = content.indexOf(yearHeader);
  const yearSectionEnd = findYearSectionEnd(content, yearHeader, yearIndex);

  let updatedChronicle;

  if (yearIndex !== -1 && content.slice(yearIndex, yearSectionEnd).includes(monthHeader)) {
    const monthIndexInYear = content.indexOf(monthHeader, yearIndex);
    const afterMonth = monthIndexInYear + monthHeader.length;
    const nextBoundary = content.slice(afterMonth).search(/\n(?:## \d{4}年|### \d{1,2}月)/);
    const insertPoint = nextBoundary === -1 ? yearSectionEnd : afterMonth + nextBoundary;

    updatedChronicle = content.slice(0, insertPoint) + '\n' + entryText + '\n' + content.slice(insertPoint);
  } else if (yearIndex !== -1) {
    const yearSection = content.slice(yearIndex, yearSectionEnd);
    const monthRegex = /### (\d+)月/g;
    let insertAfter = yearIndex + yearHeader.length;
    let match;

    while ((match = monthRegex.exec(yearSection)) !== null) {
      const existingMonth = parseInt(match[1], 10);
      if (existingMonth < targetMonth) {
        const absPos = yearIndex + match.index;
        const afterExistingMonth = absPos + match[0].length;
        const nextBoundary = content.slice(afterExistingMonth).search(/\n(?:## \d{4}年|### \d{1,2}月)/);
        insertAfter = nextBoundary === -1 ? yearSectionEnd : afterExistingMonth + nextBoundary;
      }
    }

    updatedChronicle = content.slice(0, insertAfter) + '\n\n' + monthHeader + '\n' + entryText + '\n' + content.slice(insertAfter);
  } else {
    const firstYearMatch = content.match(/\n## \d{4}年/);
    if (firstYearMatch) {
      const insertAt = content.indexOf(firstYearMatch[0]);
      updatedChronicle = content.slice(0, insertAt) + '\n\n## ' + targetYear + '年\n\n' + monthHeader + '\n' + entryText + '\n' + content.slice(insertAt);
    } else {
      updatedChronicle = content + '\n## ' + targetYear + '年\n\n' + monthHeader + '\n' + entryText + '\n';
    }
  }

  return {
    updated: true,
    reason: 'inserted',
    content: sortChronicleContent(updateChronicleDate(updatedChronicle, dateISO)),
    entryText,
  };
}

function writeChronicleEntryArtifact(filePath, entryText) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entryText.trim()}\n`, 'utf-8');
}

module.exports = {
  DEFAULT_CHRONICLE_PERMALINK,
  ensureChroniclePermalink,
  insertChronicleEntry,
  normalizeChronicleEntry,
  sortChronicleContent,
  stripChronicleAnalysis,
  writeChronicleEntryArtifact,
};
