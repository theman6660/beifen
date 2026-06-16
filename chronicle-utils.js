const fs = require('fs');
const path = require('path');

const DEFAULT_CHRONICLE_PERMALINK = '/ai-chronicle/';

function normalizeChronicleEntry(rawText) {
  return (rawText || '')
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^## /gm, '**##** ')
    .replace(/^### /gm, '**###** ')
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

  let content = existingChronicle || buildInitialChronicle({ year, month, dateISO, permalink });
  content = ensureChroniclePermalink(content, permalink);

  const todayMarker = dateStrCN ? `**${dateStrCN}**` : '';
  if (todayMarker && content.includes(todayMarker)) {
    return { updated: false, reason: 'date-exists', content, entryText };
  }

  const monthHeader = `### ${month}月`;
  const yearHeader = `## ${year}年`;
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
      if (existingMonth < month) {
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
      updatedChronicle = content.slice(0, insertAt) + '\n\n## ' + year + '年\n\n' + monthHeader + '\n' + entryText + '\n' + content.slice(insertAt);
    } else {
      updatedChronicle = content + '\n## ' + year + '年\n\n' + monthHeader + '\n' + entryText + '\n';
    }
  }

  return {
    updated: true,
    reason: 'inserted',
    content: updateChronicleDate(updatedChronicle, dateISO),
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
  writeChronicleEntryArtifact,
};
