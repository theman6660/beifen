const DEFAULT_REPO = 'theman6660/beifen';
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW = 'daily-report.yml';
const DEFAULT_API_BASE = 'https://api.github.com';

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').toLowerCase());
}

function getEnv(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function getBeijingDateISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((part) => part.type === 'year').value;
  const month = parts.find((part) => part.type === 'month').value;
  const day = parts.find((part) => part.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function getConfig(env, overrides = {}) {
  return {
    repo: overrides.repo || getEnv(env, 'DAILY_REPORT_REPO', DEFAULT_REPO),
    branch: overrides.branch || getEnv(env, 'DAILY_REPORT_BRANCH', DEFAULT_BRANCH),
    workflow: overrides.workflow || getEnv(env, 'DAILY_REPORT_WORKFLOW', DEFAULT_WORKFLOW),
    date: overrides.date || getEnv(env, 'BJ_DATE', getBeijingDateISO()),
    apiBase: getEnv(env, 'GITHUB_API_URL', DEFAULT_API_BASE).replace(/\/$/, ''),
    token: getEnv(env, 'GITHUB_TOKEN', getEnv(env, 'GH_TOKEN')),
    dryRun: Boolean(overrides.dryRun) || isTruthy(getEnv(env, 'SENTINEL_DRY_RUN', getEnv(env, 'DRY_RUN'))),
  };
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(config, path, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'personal-website-daily-report-sentinel',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const response = await fetch(`${config.apiBase}${path}`, {
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

  return {
    ok: true,
    status: response.status,
    data: text ? JSON.parse(text) : null,
    text,
  };
}

async function fileExists(config, path) {
  const encoded = encodePath(path);
  const result = await githubRequest(
    config,
    `/repos/${config.repo}/contents/${encoded}?ref=${encodeURIComponent(config.branch)}`,
  );
  return result.ok;
}

async function countRuns(config, status) {
  const query = new URLSearchParams({
    branch: config.branch,
    status,
    per_page: '20',
  });
  const result = await githubRequest(
    config,
    `/repos/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?${query}`,
  );
  return Array.isArray(result.data?.workflow_runs) ? result.data.workflow_runs.length : 0;
}

async function dispatchWorkflow(config) {
  await githubRequest(config, `/repos/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: config.branch }),
  });
}

async function runSentinel(env, overrides = {}) {
  const config = getConfig(env, overrides);
  const aiPath = `source/_posts/ai-daily-${config.date}.md`;
  const societyPath = `source/_posts/society-daily-${config.date}.md`;

  const [hasAi, hasSociety] = await Promise.all([
    fileExists(config, aiPath),
    fileExists(config, societyPath),
  ]);

  const result = {
    repo: config.repo,
    branch: config.branch,
    workflow: config.workflow,
    date: config.date,
    dryRun: config.dryRun,
    posts: {
      ai: { path: aiPath, exists: hasAi },
      society: { path: societyPath, exists: hasSociety },
    },
    dispatched: false,
    skippedReason: '',
  };

  if (hasAi && hasSociety) {
    result.skippedReason = 'posts_already_exist';
    return result;
  }

  if (config.dryRun) {
    result.skippedReason = 'dry_run';
    return result;
  }

  if (!config.token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to inspect active runs and dispatch the workflow.');
  }

  const [queued, inProgress] = await Promise.all([
    countRuns(config, 'queued'),
    countRuns(config, 'in_progress'),
  ]);
  const activeRuns = queued + inProgress;
  result.activeRuns = { queued, inProgress, total: activeRuns };

  if (activeRuns > 0) {
    result.skippedReason = 'workflow_already_active';
    return result;
  }

  await dispatchWorkflow(config);
  result.dispatched = true;
  return result;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isAuthorized(request, env) {
  const token = getEnv(env, 'MANUAL_TRIGGER_TOKEN');
  if (!token) return false;
  return request.headers.get('authorization') === `Bearer ${token}`;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await runSentinel(env, { cron: controller.cron });
      console.log(JSON.stringify({ event: 'daily-report-sentinel', ...result }));
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'daily-report-sentinel' });
    }

    if (url.pathname !== '/run') {
      return jsonResponse({ ok: false, error: 'not_found' }, 404);
    }

    const dryRun = isTruthy(url.searchParams.get('dryRun'));
    if (!dryRun && !isAuthorized(request, env)) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    }

    const result = await runSentinel(env, {
      date: url.searchParams.get('date') || undefined,
      dryRun,
    });
    return jsonResponse({ ok: true, result });
  },
};

export { getBeijingDateISO, runSentinel };
