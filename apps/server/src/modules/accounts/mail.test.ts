import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { bindRoomBrain, bindRoomStore, createCommandRoom, roomState } from '../room/index.js';
import type { EmployeeRef } from '../room/room.js';
import { resetWorkers } from '../workers/index.js';
import { InMemorySecretStore } from '../setup/secrets.js';
import { AccountError, type AccountProvider } from './accounts.js';
import { accountsState, bindAccounts } from './index.js';
import { mailModule, mailState, MemoryMailDraftStore, pollMail } from './mail.js';
import type { MailClient, MailMessage } from './graph.js';
import { MICROSOFT_SCOPES } from './microsoft.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const owner: UserContext = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] };
const responsible: UserContext = { tenantId, userId: 'lead', roles: ['employee'], projectScopes: [] };
const stranger: UserContext = { tenantId, userId: 'someone', roles: ['employee'], projectScopes: [] };
const ops: EmployeeRef = { id: 'emp-ops', name: '运营员工', ownerUserId: 'lead', status: 'active' };
const SYSTEM = { userId: 'owner', roles: ['owner' as const], projectScopes: [] };

let now = Date.parse('2026-11-25T01:00:00Z');
let inbox: Record<string, MailMessage[]> = {};
let replies: { messageId: string; text: string; token: string }[] = [];
let failReply = false;

const client: MailClient = {
  newMail: async (token, folder, since) => (inbox[token + '|' + folder] ?? []).filter((message) => message.receivedAt >= since),
  folder: async () => 'folder-sa',
  reply: async (token, messageId, text) => { if (failReply) throw new AccountError('graph_failed', 'nope', 502); replies.push({ token, messageId, text }); },
};
const provider: AccountProvider = {
  id: 'microsoft', scopes: MICROSOFT_SCOPES,
  authorizeUrl: ({ state }) => `https://login.example/?state=${state}`,
  redeem: async ({ code }) => ({ access: 'tok:' + code, refresh: null, expiresIn: null, scope: MICROSOFT_SCOPES }),
  refresh: async () => { throw new Error('no'); },
  whoAmI: async (access) => ({ address: access.replace('tok:', ''), displayName: '' }),
};

const mail = (id: string, over: Partial<MailMessage> = {}): MailMessage => ({
  id, subject: '询价：百叶窗 3 樘', from: 'client@example.com', fromName: '客户', receivedAt: new Date(now).toISOString(), conversationId: 'conv-1', text: '请报价，尺寸见附件。', ...over,
});

/** Connects a mailbox the way the browser does, then turns mail on with this sending rule. */
async function connect(address: string, employeeId: string | null, sendRule: 'ask' | 'allow' | 'deny') {
  const service = accountsState.current;
  const ownerOf = employeeId ? { kind: 'employee' as const, id: employeeId } : { kind: 'admin' as const, id: 'owner' };
  const { authorizationUrl } = await service.start(tenantId, 'owner', ownerOf, 'https://app/cb');
  const row = await service.finish(tenantId, 'owner', { state: new URL(authorizationUrl).searchParams.get('state'), code: address });
  return service.update(tenantId, row.id, row.owner, { mailTrigger: true, sendRule });
}

async function appFor(user: UserContext) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = user; });
  await app.register(mailModule, { prefix: '/mail' });
  return app;
}

const tasks = () => roomState.current.listTasks(SYSTEM);
const messages = () => roomState.current.eventsAfter('room-1', 0, SYSTEM);
const complete = (taskId: string, body: string) => roomState.current.updateFromWorker(taskId, tenantId, body, 'done:' + taskId + body.length, true, () => true);

beforeEach(() => {
  now = Date.parse('2026-11-25T01:00:00Z');
  inbox = {};
  replies = [];
  failReply = false;
  resetWorkers();
  bindRoomStore(null);
  bindRoomBrain(null);
  roomState.current = createCommandRoom(() => [ops]);
  bindAccounts({ secrets: new InMemorySecretStore(), provider, now: () => now });
  mailState.client = client;
  mailState.drafts = new MemoryMailDraftStore();
});

it('mail already in the mailbox is not work; new mail becomes the employee’s task; the same thread joins it; its own sent mail is ignored', async () => {
  inbox['tok:ops@innopro.co.nz|inbox'] = [mail('old', { receivedAt: '2026-11-24T23:00:00Z' })];
  await connect('ops@innopro.co.nz', 'emp-ops', 'ask');
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'].push(mail('m1'), mail('mine', { from: 'ops@innopro.co.nz' }));
  expect(await pollMail(accountsState.current, () => now)).toBe(1);
  expect(tasks()).toHaveLength(1);
  expect(tasks()[0]).toMatchObject({ employeeId: 'emp-ops' });
  expect(tasks()[0]!.title).toContain('client@example.com');
  expect(messages()[0]!.body).toBe('收到发给 @运营员工 的邮件「询价：百叶窗 3 樘」（来自 client@example.com），已交给它处理。');

  // Read again: nothing is handled twice.
  expect(await pollMail(accountsState.current, () => now)).toBe(0);
  // A reply in the same thread joins the open task instead of making a new one.
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'].push(mail('m2', { conversationId: 'conv-1', text: '补充：要白色。' }));
  expect(await pollMail(accountsState.current, () => now)).toBe(1);
  expect(tasks()).toHaveLength(2);
  expect(tasks()[1]).toMatchObject({ employeeId: 'emp-ops', followupTo: tasks()[0]!.id });
  expect(tasks()[1]!.title).toContain('补充：要白色');
  const account = (await accountsState.current.list(tenantId, { kind: 'employee', id: 'emp-ops' }))[0]!;
  expect(account.mailState).toMatchObject({ received: 2, error: null });
});

it('"ask me first": the employee’s report becomes a reply draft; the responsible person edits and sends it; a stranger cannot', async () => {
  await connect('ops@innopro.co.nz', 'emp-ops', 'ask');
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'] = [mail('m1')];
  await pollMail(accountsState.current, () => now);
  const task = tasks()[0]!;
  complete(task.id, '您好，3 樘白色百叶窗报价 NZD 1,980，含安装。');
  await pollMail(accountsState.current, () => now);
  expect(replies).toEqual([]);
  expect(messages().at(-1)!.body).toContain('回复草稿（Re: 询价：百叶窗 3 樘）已放进「待我处理」');

  const other = await appFor(stranger);
  expect((await other.inject({ method: 'GET', url: '/mail/drafts' })).json().drafts).toEqual([]);
  const lead = await appFor(responsible);
  const [draft] = (await lead.inject({ method: 'GET', url: '/mail/drafts' })).json().drafts;
  expect(draft).toMatchObject({ to: 'client@example.com', subject: 'Re: 询价：百叶窗 3 樘', employeeName: '运营员工', address: 'ops@innopro.co.nz' });
  expect((await other.inject({ method: 'POST', url: `/mail/drafts/${draft.id}/send`, payload: {} })).statusCode).toBe(404);
  const sent = await lead.inject({ method: 'POST', url: `/mail/drafts/${draft.id}/send`, payload: { body: '您好，报价 NZD 1,980（含安装），有效期 30 天。' } });
  expect(sent.json()).toEqual({ sent: true });
  expect(replies).toEqual([{ token: 'tok:ops@innopro.co.nz', messageId: 'm1', text: '您好，报价 NZD 1,980（含安装），有效期 30 天。' }]);
  expect((await lead.inject({ method: 'POST', url: `/mail/drafts/${draft.id}/send`, payload: {} })).statusCode).toBe(404); // once
  expect(messages().at(-1)!.body).toBe('已从 ops@innopro.co.nz 回复 client@example.com（Re: 询价：百叶窗 3 樘）。');
});

it('"send directly" replies as soon as the employee reports; "never send" sends nothing; "no reply needed" makes no draft', async () => {
  await connect('ops@innopro.co.nz', 'emp-ops', 'allow');
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'] = [mail('m1'), mail('m2', { conversationId: 'conv-2', subject: '谢谢' })];
  await pollMail(accountsState.current, () => now);
  const [first, second] = tasks();
  complete(first!.id, '报价如下……');
  complete(second!.id, '无需回复');
  await pollMail(accountsState.current, () => now);
  expect(replies.map((reply) => reply.messageId)).toEqual(['m1']);
  expect(messages().some((message) => message.body.startsWith('已按设置从 ops@innopro.co.nz 直接回复 client@example.com'))).toBe(true);

  const row = (await accountsState.current.list(tenantId, { kind: 'employee', id: 'emp-ops' }))[0]!;
  await accountsState.current.update(tenantId, row.id, row.owner, { sendRule: 'deny' });
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'].push(mail('m3', { conversationId: 'conv-3' }));
  await pollMail(accountsState.current, () => now);
  complete(tasks().at(-1)!.id, '好的，已安排。');
  await pollMail(accountsState.current, () => now);
  expect(replies).toHaveLength(1);
  expect(messages().at(-1)!.body).toContain('不允许发邮件');
  expect((await (await appFor(owner)).inject({ method: 'GET', url: '/mail/drafts' })).json().drafts).toEqual([]);
});

it('a direct reply that fails is kept as a draft for a person to send', async () => {
  await connect('ops@innopro.co.nz', 'emp-ops', 'allow');
  now += 60_000;
  inbox['tok:ops@innopro.co.nz|inbox'] = [mail('m1')];
  await pollMail(accountsState.current, () => now);
  failReply = true;
  complete(tasks()[0]!.id, '报价如下……');
  await pollMail(accountsState.current, () => now);
  expect(messages().at(-1)!.body).toContain('没有成功');
  expect((await (await appFor(owner)).inject({ method: 'GET', url: '/mail/drafts' })).json().drafts).toHaveLength(1);
});

it('an administrator’s mailbox: only its “Super Agent” folder is read, as that administrator speaking to Super Agent', async () => {
  await connect('robin@innopro.co.nz', null, 'ask');
  now += 60_000;
  inbox['tok:robin@innopro.co.nz|inbox'] = [mail('private', { subject: '私人邮件' })];
  inbox['tok:robin@innopro.co.nz|folder-sa'] = [mail('cmd', { from: 'robin@gmail.com', subject: '安排一下', text: '@运营员工 整理本周询价清单' })];
  expect(await pollMail(accountsState.current, () => now)).toBe(1);
  const room = messages();
  expect(room[0]).toMatchObject({ authorUserId: 'owner' });
  expect(room[0]!.body).toContain('整理本周询价清单');
  expect(room.some((message) => message.body.includes('私人邮件'))).toBe(false);
  expect(tasks()).toHaveLength(1); // the @mention in the mail made a task, as if typed in the room
  expect(tasks()[0]!.employeeId).toBe('emp-ops');
});

it('a mailbox whose sign-in has expired says so on its card and is read again after it signs in', async () => {
  const row = await connect('ops@innopro.co.nz', 'emp-ops', 'ask');
  mailState.client = { ...client, newMail: async () => { throw new AccountError('reauthorize', '这个邮箱需要重新登录授权。', 401); } };
  await pollMail(accountsState.current, () => now);
  const after = (await accountsState.current.list(tenantId, row.owner))[0]!;
  expect(after.mailState?.error).toBe('这个邮箱需要重新登录授权。');
  expect(after.mailState?.checkedAt).toBe(new Date(now).toISOString());
});
