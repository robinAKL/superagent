import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runCodexTurn } from './codex-app-server.mjs';

test('forwards native approvals and continues the correct Codex turn', { timeout: 5_000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = createInterface({ input });
  const messages = client[Symbol.asyncIterator]();
  const send = (message) => output.write(JSON.stringify(message) + '\n');
  const next = async () => JSON.parse((await messages.next()).value);
  const approvals = [];
  const notifications = [];
  const controller = new AbortController();
  let decide;
  const result = runCodexTurn({
    input, output, cwd: '/work/project', prompt: 'Inspect the repo', session: 'existing-thread',
    signal: controller.signal, notify: (message) => notifications.push(message),
    async approve(request) {
      approvals.push(request);
      if (request.kind === 'command') return new Promise((resolve) => { decide = resolve; });
      return 'deny';
    },
  });
  try {
    const init = await next();
    assert.equal(init.method, 'initialize');
    send({ id: init.id, result: {} });
    assert.equal((await next()).method, 'initialized');
    const resume = await next();
    assert.deepEqual(resume.params, { threadId: 'existing-thread', cwd: '/work/project', excludeTurns: true });
    send({ id: resume.id, result: { thread: { id: 'existing-thread' } } });
    const turn = await next();
    assert.deepEqual(turn.params, { threadId: 'existing-thread', input: [{ type: 'text', text: 'Inspect the repo' }] });
    send({ id: turn.id, result: { turn: { id: 'turn-1' } } });
    const scope = { threadId: 'existing-thread', turnId: 'turn-1' };
    send({ id: 'a-wrong', method: 'item/commandExecution/requestApproval', params: { ...scope, turnId: 'stale' } });
    assert.deepEqual(await next(), { id: 'a-wrong', result: { decision: 'decline' } });
    send({ id: 'a-command', method: 'item/commandExecution/requestApproval',
      params: { ...scope, itemId: 'cmd-1', command: 'git status', cwd: '/work/project' } });
    assert.equal(typeof decide, 'function');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].command, 'git status');
    decide('allow');
    assert.deepEqual(await next(), { id: 'a-command', result: { decision: 'accept' } });

    send({ method: 'item/started', params: { ...scope, item: { id: 'edit-1', type: 'fileChange', changes: [{ path: '/work/project/a.ts' }] } } });
    send({ id: 'a-file', method: 'item/fileChange/requestApproval', params: { ...scope, itemId: 'edit-1' } });
    assert.deepEqual(await next(), { id: 'a-file', result: { decision: 'decline' } });
    assert.deepEqual(approvals[1].paths, ['/work/project/a.ts']);
    send({ method: 'item/completed', params: { ...scope, item: { type: 'agentMessage', text: 'Done.' } } });
    send({ method: 'turn/completed', params: { threadId: scope.threadId, turn: { id: scope.turnId, status: 'completed' } } });
    assert.deepEqual(await result, { result: 'Done.' });
    assert.deepEqual(notifications[0], { session: 'existing-thread' });
  } finally {
    controller.abort();
    client.close();
    input.destroy();
    output.destroy();
  }
});

test('aborting the turn aborts the approval wait without approving the operation', { timeout: 5_000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = createInterface({ input });
  const controller = new AbortController();
  let approvalSignal;
  input.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString());
    const send = (message) => output.write(JSON.stringify(message) + '\n');
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
      send({ id: 700, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit' } });
    }
    assert.notEqual(request.result?.decision, 'accept');
  });
  try {
    const result = await runCodexTurn({
      input, output, cwd: '/work', prompt: 'hello', signal: controller.signal, notify: () => {},
      async approve(_request, signal) {
        approvalSignal = signal;
        controller.abort();
        return 'allow';
      },
    });
    assert.deepEqual(result, { cancelled: true });
    assert.equal(approvalSignal?.aborted, true);
  } finally {
    controller.abort();
    client.close();
    input.destroy();
    output.destroy();
  }
});
