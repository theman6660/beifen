'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getProviders } = require('../lib/llm-client');

test('getProviders resolves Gemini provider when GEMINI_API_KEY is present', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.AUTH_TOKEN;
    delete process.env.BASE_URL;
    delete process.env.MODEL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    const providers = getProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, 'Gemini');
    assert.equal(providers[0].apiKey, 'test-gemini-key');
    assert.ok(providers[0].models.includes('gemini-2.5-flash'));
    assert.ok(providers[0].models.includes('gemini-2.0-flash'));
  } finally {
    process.env = originalEnv;
  }
});

test('getProviders resolves dual providers when both keys are present', () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.AUTH_TOKEN;
    delete process.env.BASE_URL;
    delete process.env.MODEL;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

    const providers = getProviders();
    assert.equal(providers.length, 2);
    assert.equal(providers[0].name, 'Gemini');
    assert.equal(providers[1].name, 'DeepSeek');
    assert.equal(providers[1].apiKey, 'test-deepseek-key');
    assert.ok(providers[1].models.includes('deepseek-chat'));
  } finally {
    process.env = originalEnv;
  }
});
