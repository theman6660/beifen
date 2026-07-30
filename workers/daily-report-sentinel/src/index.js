const DEFAULT_REPO = 'theman6660/beifen';
const DEFAULT_BRANCH = 'main';
const DEFAULT_SOURCE_WORKFLOW = 'daily-report.yml';
const DEFAULT_REDEPLOY_WORKFLOW = 'manual-site-redeploy.yml';
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_LIVE_SITE = 'https://hanxiaofan.site';
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').toLowerCase());
}

function getEnv(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function getBeijingDateISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function getConfig(env, overrides = {}) {
  return {
    repo: overrides.repo || getEnv(env, 'DAILY_REPORT_REPO', DEFAULT_REPO),
    branch: overrides.branch || getEnv(env, 'DAILY_REPORT_BRANCH', DEFAULT_BRANCH),
    sourceWorkflow: overrides.sourceWorkflow || getEnv(env, 'DAILY_REPORT_WORKFLOW', DEFAULT_SOURCE_WORKFLOW),
    redeployWorkflow: overrides.redeployWorkflow || getEnv(env, 'DAILY_REPORT_REDEPLOY_WORKFLOW', DEFAULT_REDEPLOY_WORKFLOW),
    liveSiteUrl: getEnv(env, 'LIVE_SITE_URL', DEFAULT_LIVE_SITE).replace(/\/$/, ''),
    date: overrides.date || getEnv(env, 'BJ_DATE', getBeijingDateISO()),
    apiBase: getEnv(env, 'GITHUB_API_URL', DEFAULT_API_BASE).replace(/\/$/, ''),
    token: getEnv(env, 'GITHUB_TOKEN', getEnv(env, 'GH_TOKEN')),
    dryRun: Boolean(overrides.dryRun) || isTruthy(getEnv(env, 'SENTINEL_DRY_RUN', getEnv(env, 'DRY_RUN'))),
  };
}

function encodePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function githubRequest(config, requestPath, options = {}) {
  const {
    allowNotFound = false,
    headers: optionHeaders = {},
    ...fetchOptions
  } = options;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'personal-website-daily-report-sentinel',
    'X-GitHub-Api-Version': '2022-11-28',
    ...optionHeaders,
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const response = await fetchWithTimeout(`${config.apiBase}${requestPath}`, { ...fetchOptions, headers });
  const text = await response.text();
  if (response.status === 404 && allowNotFound) {
    return { ok: false, status: 404, data: null, text };
  }
  if (!response.ok) {
    const body = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    throw new Error(`GitHub API ${fetchOptions.method || 'GET'} ${requestPath} failed: ${response.status} ${body}`);
  }
  return { ok: true, status: response.status, data: text ? JSON.parse(text) : null, text };
}

async function fileExists(config, filePath) {
  const result = await githubRequest(
    config,
    `/repos/${config.repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(config.branch)}`,
    { allowNotFound: true },
  );
  return result.ok;
}

async function getSourceCommit(config) {
  const result = await githubRequest(config, `/repos/${config.repo}/commits/${encodeURIComponent(config.branch)}`);
  const sha = result.data?.sha || '';
  if (!sha) throw new Error(`GitHub API returned no commit SHA for ${config.repo}@${config.branch}`);
  return sha;
}

async function countRuns(config, workflow, status) {
  const query = new URLSearchParams({ branch: config.branch, status, per_page: '20' });
  const result = await githubRequest(
    config,
    `/repos/${config.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`,
  );
  return Array.isArray(result.data?.workflow_runs) ? result.data.workflow_runs.length : 0;
}

async function dispatchWorkflow(config, workflow, inputs = undefined) {
  const result = await githubRequest(config, `/repos/${config.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: config.branch, ...(inputs ? { inputs } : {}) }),
  });
  if (result.status !== 204) {
    throw new Error(`GitHub workflow dispatch returned unexpected status ${result.status} for ${workflow}`);
  }
}

async function readLiveMarker(config) {
  try {
    const response = await fetchWithTimeout(`${config.liveSiteUrl}/daily-report-status.json?sentinel=${Date.now()}`, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function livePageExists(url) {
  try {
    let response = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' });
    if (response.status === 405) {
      response = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' });
    }
    return response.ok;
  } catch {
    return false;
  }
}

async function getLiveState(config, sourceCommit) {
  const [year, month, day] = config.date.split('-');
  const aiUrl = `${config.liveSiteUrl}/${year}/${month}/${day}/ai-daily-${config.date}/`;
  const societyUrl = `${config.liveSiteUrl}/${year}/${month}/${day}/society-daily-${config.date}/`;
  const [marker, ai, society] = await Promise.all([
    readLiveMarker(config), livePageExists(aiUrl), livePageExists(societyUrl),
  ]);
  const markerCurrent = marker?.date === config.date && marker?.sourceCommit === sourceCommit;
  return { marker, markerCurrent, ai, society, current: markerCurrent && ai && society };
}

async function runSentinel(env, overrides = {}) {
  const config = getConfig(env, overrides);
  const aiPath = `source/_posts/ai-daily-${config.date}.md`;
  const societyPath = `source/_posts/society-daily-${config.date}.md`;
  const sourceCommit = await getSourceCommit(config);
  const [hasAi, hasSociety] = await Promise.all([fileExists(config, aiPath), fileExists(config, societyPath)]);
  const result = {
    repo: config.repo,
    branch: config.branch,
    date: config.date,
    dryRun: config.dryRun,
    sourceCommit,
    posts: { ai: { path: aiPath, exists: hasAi }, society: { path: societyPath, exists: hasSociety } },
    action: '',
    workflow: '',
    dispatched: false,
    skippedReason: '',
  };

  let workflow;
  let inputs;
  if (!hasAi || !hasSociety) {
    result.action = 'generate';
    workflow = config.sourceWorkflow;
  } else {
    const deployment = await getLiveState(config, sourceCommit);
    result.deployment = deployment;
    if (deployment.current) {
      result.skippedReason = 'source_and_live_deployment_current';
      return result;
    }
    result.action = 'redeploy';
    workflow = config.redeployWorkflow;
    inputs = { ref: config.branch, reason: `Cloudflare sentinel recovery for ${config.date}` };
  }
  result.workflow = workflow;

  if (config.dryRun) {
    result.skippedReason = 'dry_run';
    return result;
  }
  if (!config.token) throw new Error('GITHUB_TOKEN or GH_TOKEN is required to inspect active runs and dispatch recovery.');

  const countWorkflow = async (name) => {
    const [queued, inProgress] = await Promise.all([
      countRuns(config, name, 'queued'), countRuns(config, name, 'in_progress'),
    ]);
    return { queued, inProgress, total: queued + inProgress };
  };
  const active = await countWorkflow(workflow);
  if (result.action === 'redeploy') {
    const generation = await countWorkflow(config.sourceWorkflow);
    active.queued += generation.queued;
    active.inProgress += generation.inProgress;
    active.total += generation.total;
  }
  result.activeRuns = active;
  if (active.total > 0) {
    result.skippedReason = 'recovery_already_active';
    return result;
  }

  await dispatchWorkflow(config, workflow, inputs);
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
  return Boolean(token) && request.headers.get('authorization') === `Bearer ${token}`;
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
    if (url.pathname === '/health') return jsonResponse({ ok: true, service: 'daily-report-sentinel' });
    if (url.pathname !== '/run') return jsonResponse({ ok: false, error: 'not_found' }, 404);
    const dryRun = isTruthy(url.searchParams.get('dryRun'));
    if (!dryRun && !isAuthorized(request, env)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    const result = await runSentinel(env, { date: url.searchParams.get('date') || undefined, dryRun });
    return jsonResponse({ ok: true, result });
  },
};

export { fetchWithTimeout, getBeijingDateISO, runSentinel };
