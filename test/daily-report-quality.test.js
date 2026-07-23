'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractPublishedAt,
  formatNewsItemForPrompt,
  interpretQualityResponse,
  isPublishedWithin,
} = require('../lib/daily-report-quality');

test('official page publication date is parsed from escaped Anthropic data', () => {
  const html = String.raw`<script>self.__next_f.push(["{\"publishedOn\":\"2026-04-16T14:30:00.000Z\"}"])</script>`;
  assert.equal(extractPublishedAt(html), '2026-04-16T14:30:00.000Z');
});

test('official page publication date falls back to JSON-LD or article metadata', () => {
  assert.equal(
    extractPublishedAt('<script type="application/ld+json">{"datePublished":"2026-07-23T01:00:00Z"}</script>'),
    '2026-07-23T01:00:00Z',
  );
  assert.equal(
    extractPublishedAt('<meta property="article:published_time" content="2026-07-22T17:00:00Z">'),
    '2026-07-22T17:00:00Z',
  );
});

test('recent sitemap modification cannot make an old publication current', () => {
  const earliest = new Date('2026-07-22T00:00:00Z');
  const latest = new Date('2026-07-24T00:00:00Z');
  assert.equal(isPublishedWithin('2026-04-16T14:30:00Z', earliest, latest), false);
  assert.equal(isPublishedWithin('2026-07-22T17:00:00Z', earliest, latest), true);
  assert.equal(isPublishedWithin('', earliest, latest), false);
});

test('news prompt includes the real publication date', () => {
  const promptItem = formatNewsItemForPrompt({
    source: 'Anthropic Official',
    title: 'Claude Sonnet 5',
    date: '2026-07-22T01:20:28Z',
    link: 'https://www.anthropic.com/news/claude-sonnet-5',
    snippet: 'Official release',
  }, 0);
  assert.match(promptItem, /发布日期: 2026-07-22T01:20:28Z/);
});

test('quality evaluator fails closed on empty or unrecognized output', () => {
  assert.deepEqual(interpretQualityResponse(''), {
    pass: false,
    reason: '质检模型返回空内容',
  });
  assert.equal(interpretQualityResponse('PASS').pass, true);
  assert.equal(interpretQualityResponse('FAIL: duplicated event').pass, false);
  assert.equal(interpretQualityResponse('looks okay').pass, false);
});
