import assert from 'node:assert/strict';
import { afterEach, it } from 'vitest';
import { CommandRoom, roomHooks, type EmployeeRef, type Viewer } from './room.js';

const owner: Viewer = { userId: 'user-owner', roles: ['owner'], projectScopes: [] };
const MIN = 60_000;

/** A room with one employee whose status the test switches, and a clock the test moves. */
function setup() {
  const employee: EmployeeRef = { id: 'emp-ops', name: '运营员工', ownerUserId: 'user-ops', status: 'active' };
  let now = Date.parse('2026-11-25T00:00:00Z');
  const room = new CommandRoom(() => [employee], () => new Date(now));
  const post = (body: string, id: string) => room.post({
    roomId: 'room-1', tenantId: 't', authorUserId: 'user-owner', authorRoles: ['owner'], body, clientMessageId: id,
  });
  return {
    room, employee, post,
    later: (minutes: number) => { now += minutes * MIN; },
    /** One supervisor pass, with every re-send reaching the computer (as the HTTP layer reports it). */
    say: () => {
      const pass = room.supervise();
      const sent = pass.retry.map((request) => room.retried(request, true)).filter((message): message is NonNullable<typeof message> => Boolean(message));
      return { messages: [...pass.messages, ...sent], retry: pass.retry.map((request) => request.task) };
    },
    task: (id: string) => room.listTasks(owner).find((item) => item.id === id)!,
  };
}

afterEach(() => { roomHooks.linkMayBeOnline = () => false; });

it('a task waiting for its computer resumes by itself once the computer is back: same task, sent again', () => {
  const s = setup();
  s.employee.status = 'offline';
  const made = s.post('@运营员工 检查本地 worker 是否在线', 'c1').task!;
  assert.equal(made.status, 'waiting');
  assert.deepEqual(s.say().retry, []); // still offline: nothing to send

  s.employee.status = 'active';
  const pass = s.say();
  assert.deepEqual(pass.retry.map((task) => task.id), [made.id]);
  assert.equal(s.task(made.id).status, 'assigned');
  assert.equal(s.task(made.id).watch?.attempts, 1);
  assert.match(pass.messages[0]!.body, /重新派给它继续做（同一个任务，没有新建）/);
  assert.equal(pass.messages[0]!.kind, 'resume');
  assert.equal(s.room.listTasks(owner).length, 1);
  assert.deepEqual(s.say().messages, []); // nothing more to say right away
});

it('a failed run is retried twice, then the person is asked to decide, once per two hours at most', () => {
  const s = setup();
  const made = s.post('@运营员工 整理询价草稿', 'c1').task!;
  const fail = (n: number) => s.room.updateFromWorker(made.id, 't', 'Agent CLI could not be started.', `f${n}`, false, () => true);
  for (let attempt = 1; attempt <= 2; attempt++) {
    fail(attempt);
    assert.equal(s.task(made.id).waitingReason, '执行失败');
    s.say(); // notes the new state
    s.later(1);
    const pass = s.say();
    assert.equal(pass.retry.length, 1, `retry ${attempt}`);
    assert.match(pass.messages[0]!.body, new RegExp(`第 ${attempt} 次`));
  }
  fail(3);
  const ask = s.say();
  assert.deepEqual(ask.retry, []);
  assert.match(ask.messages[0]!.body, /已自动重试 2 次仍然失败，需要你决定/);
  s.later(30);
  assert.deepEqual(s.say().messages, []); // not again within two hours
  s.later(120);
  assert.equal(s.say().messages.length, 1);
});

it('a quiet run is chased after 30 minutes; progress from the computer restarts the clock', () => {
  const s = setup();
  const made = s.post('@运营员工 列出项目文件', 'c1').task!;
  s.room.updateFromWorker(made.id, 't', '正在处理任务…', 'p1', false, () => true);
  s.say();
  s.later(20);
  assert.deepEqual(s.say().messages, []);
  s.room.updateFromWorker(made.id, 't', '已读完目录，正在总结', 'p2', false, () => true);
  s.later(20);
  assert.deepEqual(s.say().messages, []); // 20 minutes since the last progress, not 40
  s.later(15);
  const chased = s.say().messages;
  assert.equal(chased.length, 1);
  assert.equal(chased[0]!.kind, 'nudge');
  assert.match(chased[0]!.body, /没有新进展，我在盯着/);
});

it('a task no computer picked up is sent again after 10 minutes, then the person is told to check Link', () => {
  const s = setup();
  const made = s.post('@运营员工 列出项目文件', 'c1').task!;
  s.say();
  s.later(10);
  assert.equal(s.say().retry.length, 1);
  s.later(10);
  assert.equal(s.say().retry.length, 1);
  s.later(10);
  const told = s.say();
  assert.deepEqual(told.retry, []);
  assert.match(told.messages[0]!.body, /请检查 @运营员工 那台电脑的 Link/);
  assert.equal(s.task(made.id).id, made.id);
});

it('the board summary lists every open task with its state, time and next step; the dispatch prompt shows the board', () => {
  const s = setup();
  s.employee.status = 'offline';
  const first = s.post('@运营员工 检查本地 worker 是否在线', 'c1').task!;
  s.employee.status = 'active';
  const second = s.post('@运营员工 列出项目文件', 'c2').task!;
  s.say();
  s.later(3);
  const summary = s.room.boardSummary(owner, 'room-1');
  assert.match(summary, /看板上还有 2 个未完成/);
  assert.match(summary, /T-\d+「列出项目文件」@运营员工：已派出，等电脑领取，3 分钟。等电脑领取，超时我会重新派发。/);
  assert.match(summary, /检查本地 worker 是否在线/);

  const prompt = s.room.dispatchPrompt(s.task(second.id));
  assert.match(prompt, /^列出项目文件\n/);
  assert.match(prompt, /只做这一个任务/);
  assert.match(prompt, /检查本地 worker 是否在线/);
  assert.doesNotMatch(prompt.split('---')[1]!, /列出项目文件/);
  assert.ok(first);
});

it('a re-send that reaches no computer is neither counted nor announced as sent; the room hears why, once', () => {
  const s = setup();
  const made = s.post('@运营员工 列出项目文件', 'c1').task!;
  s.room.supervise();
  s.later(10);
  const pass = s.room.supervise();
  assert.equal(pass.retry.length, 1);
  const note = s.room.retried(pass.retry[0]!, false)!;
  assert.match(note.body, /现在没有电脑能接/);
  assert.equal(note.kind, 'nudge');
  assert.equal(s.task(made.id).watch?.attempts, 0);
  s.later(1);
  assert.equal(s.room.retried(s.room.supervise().retry[0]!, false), null); // not again within two hours
  assert.equal(s.task(made.id).watch?.attempts, 0);
});

it('"重试" from a person resets the count and sends the open tasks again', () => {
  const s = setup();
  const made = s.post('@运营员工 列出项目文件', 'c1').task!;
  s.say();
  for (let i = 0; i < 3; i++) { s.later(10); s.say(); }
  assert.equal(s.task(made.id).watch?.attempts, 2);
  const { retry, skipped } = s.room.retryRequested(owner, 'room-1', [Number(made.id.replace('task_', '')), 999]);
  assert.equal(retry.length, 1);
  assert.deepEqual(skipped, ['T-999']);
  assert.match(s.room.retried(retry[0]!, true)!.body, /已重新派给 @运营员工/);
  assert.equal(s.task(made.id).watch?.attempts, 1);
  assert.equal(s.room.retryRequested(owner, 'room-1', 'all').retry.length, 1);
});
