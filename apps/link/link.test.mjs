import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WorkerLink, withMcpTools } from './link.mjs';

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
  emit(codex ? { type: 'thread.started', thread_id: 'session-1' } : { type: 'system', subtype: 'init', session_id: 'session-1', tools: ['Read', 'mcp__vera-crm__list_invoices', 'mcp__vera-crm__approve_order', 'mcp__superagent_link__approve'] });
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

async function fixture(t, agent = 'codex', options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake.mjs');
  await writeFile(executable, fakeAgent);
  const stateFile = join(directory, 'state.json');
  const log = join(directory, 'agent-arguments.log');
  const config = { endpoint: 'http://127.0.0.1', stateFile, projects: { p1: { directory, executable, agent } } };
  if (options.launchWithApprovals) config.projects.p1.approvals = 'room';
  const events = [];
  const requests = [];
  const control = { refuseDispatch: false, pollFailures: 0, authAgents: [] };
  const fetcher = async (url, init) => {
    const path = url.pathname;
    const body = JSON.parse(init.body);
    requests.push({ path, body });
    if (path.endsWith('/poll')) {
      if (control.pollFailures > 0) {
        control.pollFailures -= 1;
        throw new Error('synthetic disconnect');
      }
      if (await control.stopAfterPoll?.()) return Response.json({ events: [] });
      return Response.json({ events: events.filter((event) => event.seq > body.since) });
    }
    if (path.endsWith('/permissions')) return Response.json({ policies: options.policies ?? {} });
    if (path.endsWith('/approvals')) return Response.json({ approval: { id: 'approval-1', expiresAt: Date.now() + 60_000 } }, { status: 201 });
    if (path.endsWith('/approvals/approval-1/wait')) {
      return Response.json({ approval: { status: options.approvalStatus } });
    }
    if (control.refuseDispatch && path.endsWith('/progress')) return Response.json({}, { status: 404 });
    return Response.json({});
  };
  return {
    make: () => new WorkerLink(config, 'test-token', {
      fetcher, launch: options.launch, launchWithApprovals: options.launchWithApprovals,
      sleep: options.sleep, renameState: options.renameState, onAuth: (agent) => control.authAgents.push(agent),
    }),
    args: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse),
    state: async () => JSON.parse(await readFile(stateFile, 'utf8')),
    save: async (state) => writeFile(stateFile, JSON.stringify(state)),
    childPid: async () => Number(await readFile(join(directory, 'child-pid.log'), 'utf8')),
    requests, control,
    wake: (seq, prompt, projectId = 'p1', attempt) => events.push({ seq, kind: 'wake', payload: { roomTaskId: 'task1', projectId, prompt, ...(attempt ? { attempt } : {}) } }),
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

test('runs a finished task once more when Super Agent sends it again with a higher attempt, and only then', async (t) => {
  const f = await fixture(t);
  f.wake(1, 'Inspect the project');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  f.wake(2, 'Inspect the project'); // a copy of the same wake: nothing to do
  await link.poll(undefined, 0);
  await link.runNext();
  assert.equal((await f.args()).length, 1);
  f.wake(3, 'Inspect the project again', 'p1', 1); // resumed by Super Agent
  await link.poll(undefined, 0);
  await link.runNext();
  assert.equal((await f.args()).length, 2);
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'Result: Inspect the project again'));
  assert.equal((await f.state()).jobs.length, 1);
  f.wake(4, 'Inspect the project again', 'p1', 1); // the same attempt twice runs once
  await link.poll(undefined, 0);
  await link.runNext();
  assert.equal((await f.args()).length, 2);
});

/** Claude Code's argv with Link's permission hook taken out; the hook itself is asserted separately. */
function withoutPermissionHook(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mcp-config' || argv[i] === '--permission-prompt-tool') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

test('runs Claude Code with a fixed headless adapter', async (t) => {
  const f = await fixture(t, 'claude-code');
  f.wake(1, 'Summarise');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  const argv = (await f.args())[0].argv;
  assert.deepEqual(withoutPermissionHook(argv), ['--print', '--output-format', 'stream-json', '--verbose']);
  // Permission prompts go to Link's own tool, never to a terminal nobody is watching.
  assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'mcp__superagent_link__approve');
  assert.match(argv[argv.indexOf('--mcp-config') + 1], /superagent-link-permissions-.+\.json$/);
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'Result: Summarise'));
});

test('Claude Code’s tool list is kept: each MCP server’s tools go out with the computer’s capabilities', async (t) => {
  const f = await fixture(t, 'claude-code');
  f.wake(1, 'Summarise');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  // Link's own permission server is not one of the employee's tools.
  assert.deepEqual((await f.state()).mcpTools, { 'vera-crm': ['list_invoices', 'approve_order'] });
});

test('tool lists join the MCP health list; a server only seen in a run counts as connected', () => {
  assert.equal(withMcpTools(null, undefined), null);
  assert.deepEqual(withMcpTools([{ name: 'vera-crm', status: 'connected' }, { name: 'gmail', status: 'needs_auth' }], { 'vera-crm': ['list_invoices'], claude_ai_Docs: ['read'] }), [
    { name: 'vera-crm', status: 'connected', tools: ['list_invoices'] },
    { name: 'gmail', status: 'needs_auth' },
    { name: 'claude_ai_Docs', status: 'connected', tools: ['read'] },
  ]);
});

test('reconnects with backoff and delivers a queued task after a network interruption', { timeout: 8_000 }, async (t) => {
  const retryDelays = [];
  const f = await fixture(t, 'codex', { sleep: async (ms) => { retryDelays.push(ms); } });
  const shutdown = new AbortController();
  f.control.pollFailures = 2;
  f.wake(1, 'Review the sample');
  // Yield to the child process when the fake server would be holding the poll.
  f.control.stopAfterPoll = async () => {
    await delay(10);
    if (!f.requests.some(({ path }) => path.endsWith('/report'))) return false;
    shutdown.abort();
    return true;
  };
  await f.make().start(shutdown.signal);
  assert.deepEqual(retryDelays, [1_000, 2_000]);
  assert.equal((await f.state()).cursor, 1);
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'Result: Review the sample'));
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
    assert.deepEqual(withoutPermissionHook((await f.args())[0].argv), args);
  }
});

test('retries a transient state-file lock while recording the running agent session', async (t) => {
  let retried = false;
  const f = await fixture(t, 'codex', {
    async renameState(from, to) {
      const saved = JSON.parse(await readFile(from, 'utf8'));
      if (saved.jobs[0]?.session && !retried) {
        retried = true;
        throw Object.assign(new Error('synthetic sharing violation'), { code: 'EPERM' });
      }
      return rename(from, to);
    },
  });
  f.wake(1, 'Record a session');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  assert.equal(retried, true);
  assert.equal((await f.state()).jobs[0].session, 'session-1');
  assert.ok(f.requests.some(({ path }) => path.endsWith('/report')));
});

test('cancels running work and preserves the last durable cursor if the state-file lock persists', async (t) => {
  let cancelled = false;
  const f = await fixture(t, 'codex', {
    async renameState(from, to) {
      const saved = JSON.parse(await readFile(from, 'utf8'));
      if (saved.jobs[0]?.session) throw Object.assign(new Error('synthetic persistent lock'), { code: 'EPERM' });
      return rename(from, to);
    },
    launch(_project, _prompt, _session, notify) {
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      queueMicrotask(() => notify({ session: 'session-locked' }));
      return {
        completed,
        cancel() {
          cancelled = true;
          finish({ cancelled: true });
        },
      };
    },
  });
  f.wake(1, 'Record a session');
  const link = f.make();
  await link.poll(undefined, 0);
  await assert.rejects(link.runNext(), { code: 'EPERM' });
  assert.equal(cancelled, true);
  assert.equal((await f.state()).cursor, 1);
  assert.ok(!f.requests.some(({ path }) => path.endsWith('/report')));
});

test('relays an App Server approval over the worker API and applies one decision', async (t) => {
  for (const [approvalStatus, expected] of [['allowed', 'allow'], ['denied', 'deny'], ['expired', 'deny']]) {
    const f = await fixture(t, 'codex', {
      approvalStatus,
      launchWithApprovals(_project, _prompt, _session, _notify, approve) {
        const controller = new AbortController();
        const completed = approve({
          kind: 'command', command: 'git status', requestId: 'native-1', threadId: 'thread-1', turnId: 'turn-1',
        }, controller.signal).then((decision) => ({ result: decision }));
        return { completed, cancel: () => controller.abort() };
      },
    });
    f.wake(1, 'Review code');
    const link = f.make();
    await link.poll(undefined, 0);
    await link.runNext();
    const request = f.requests.find(({ path }) => path.endsWith('/approvals'));
    assert.equal(request.body.roomTaskId, 'task1');
    assert.equal(request.body.tool, 'codex.command');
    assert.equal(request.body.input.requestId, 'native-1');
    assert.equal(f.requests.find(({ path }) => path.endsWith('/report'))?.body.body, expected);
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
  // The tray is told which CLI needs signing in, so it can open that CLI's login for the user.
  assert.deepEqual(f.control.authAgents, ['codex']);
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

test('Claude Code asks Link: the mode lets reads through, the room decides a CRM write, a wrong secret is refused', async (t) => {
  const asked = [];
  const launch = (project, prompt, session, notify, approver) => {
    const call = (toolName, input, secret = approver.secret) => fetch(approver.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
      body: JSON.stringify({ tool_name: toolName, input }),
    });
    const completed = (async () => {
      asked.push(await (await call('mcp__vera-crm__search_orders', { status: 'open' })).json());
      asked.push(await (await call('mcp__vera-crm__approve_order', { order: 'SS-1' })).json());
      asked.push((await call('Bash', { command: 'dir' }, 'wrong')).status);
      return { result: 'done' };
    })();
    return { completed, cancel() {} };
  };
  const f = await fixture(t, 'claude-code', { launch, approvalStatus: 'allowed', policies: { p1: { mode: 'standard' } } });
  f.wake(1, 'Look up orders');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  assert.deepEqual(asked[0], { behavior: 'allow' }); // read-only MCP tool: no one is asked
  assert.deepEqual(asked[1], { behavior: 'allow' }); // a write: the room allowed it
  assert.equal(asked[2], 401);
  const filed = f.requests.filter(({ path }) => path.endsWith('/approvals'));
  assert.equal(filed.length, 1);
  assert.equal(filed[0].body.tool, 'mcp__vera-crm__approve_order');
  assert.match(filed[0].body.summary, /vera-crm/);
  assert.ok(f.requests.some(({ path, body }) => path.endsWith('/report') && body.body === 'done'));
});

test('Claude Code in strict mode: even a read-only MCP tool waits for the room, and a denial reaches the agent', async (t) => {
  let answer;
  const launch = (project, prompt, session, notify, approver) => ({
    completed: (async () => {
      answer = await (await fetch(approver.url, {
        method: 'POST', headers: { authorization: 'Bearer ' + approver.secret },
        body: JSON.stringify({ tool_name: 'mcp__vera-crm__search_orders', input: {} }),
      })).json();
      return { result: 'stopped' };
    })(),
    cancel() {},
  });
  const f = await fixture(t, 'claude-code', { launch, approvalStatus: 'denied', policies: { p1: { mode: 'strict' } } });
  f.wake(1, 'Look up orders');
  const link = f.make();
  await link.poll(undefined, 0);
  await link.runNext();
  assert.equal(answer.behavior, 'deny');
  assert.match(answer.message, /command room/);
  assert.equal(f.requests.filter(({ path }) => path.endsWith('/approvals')).length, 1);
});
