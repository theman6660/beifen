'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('node:url');

const sentinelUrl = pathToFileURL(
  path.join(__dirname, '..', 'workers', 'daily-report-sentinel', 'src', 'index.js'),
).href;

const SOURCE_SHA = 'a'.repeat(40);
const TEST_ENV = {
  DAILY_REPORT_REPO: 'example/site',
  DAILY_REPORT_BRANCH: 'main',
  DAILY_REPORT_WORKFLOW: 'daily-report.yml',
  DAILY_REPORT_REDEPLOY_WORKFLOW: 'manual-site-redeploy.yml',
  LIVE_SITE_URL: 'https://site.example',
  GITHUB_API_URL: 'https://api.example',
  GITHUB_TOKEN: 'test-token',
};

function response(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function githubSuccessOrMissingFiles(url, options = {}) {
  const requestUrl = new URL(url);
  if (requestUrl.pathname.endsWith('/commits/main')) {
    return response({ sha: SOURCE_SHA });
  }
  if (requestUrl.pathname.includes('/contents/')) {
    return response({ message: 'Not Found' }, 404);
  }
  if (requestUrl.pathname.endsWith('/runs')) {
    return response({ workflow_runs: [] });
  }
  if (requestUrl.pathname.endsWith('/dispatches') && options.method === 'POST') {
    return response(null, 204);
  }
  throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
}

async function withMockFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('daily-report sentinel GitHub error handling', async (t) => {
  const { fetchWithTimeout, runSentinel } = await import(sentinelUrl);

  await t.test('aborts a hanging external request at the configured deadline', async () => {
    await assert.rejects(
      withMockFetch((url, options = {}) => new Promise((resolve, reject) => {
        const testDeadline = setTimeout(() => reject(new Error('timeout signal did not abort the request')), 100);
        options.signal.addEventListener('abort', () => {
          clearTimeout(testDeadline);
          reject(options.signal.reason);
        }, { once: true });
      }), () => fetchWithTimeout('https://api.example/hang', {}, 5)),
      error => error?.name === 'TimeoutError',
    );
  });

  await t.test('treats content 404 as a missing post and dispatches generation', async () => {
    const requests = [];
    const result = await withMockFetch(async (url, options = {}) => {
      requests.push({ url, options });
      return githubSuccessOrMissingFiles(url, options);
    }, () => runSentinel(TEST_ENV, { date: '2026-07-30' }));

    assert.equal(result.action, 'generate');
    assert.equal(result.posts.ai.exists, false);
    assert.equal(result.posts.society.exists, false);
    assert.equal(result.dispatched, true);
    assert.equal(result.sourceCommit, SOURCE_SHA);
    assert.ok(requests.length >= 6);
    for (const request of requests) {
      assert.ok(request.options.signal instanceof AbortSignal, `missing timeout signal for ${request.url}`);
      assert.equal('allowNotFound' in request.options, false);
    }
  });

  await t.test('rejects a repository or branch 404 before checking post files', async () => {
    const requests = [];
    await assert.rejects(
      withMockFetch(async (url, options = {}) => {
        requests.push({ url, options });
        return response({ message: 'Not Found' }, 404);
      }, () => runSentinel(TEST_ENV, { date: '2026-07-30' })),
      /commits\/main failed: 404/,
    );
    assert.equal(requests.length, 1);
  });

  await t.test('rejects a commit response without a SHA', async () => {
    await assert.rejects(
      withMockFetch(async () => response({}), () => runSentinel(TEST_ENV, { date: '2026-07-30' })),
      /returned no commit SHA/,
    );
  });

  await t.test('rejects a workflow-runs 404 instead of treating it as no active run', async () => {
    await assert.rejects(
      withMockFetch(async (url, options = {}) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname.endsWith('/runs')) {
          return response({ message: 'Not Found' }, 404);
        }
        return githubSuccessOrMissingFiles(url, options);
      }, () => runSentinel(TEST_ENV, { date: '2026-07-30' })),
      /actions\/workflows\/daily-report\.yml\/runs.*failed: 404/,
    );
  });

  await t.test('rejects a dispatch 404 and never returns a false success', async () => {
    await assert.rejects(
      withMockFetch(async (url, options = {}) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname.endsWith('/dispatches')) {
          return response({ message: 'Not Found' }, 404);
        }
        return githubSuccessOrMissingFiles(url, options);
      }, () => runSentinel(TEST_ENV, { date: '2026-07-30' })),
      /dispatches failed: 404/,
    );
  });

  await t.test('rejects an unexpected successful dispatch status', async () => {
    await assert.rejects(
      withMockFetch(async (url, options = {}) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname.endsWith('/dispatches')) {
          return response({ accepted: true }, 200);
        }
        return githubSuccessOrMissingFiles(url, options);
      }, () => runSentinel(TEST_ENV, { date: '2026-07-30' })),
      /unexpected status 200/,
    );
  });

  await t.test('adds timeout signals to live marker and report page HEAD/GET checks', async () => {
    const liveRequests = [];
    const result = await withMockFetch(async (url, options = {}) => {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === 'api.example') {
        if (requestUrl.pathname.endsWith('/commits/main')) return response({ sha: SOURCE_SHA });
        if (requestUrl.pathname.includes('/contents/')) return response({ name: 'post.md' });
      }
      if (requestUrl.hostname === 'site.example') {
        liveRequests.push({ url, options });
        if (requestUrl.pathname === '/daily-report-status.json') {
          return response({ date: '2026-07-30', sourceCommit: SOURCE_SHA });
        }
        if (options.method === 'HEAD') return response({ message: 'Method Not Allowed' }, 405);
        return response(null);
      }
      throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
    }, () => runSentinel(TEST_ENV, { date: '2026-07-30' }));

    assert.equal(result.deployment.current, true);
    assert.equal(result.dispatched, false);
    assert.equal(liveRequests.length, 5);
    assert.equal(liveRequests.filter(request => request.options.method === 'HEAD').length, 2);
    assert.equal(liveRequests.filter(request => request.options.method === 'GET').length, 2);
    for (const request of liveRequests) {
      assert.ok(request.options.signal instanceof AbortSignal, `missing timeout signal for ${request.url}`);
    }
  });
});
