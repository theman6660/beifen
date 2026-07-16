'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  insertChronicleEntry,
  sortChronicleContent,
  stripChronicleAnalysis,
} = require('../chronicle-utils');
const {
  buildChronicleEntry,
  extractChronicleEntryDate,
  parseDailySourceItems,
  parseJsonObject,
  splitChronicleEntries,
  validateChronicleCandidate,
  validateChronicleEntry,
} = require('../lib/chronicle-quality');

const evidence = [
  {
    source: 'Anthropic Official',
    title: 'Claude changes how long-running agents work',
    link: 'https://www.anthropic.com/news/agent-update',
  },
  {
    source: 'TechCrunch',
    title: 'Anthropic launches a new agent system',
    link: 'https://techcrunch.com/example/anthropic-agent',
  },
];

const candidate = {
  eventDate: '2026年7月15日',
  event: 'Anthropic正式发布可持续执行长时间任务的新一代Claude智能体系统',
  why: '这使模型从短轮次应答转向可持续完成真实工作的执行系统，改变了AI产品与知识工作的结合方式。',
  sourceIds: [1, 2],
};

test('chronicle JSON accepts fenced model output', () => {
  const parsed = parseJsonObject('```json\n{"candidates":[]}\n```');
  assert.deepEqual(parsed, { candidates: [] });
});

test('official primary source can pass while an unsupported single media source cannot', () => {
  assert.equal(validateChronicleCandidate({ ...candidate, sourceIds: [1] }, evidence).pass, true);
  const result = validateChronicleCandidate({ ...candidate, sourceIds: [2] }, evidence);
  assert.equal(result.pass, false);
  assert.match(result.reason, /独立来源|官方/);
});

test('expanded official research and policy sources can stand as primary evidence', () => {
  for (const source of ['Microsoft Research', 'Apple ML Research', 'Berkeley AI Research', 'UK AI Security Institute', 'NIST']) {
    const result = validateChronicleCandidate({ ...candidate, sourceIds: [1] }, [{
      source,
      title: 'A documented AI milestone',
      link: `https://example.com/${encodeURIComponent(source)}`,
    }]);
    assert.equal(result.pass, true, source);
  }
});

test('two links from the same non-official source are not independent evidence', () => {
  const sameSourceEvidence = [
    { source: 'arXiv cs.AI', title: 'Paper one', link: 'https://arxiv.org/abs/2607.00001' },
    { source: 'arXiv cs.AI', title: 'Paper two', link: 'https://arxiv.org/abs/2607.00002' },
  ];
  const result = validateChronicleCandidate({ ...candidate, sourceIds: [1, 2] }, sameSourceEvidence);
  assert.equal(result.pass, false);
  assert.match(result.reason, /独立来源/);
});

test('chronicle event prose stays concise', () => {
  const result = validateChronicleCandidate({
    ...candidate,
    event: '这是一段已经发生但被不必要地写得过长的事件描述。'.repeat(12),
    sourceIds: [1],
  }, evidence);
  assert.equal(result.pass, false);
  assert.match(result.reason, /过长|简洁风格/);
});

test('code renders a complete cited entry and rejects truncated prose', () => {
  const entry = buildChronicleEntry(candidate, evidence);
  assert.equal(validateChronicleEntry(entry).pass, true);
  assert.doesNotMatch(entry, /为什么重要|\*\*意义\*\*/);
  const truncated = '- **2026年7月11日**：中国首个十万卡算力集群正式落成，完全基于国产';
  assert.equal(validateChronicleEntry(truncated).pass, false);
});

test('daily report references become rolling chronicle evidence', () => {
  const markdown = [
    '## 参考来源',
    '',
    '- [OpenAI News] [A major release](https://openai.com/index/major-release)',
    '- [The Verge] [Independent report](https://www.theverge.com/example)',
  ].join('\n');
  const items = parseDailySourceItems(markdown, '2026-07-10');
  assert.equal(items.length, 2);
  assert.equal(items[0].source, 'OpenAI News');
  assert.equal(items[0]._timestamp, new Date('2026-07-10T12:00:00+08:00').getTime());
});

test('multi-entry artifacts split cleanly and use each event date for placement', () => {
  const first = buildChronicleEntry(candidate, evidence);
  const second = buildChronicleEntry({
    ...candidate,
    eventDate: '2026年6月30日',
    event: 'OpenAI正式发布改变智能体工具调用方式的新接口与执行环境',
  }, evidence);
  const entries = splitChronicleEntries(`${first}\n\n${second}`);
  assert.equal(entries.length, 2);
  assert.deepEqual(extractChronicleEntryDate(second), {
    year: 2026,
    month: 6,
    dateStrCN: '2026年6月30日',
  });

  const base = `---\ntitle: test\ndate: 2026-07-16 08:00:00\n---\n\n## 2026年\n\n### 7月\n`;
  const result = insertChronicleEntry(base, second, {
    year: 2026,
    month: 7,
    dateISO: '2026-07-16',
    dateStrCN: '2026年7月16日',
  });
  assert.equal(result.updated, true);
  assert.match(result.content, /### 7月[\s\S]*### 6月[\s\S]*2026年6月30日/);
});

test('chronicle normalization removes visible analysis and sorts newest first', () => {
  const input = `---\ntitle: test\ndate: 2026-07-16 08:00:00\n---\n\n# title\n\n---\n\n## 2025年\n\n### 1月\n\n- **2025年1月1日**：旧事件。\n  - **为什么重要**：旧分析。\n\n## 2026年\n\n### 6月\n\n- **2026年6月11日**：较早事件。\n  - **意义**：较早分析。\n\n- **2026年6月11-12日**：较新事件。\n\n### 7月\n\n- **2026年7月1日**：最新事件。\n`;
  const normalized = sortChronicleContent(stripChronicleAnalysis(input));
  assert.doesNotMatch(normalized, /为什么重要|\*\*意义\*\*/);
  assert.ok(normalized.indexOf('## 2026年') < normalized.indexOf('## 2025年'));
  assert.ok(normalized.indexOf('### 7月') < normalized.indexOf('### 6月'));
  assert.ok(normalized.indexOf('6月11-12日') < normalized.indexOf('6月11日'));
});
