'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStatus, findLatestCompleteReportDate } = require('../tools/write-deploy-status');

test('latest deploy date requires both report types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-status-'));
  try {
    for (const name of [
      'ai-daily-2026-07-15.md',
      'society-daily-2026-07-15.md',
      'ai-daily-2026-07-16.md',
    ]) fs.writeFileSync(path.join(dir, name), 'test');
    assert.equal(findLatestCompleteReportDate(dir), '2026-07-15');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy marker contains stable report URLs and source commit', () => {
  const status = buildStatus({
    date: '2026-07-16',
    sourceCommit: 'ABCDEF1234567',
    deployedAt: '2026-07-16T08:00:00.000Z',
  });
  assert.equal(status.sourceCommit, 'abcdef1234567');
  assert.equal(status.reports.ai, '/2026/07/16/ai-daily-2026-07-16/');
  assert.equal(status.reports.society, '/2026/07/16/society-daily-2026-07-16/');
});
