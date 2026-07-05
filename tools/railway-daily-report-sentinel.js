#!/usr/bin/env node

const { beijingDateISO } = require('../lib/date-utils');

const DEFAULT_REPO = 'theman6660/beifen';
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW = 'daily-report.yml';
const DEFAULT_API_BASE = 'https://api.github.com';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').toLowerCase());
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function getConfig() {
  const args = parseArgs(process.argv);
  return {
    repo: args.repo || env('DAILY_REPORT_REPO', DEFAULT_REPO),
    branch: args.branch || env('DAILY_REPORT_BRANCH', DEFAULT_BRANCH),
    workflow: args.workflow || env('DAILY_REPORT_WORKFLOW', DEFAULT_WORKFLOW),
    date: args.date || env('BJ_DATE', beijingDateISO()),
    apiBase: env('GITHUB_API_URL', DEFAULT_API_BASE).replace(/\/$/, ''),
    token: env('GITHUB_TOKEN', env('GH_TOKEN')),
    dryRun: Boolean(args['dry-run']) || isTruthy(env('SENTINEL_DRY_RUN', env('DRY_RUN'))),
  };
}

function createGitHubClient(config) {
  async function request(path, options = {}) {
    const url = `${config.apiBase}${path}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'personal-website-daily-report-sentinel',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    };

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });
    const text = await response.text();

    if (response.status === 404) {
      return { ok: false, status: 404, data: null, text };
    }

    if (!response.ok) {
      const body = text.length > 500 ? `${text.slice(0, 500)}...` : text;
      throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${response.status} ${body}`);
    }

    if (!text) {
      return { ok: true, status: response.status, data: null, text: '' };
    }

    return { ok: true, status: response.status, data: JSON.parse(text), text };
  }

  return { request };
}

async function fileExists(client, config, path) {
  const encoded = encodePath(path);
  const result = await client.request(`/repos/${config.repo}/contents/${encoded}?ref=${encodeURIComponent(config.branch)}`);
  return result.ok;
}

async function countRuns(client, config, status) {
  const query = new URLSearchParams({
    branch: config.branch,
    status,
    per_page: '20',
  });
  const result = await client.request(`/repos/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?${query}`);
  return Array.isArray(result.data.workflow_runs) ? result.data.workflow_runs.length : 0;
}

async function dispatchWorkflow(client, config) {
  await client.request(`/repos/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: config.branch }),
  });
}

async function main() {
  const config = getConfig();
  const client = createGitHubClient(config);
  const aiPath = `source/_posts/ai-daily-${config.date}.md`;
  const societyPath = `source/_posts/society-daily-${config.date}.md`;

  console.log(`[sentinel] repo=${config.repo} branch=${config.branch} workflow=${config.workflow}`);
  console.log(`[sentinel] date=${config.date} dryRun=${config.dryRun}`);

  const [hasAi, hasSociety] = await Promise.all([
    fileExists(client, config, aiPath),
    fileExists(client, config, societyPath),
  ]);

  console.log(`[sentinel] ai=${hasAi} path=${aiPath}`);
  console.log(`[sentinel] society=${hasSociety} path=${societyPath}`);

  if (hasAi && hasSociety) {
    console.log("[sentinel] OK: today's posts already exist; no dispatch needed.");
    return;
  }

  if (config.dryRun) {
    console.log(`[sentinel] Dry run: would inspect active runs and dispatch ${config.workflow}.`);
    return;
  }

  if (!config.token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to inspect active runs and dispatch the workflow.');
  }

  const [queued, inProgress] = await Promise.all([
    countRuns(client, config, 'queued'),
    countRuns(client, config, 'in_progress'),
  ]);
  const active = queued + inProgress;

  console.log(`[sentinel] active daily-report runs: queued=${queued} in_progress=${inProgress}`);

  if (active > 0) {
    console.log('[sentinel] Skip dispatch: a workflow run is already queued or in progress.');
    return;
  }

  await dispatchWorkflow(client, config);
  console.log(`[sentinel] Dispatched ${config.workflow} for ${config.date}.`);
}

main().catch((err) => {
  console.error(`[sentinel] ERROR: ${err.stack || err.message || String(err)}`);
  process.exit(1);
});
