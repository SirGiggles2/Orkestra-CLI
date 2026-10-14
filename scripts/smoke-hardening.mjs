import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'orkestra-http-smoke-'));
const port = 18987;
let child;
const start = async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    env: { ...process.env, ORKESTRA_HOST: '127.0.0.1', ORKESTRA_PORT: String(port), ORKESTRA_DATA_DIR: join(root, 'data'), ORKESTRA_WORKSPACE_DIR: join(root, 'ws'), ORKESTRA_API_PROVIDERS: '', ORKESTRA_ENABLE_LOCAL_TERMINAL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(`Server failed to start: ${log}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Server startup timeout: ${log}`);
};
const request = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close'); child.kill(); await closed;
};

try {
  await start();
  const health = await (await request('/api/health')).json();
  assert.equal(health.execution.workerIdentity, 'current-account');
  assert.equal(health.execution.isolation, 'provider-native');
  assert.equal((await request('/')).status, 200, 'built React app is served');
  assert.equal((await request('/api/health', undefined, { Origin: 'https://evil.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolveStatus, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/health', headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolveStatus(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await request('/api/terminals', {})).status, 403);
  assert.equal((await request('/api/runs', { prompt: 'test', tasks: [{ id: 'a', title: 'A', dependsOn: ['a'] }] })).status, 400);
  assert.equal((await request('/api/runs', { prompt: 'test', workspacePath: root })).status, 403);
  assert.equal((await request('/api/runs', { prompt: 'test', permission: 'workspace-write' })).status, 400);
  const created = await request('/api/runs', { prompt: 'Harmless dry-run investigation', tasks: [{ id: 'a', title: 'Investigate' }] });
  assert.equal(created.status, 201);
  const run = await created.json();
  assert.equal((await request('/api/runs', { prompt: 'concurrent', workspacePath: run.workspacePath })).status, 409);
  let detail;
  for (let i = 0; i < 100; i++) {
    detail = await (await request(`/api/runs/${run.id}`)).json();
    if (detail.status === 'completed' || detail.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(detail.executionState, 'COMPLETED_UNVERIFIED');
  assert.ok(detail.events.some((e) => e.type === 'stdout'));
  for (const artifact of ['.git', 'PROMPT.md', 'TRANSCRIPT.md', '.orkestra-phase.json']) assert.equal(existsSync(join(run.workspacePath, artifact)), false, `read-only workspace has no ${artifact}`);
  assert.equal((await request(`/api/runs/${run.id}/apply`, {})).status, 409);
  assert.equal((await request(`/api/runs/${run.id}/resume`, {})).status, 409);
  await stop(); await start();
  const persisted = await (await request(`/api/runs/${run.id}`)).json();
  assert.equal(persisted.executionState, 'COMPLETED_UNVERIFIED');
  assert.equal(persisted.summary, detail.summary);
  console.log('PASS: Windows startup, React serving, origin/host rejection, terminal gate, DAG/path/permission validation, workspace exclusion, read-only dry run, missing approvals, persisted history after restart.');
} finally {
  await stop();
  // root is the exact directory returned by mkdtemp, under the system temp directory.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
  rmSync(root, { recursive: true, force: true });
}
