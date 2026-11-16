import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WorkerLink } from './link.mjs';

const fakeAgent = `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync('agent-arguments.log', JSON.stringify({ argv: process.argv.slice(2), prompt, leaked: !!process.env.SUPERAGENT_WORKER_TOKEN }) + '\\n');
const emit = (item) => console.log(JSON.stringify(item));
if (prompt === 'auth') { console.error('Please log in'); process.exitCode = 1; }
else {
  const codex = process.argv[2] === 'exec';
  emit(codex ? { type: 'thread.started', thread_id: 'session-1' } : { type: 'system', subtype: 'init', session_id: 'session-1' });
  emit({ type: 'item.started' });
  if (prompt === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    appendFileSync('child-pid.log', String(child.pid));
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  emit(codex ? { type: 'item.completed', item: { type: 'agent_message', text: 'Result: ' + prompt } }
    : { type: 'result', result: 'Result: ' + prompt });
}
`;

async function fixture(t, agent = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake.mjs');
  await writeFile(executable, fakeAgent);
  const stateFile = join(directory, 'state.json');
  const log = join(directory, 'agent-arguments.log');
  const config = { endpoint: 'http://127.0.0.1', stateFile, projects: { p1: { directory, executable, agent } } };
  const events = [];
  const requests = [];
  const control = { refuseDispatch: false };
  const fetcher = async (url, options) => {
    const path = url.pathname;
    const body = JSON.parse(options.body);
    requests.push({ path, body });
    if (path.endsWith('/poll')) return Response.json({ events: events.filter((event) => event.seq > body.since) });
    if (control.refuseDispatch && path.endsWith('/progress')) return Response.json({}, { status: 404 });
    return Response.json({});
  };
  return {
    make: () => new WorkerLink(config, 'test-token', { fetcher }),
    args: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse),
    state: async () => JSON.parse(await readFile(stateFile, 'utf8')),
    save: async (state) => writeFile(stateFile, JSON.stringify(state)),
    childPid: async () => Number(await readFile(join(directory, 'child-pid.log'), 'utf8')),
    requests, control,
    wake: (seq, prompt, projectId = 'p1') => events.push({ seq, kind: 'wake', payload: { roomTaskId: 'task1', projectId, prompt } }),
    cancel: (seq) => events.push({ seq, kind: 'cancel', payload: { roomTaskId: 'task1' } }),
  };
}

test('runs Codex and sends a result, then resumes the poll cursor without rerunning', async (t) => {
  const f = await fixture(t);
  f.wake(1, 'Inspect the project');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  const [agent] = await f.args();
  assert.deepEqual(agent.argv, ['exec', '--json', '-']);
  assert.equal(agent.leaked, false);
  assert.equal((await f.state()).jobs[0].session, 'session-1');
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'Result: Inspect the project'));
  const restarted = f.make();
  await restarted.poll(undefined, 0);
  await restarted.runNext();
  assert.deepEqual(f.requests.filter(({ path }) => path.endsWith('/poll')).map(({ body }) => [body.since, body.eventsOnly]), [[0, true], [1, true]]);
  assert.equal((await f.args()).length, 1);
});

test('runs Claude Code with a fixed headless adapter', async (t) => {
  const f = await fixture(t, 'claude-code');
  f.wake(1, 'Summarise');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  assert.deepEqual((await f.args())[0].argv, ['--print', '--output-format', 'stream-json', '--verbose']);
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'Result: Summarise'));
});

test('restarts an unfinished task through its explicit saved session', async (t) => {
  for (const [agent, args] of [
    ['codex', ['exec', '--json', 'resume', 'session-previous', '-']],
    ['claude-code', ['--print', '--output-format', 'stream-json', '--verbose', '--resume', 'session-previous']],
  ]) {
    const f = await fixture(t, agent);
    await f.save({ cursor: 8, jobs: [{ id: 'task1', projectId: 'p1', prompt: 'Continue', session: 'session-previous', status: 'queued' }] });
    const link = f.make();
    await link.runNext();
    assert.deepEqual((await f.args())[0].argv, args);
  }
});

test('rejects unapproved projects and server-rejected dispatches before spawning', async (t) => {
  const f = await fixture(t);
  f.wake(1, 'Run this', 'other');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  await assert.rejects(f.args(), { code: 'ENOENT' });
  assert.ok(f.requests.some(({ body }) => body.body === 'Project directory or local agent is unavailable.'));

  const refused = await fixture(t);
  refused.control.refuseDispatch = true;
  refused.wake(1, 'Run this');
  const secondLink = refused.make();
  await secondLink.poll(undefined, 0);
  await secondLink.runNext();
  await assert.rejects(refused.args(), { code: 'ENOENT' });
});

test('reports waiting_auth and retries the task after restarting', async (t) => {
  const f = await fixture(t);
  f.wake(1, 'auth');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  assert.ok(f.requests.some(({ body }) => body.waitingAuthReason === 'codex requires sign-in.'));
  assert.equal((await f.state()).jobs[0].status, 'waiting_auth');
  const restarted = f.make();
  await restarted.runNext();
  assert.equal((await f.args()).length, 2);
});

test('cancels a running child and persists cancellation without reporting a result', { timeout: 8_000 }, async (t) => {
  const f = await fixture(t);
  f.wake(1, 'hang');
  const link = f.make();
  await link.poll(undefined, 0);
  const work = link.runNext();
  for (let i = 0; i < 80 && !(await f.state()).jobs[0].session; i += 1) await delay(25);
  assert.equal((await f.state()).jobs[0].session, 'session-1');
  let grandchild;
  for (let i = 0; i < 80 && !grandchild; i += 1) {
    grandchild = await f.childPid().catch(() => undefined);
    if (!grandchild) await delay(25);
  }
  f.cancel(2);
  await link.poll(undefined, 0);
  await work;
  assert.ok(grandchild);
  assert.equal((await f.state()).jobs[0].status, 'cancelled');
  assert.ok(!f.requests.some(({ path }) => path.endsWith('/report')));
  if (process.platform === 'win32') assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
});
