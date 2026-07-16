'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSnippetInput, parseSnippetPayload, validateDateStr } = require('../diary-generator');

test('secret payload date is authoritative', () => {
  const input = loadSnippetInput({
    env: {
      DIARY_SNIPPETS_JSON: JSON.stringify({
        date: '2026-07-15',
        snippets: [{ time: '09:00', reply: '完成测试' }],
      }),
    },
    argv: [],
  });
  assert.equal(input.date, '2026-07-15');
  assert.equal(input.source, 'DIARY_SNIPPETS_JSON');
});

test('secret payload cannot silently inherit the runner date', () => {
  assert.throws(
    () => parseSnippetPayload('[{"time":"09:00","reply":"x"}]', { requireDate: true }),
    /必须是/,
  );
});

test('calendar dates are validated, not only filename shape', () => {
  assert.doesNotThrow(() => validateDateStr('2024-02-29'));
  assert.throws(() => validateDateStr('2026-02-30'), /不存在/);
});
