'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'daily-report.yml');

function extractJob(workflow, jobName, nextJobName) {
  const startMarker = `  ${jobName}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const end = nextJobName ? workflow.indexOf(`  ${nextJobName}:\n`, start + startMarker.length) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextJobName} job after ${jobName}`);
  return workflow.slice(start, end);
}

test('daily-report jobs use one pinned preflight source commit', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const pinnedCheckout = 'ref: ${{ needs.preflight.outputs.source_sha }}';
  const aiJob = extractJob(workflow, 'ai-daily', 'society-daily');
  const societyJob = extractJob(workflow, 'society-daily', 'commit-source');
  const commitJob = extractJob(workflow, 'commit-source', 'deploy-site');

  assert.match(workflow, /source_sha:\s+\$\{\{\s*steps\.source\.outputs\.sha\s*\}\}/);
  assert.match(
    workflow,
    /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/,
  );
  assert.match(workflow, /source_sha="\$\(git rev-parse refs\/remotes\/origin\/main\)"/);
  for (const [name, job] of [['ai-daily', aiJob], ['society-daily', societyJob], ['commit-source', commitJob]]) {
    assert.equal(job.split(pinnedCheckout).length - 1, 1, `${name} must checkout the preflight SHA exactly once`);
  }
  assert.doesNotMatch(workflow, /git pull --ff-only origin main/);
  assert.match(commitJob, /actual_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(commitJob, /if \[ "\$actual_sha" != "\$SOURCE_SHA" \]/);
  assert.match(commitJob, /if \[ "\$current_sha" != "\$SOURCE_SHA" \]/);
  assert.ok(
    commitJob.indexOf('Refuse artifacts generated from stale source')
      < commitJob.indexOf('actions/download-artifact@v8'),
    'stale-source guard must run before generated artifacts are applied',
  );
});
