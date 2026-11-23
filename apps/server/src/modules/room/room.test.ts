import assert from 'node:assert/strict';
import { it } from 'vitest';
import { CommandRoom, roomHooks, type EmployeeRef, type Viewer } from './room.js';

const employees: EmployeeRef[] = [
  { id: 'emp-sales', name: '销售员工', ownerUserId: 'user-sales', status: 'active' },
  { id: 'emp-ops', name: '运营员工', ownerUserId: 'user-ops', status: 'offline' },
];

const owner: Viewer = { userId: 'user-owner', roles: ['owner'], projectScopes: [] };
const sales: Viewer = { userId: 'user-sales', roles: ['employee'], projectScopes: ['p1'] };
const ops: Viewer = { userId: 'user-ops', roles: ['employee'], projectScopes: ['p1'] };

function room(): CommandRoom {
  const service = new CommandRoom(employees);
  service.addMember('room-1', 'user-sales');
  service.addMember('room-1', 'user-ops');
  return service;
}

it('an employee asking about another project gets a refusal and no task', () => {
  const service = room();
  const result = service.post({
    roomId: 'room-1',
    tenantId: 't',
    projectId: 'p2',
    authorUserId: 'user-sales',
    authorRoles: ['employee'],
    authorProjectScopes: ['p1'],
    body: '@销售员工 查看别人的项目',
    clientMessageId: 'c-scope',
  });
  assert.equal(result.task, null);
  assert.match(result.reply?.body ?? '', /不会创建/);
  assert.equal(service.listTasks(owner).length, 0);
});

it('a model outage keeps the task and marks it waiting', () => {
  const service = room();
  const result = service.post({
    roomId: 'room-1',
    tenantId: 't',
    projectId: 'p1',
    authorUserId: 'user-owner',
    body: '@销售员工 整理询价草稿',
    clientMessageId: 'c-model',
    modelAvailable: false,
  });
  assert.equal(result.task?.status, 'waiting');
  assert.equal(result.task?.waitingReason, '等待模型');
  assert.match(result.reply?.body ?? '', /暂时无法处理/);
  assert.equal(service.listTasks(owner).length, 1);
});

it('a greeting gets a reply and does not create a task', () => {
  const service = room();
  const result = service.post({
    roomId: 'room-1',
    tenantId: 't',
    authorUserId: 'user-owner',
    body: '你好',
    clientMessageId: 'c1',
  });
  assert.equal(result.task, null);
  assert.match(result.reply?.body ?? '', /你好/);
  assert.equal(service.listTasks(owner).length, 0);
});

it('mentioning an employee creates a task linked back to the message, and the report stays in the room', () => {
  const service = room();
  const result = service.post({
    roomId: 'room-1',
    tenantId: 't',
    projectId: 'p1',
    authorUserId: 'user-owner',
    body: '@销售员工 整理询价草稿',
    clientMessageId: 'c2',
  });
  assert.equal(result.task?.messageId, result.message.id);
  assert.equal(result.task?.status, 'assigned');
  const report = service.report(result.task!.id, 'user-sales', '询价草稿已放在对话里', 'c3');
  assert.deepEqual(report.taskIds, [result.task!.id]);
  assert.equal(service.listTasks(sales)[0]?.status, 'completed');
  const afterReload = service.eventsAfter('room-1', 0, owner);
  assert.equal(afterReload.length >= 3, true);
});

it('reconnect returns only unseen messages, and a resent client id is stored once', () => {
  const service = room();
  const first = service.post({
    roomId: 'room-1', tenantId: 't', authorUserId: 'user-owner', body: '你好', clientMessageId: 'c1',
  });
  service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  const last = first.reply?.seq ?? first.message.seq;
  const gap = service.eventsAfter('room-1', last, owner);
  assert.equal(gap.some((message) => message.clientMessageId === 'c1'), false);
  assert.equal(gap.some((message) => message.body.includes('整理询价草稿')), true);
  const again = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  assert.equal(again.duplicate, true);
  assert.equal(service.eventsAfter('room-1', 0, owner).filter((message) => message.clientMessageId === 'c2').length, 1);
});

it('an employee cannot see another employee task, and a paused employee still gets a waiting task', () => {
  const service = room();
  service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  const offline = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@运营员工 核对库存', clientMessageId: 'c4',
  });
  assert.equal(offline.task?.status, 'waiting');
  assert.equal(offline.task?.waitingReason, '等待连接');
  assert.equal(service.listTasks(sales).every((task) => task.assigneeUserId === 'user-sales'), true);
  assert.equal(service.listTasks(ops).some((task) => task.assigneeUserId === 'user-sales'), false);
  assert.equal(service.eventsAfter('room-secret', 0, sales).length, 0);
});

it('only the assignee can report, and that report stays in the same conversation', () => {
  const service = room();
  const posted = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  const before = service.eventsAfter('room-1', 0, owner).length;
  assert.throws(() => service.report(posted.task!.id, 'user-ops', '不是我的任务', 'wrong'), /not_assignee/);
  assert.equal(service.eventsAfter('room-1', 0, owner).length, before);
  assert.equal(service.listTasks(sales)[0]?.status, 'assigned');
  const report = service.report(posted.task!.id, 'user-sales', '询价草稿已放在对话里', 'mine');
  assert.equal(report.roomId, 'room-1');
  assert.equal(service.listTasks(sales)[0]?.status, 'completed');
});

it('a reloaded room keeps the conversation, the task, and the duplicate guard', () => {
  const service = room();
  service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  const reloaded = CommandRoom.restore(employees, service.snapshot());
  assert.equal(reloaded.listTasks(sales).length, 1);
  assert.equal(reloaded.listTasks(sales)[0]?.messageId, reloaded.eventsAfter('room-1', 0, sales)[0]?.id);
  const again = reloaded.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  assert.equal(again.duplicate, true);
  assert.equal(reloaded.eventsAfter('room-1', 0, owner).filter((message) => message.clientMessageId === 'c2').length, 1);
});

it('a repeated employee report with the same client id stays one message', () => {
  const service = room();
  const posted = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', clientMessageId: 'c2',
  });
  const taskId = posted.task?.id ?? '';
  const first = service.report(taskId, 'user-sales', '询价草稿已放在对话里', 'report-1');
  const second = service.report(taskId, 'user-sales', '另一段正文', 'report-1');
  assert.equal(second.id, first.id);
  assert.equal(second.body, '询价草稿已放在对话里');
  assert.equal(service.eventsAfter('room-1', 0, owner).filter((message) => message.clientMessageId === 'report-1').length, 1);
  const reloaded = CommandRoom.restore(employees, service.snapshot());
  const third = reloaded.report(taskId, 'user-sales', '再来一次', 'report-1');
  assert.equal(third.id, first.id);
  assert.equal(reloaded.eventsAfter('room-1', 0, owner).filter((message) => message.clientMessageId === 'report-1').length, 1);
});

it('a mention written straight after Chinese text still assigns the task, while an email address does not', () => {
  const service = room();
  const result = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner',
    body: '请@销售员工 整理询价草稿', clientMessageId: 'c-cn',
  });
  assert.equal(result.task?.employeeId, 'emp-sales');
  assert.equal(result.task?.title, '请 整理询价草稿');
  const email = service.post({
    roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner',
    body: '整理发给 buyer@销售员工 的询价', clientMessageId: 'c-mail',
  });
  assert.equal(email.task, null);
});

it('a mention followed only by punctuation is not a task', () => {
  const service = room();
  for (const [body, id] of [['@销售员工 、', 'p1'], ['@销售员工 。。', 'p2'], ['@销售员工 ...', 'p3']]) {
    const result = service.post({ roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: body!, clientMessageId: id! });
    assert.equal(result.task, null, body);
  }
});

it("a Link computer's updates move the task: working is in progress, its fixed failure texts say it stopped", () => {
  const service = room();
  const { task } = service.post({ roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@运营员工 核对库存', clientMessageId: 'c-link' });
  assert.equal(task?.status, 'waiting');
  const update = (body: string, id: string) => service.updateFromWorker(task!.id, 't', body, id, false, () => true);
  update('Link received the task.', 'w1');
  assert.equal(task!.status, 'running');
  assert.equal(task!.waitingReason, null);
  update('Agent CLI did not return a completed result. Rate limit reached', 'w2');
  assert.equal(task!.status, 'waiting');
  assert.equal(task!.waitingReason, '执行失败');
  update('claude-code requires sign-in.', 'w3');
  assert.equal(task!.waitingReason, '等待本地登录');
  // Signed in again: Link picks the task up once more.
  update('Link received the task.', 'w4');
  assert.equal(task!.status, 'running');
});

it('a running task is not held as disconnected while its computer may still be online', () => {
  const service = room();
  const { task } = service.post({ roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@运营员工 核对库存', clientMessageId: 'c-hold' });
  service.updateFromWorker(task!.id, 't', 'Agent started.', 'w1', false, () => true);
  assert.equal(task!.status, 'running');
  roomHooks.linkMayBeOnline = () => true;
  try {
    assert.equal(service.holdDisconnected().length, 0);
    assert.equal(task!.status, 'running');
  } finally {
    roomHooks.linkMayBeOnline = () => false;
  }
  assert.equal(service.holdDisconnected().length, 1);
  assert.equal(task!.waitingReason, '等待连接');
});
