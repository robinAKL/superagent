import { randomUUID } from 'node:crypto';
import { runAsTenant } from '../../tenancy.js';
import type { FastifyPluginAsync } from 'fastify';
import type { UserContext } from '@superagent/shared';
import { flushRoom, receiveRoomMessage, roomState } from '../room/index.js';
import { queueRoomDispatch, resolveRoomDispatch } from '../workers/index.js';
import { AccountError, type AccountConnection, type AccountService, type Actor, type MailState } from './accounts.js';
import { graphMail, SUPER_AGENT_FOLDER, type MailClient, type MailMessage } from './graph.js';
import { accountsState } from './index.js';

/**
 * Mail automation. Each connected mailbox with mail turned on is read once a minute, on its own owner's behalf:
 * - a digital employee's mailbox: new mail becomes that employee's task (mail in the same thread joins its task), and
 *   when the employee reports, its report is the reply, sent according to the mailbox's sending rule;
 * - an administrator's mailbox: only mail in its "Super Agent" folder, read as a message from that administrator to
 *   Super Agent in the command room.
 * Mail that was already in the mailbox when mail was turned on is never processed.
 */
export const MAIL_ROOM_ID = 'room-1';
const SYSTEM = { userId: 'super-agent', roles: ['owner' as const], projectScopes: [] as string[] };

export interface MailDraft {
  id: string;
  tenantId: string;
  accountId: string;
  address: string;
  employeeId: string;
  taskId: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'discarded' | 'failed';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
}

export interface MailDraftStore {
  pending(tenantId: string): Promise<MailDraft[]>;
  get(tenantId: string, id: string): Promise<MailDraft | null>;
  /** Insert; false when the task already has a draft. */
  add(draft: MailDraft): Promise<boolean>;
  save(draft: MailDraft): Promise<void>;
}

export class MemoryMailDraftStore implements MailDraftStore {
  private rows = new Map<string, MailDraft>();
  async pending(tenantId: string) { return [...this.rows.values()].filter((row) => row.tenantId === tenantId && row.status === 'pending').map((row) => ({ ...row })); }
  async get(tenantId: string, id: string) { const row = this.rows.get(id); return row && row.tenantId === tenantId ? { ...row } : null; }
  async add(draft: MailDraft) {
    if ([...this.rows.values()].some((row) => row.tenantId === draft.tenantId && row.taskId === draft.taskId)) return false;
    this.rows.set(draft.id, { ...draft });
    return true;
  }
  async save(draft: MailDraft) { this.rows.set(draft.id, { ...draft }); }
}

export const mailState: { client: MailClient; drafts: MailDraftStore; accounts: (() => AccountService) | null } = {
  client: graphMail(), drafts: new MemoryMailDraftStore(), accounts: () => accountsState.current,
};

const actorOf = (row: AccountConnection): Actor => row.owner.kind === 'admin' ? { kind: 'super-agent' } : { kind: 'employee', id: row.owner.id };
const OPEN = new Set(['assigned', 'running', 'waiting']);

function mailText(message: MailMessage) {
  return `发件人：${message.fromName ? `${message.fromName} <${message.from}>` : message.from}\n主题：${message.subject || '（无主题）'}\n\n${message.text || '（正文为空）'}`;
}

async function dispatch(task: import('../room/room.js').RoomTask | null) {
  if (!task) { await flushRoom(); return; }
  const employee = roomState.current.roster(SYSTEM).find((item) => item.id === task.employeeId);
  const target = employee && employee.status !== 'paused' ? await resolveRoomDispatch(task, null) : undefined;
  if (target) task.projectId = target.projectId;
  await flushRoom();
  if (target) await queueRoomDispatch(task, target);
}

/** New mail in a digital employee's mailbox: a task for that employee, or more for the task its thread already has. */
async function employeeMail(row: AccountConnection, message: MailMessage, state: MailState): Promise<void> {
  const room = roomState.current;
  const employee = room.roster(SYSTEM).find((item) => item.id === row.owner.id);
  if (!employee) return;
  const threadTask = state.threads?.[message.conversationId];
  const open = threadTask ? room.listTasks(SYSTEM).find((task) => task.id === threadTask && OPEN.has(task.status)) : undefined;
  if (open) {
    // A follow-up of the open task: the employee gets the new mail with the original task's context, and the reply
    // goes out once, from the follow-up (the original's reply is no longer awaited).
    const followup = room.post({
      roomId: MAIL_ROOM_ID, tenantId: row.tenantId, authorUserId: SYSTEM.userId, authorRoles: SYSTEM.roles, followupTo: open.id, systemWork: true,
      body: `同一封往来又收到一封邮件（来自 ${message.from}）。完成后，最后的汇报只写要回复给对方的邮件正文；不需要回复就写「无需回复」。\n\n${mailText(message)}`.slice(0, 6000),
      clientMessageId: `mail:${row.id}:${message.id}`,
    });
    if (followup.task) {
      const previous = state.tasks?.[open.id];
      state.tasks = { ...state.tasks, ...(previous ? { [open.id]: { ...previous, drafted: true } } : {}), [followup.task.id]: { messageId: message.id, from: message.from, subject: message.subject } };
      state.threads = { ...state.threads, [message.conversationId]: followup.task.id };
    }
    await dispatch(followup.task);
    return;
  }
  const posted = room.post({
    roomId: MAIL_ROOM_ID, tenantId: row.tenantId, authorUserId: SYSTEM.userId, authorRoles: SYSTEM.roles, systemWork: true,
    body: `收到发给 @${employee.name} 的邮件「${message.subject || '（无主题）'}」（来自 ${message.from}），已交给它处理。`,
    clientMessageId: `mail:${row.id}:${message.id}`,
    understood: {
      employeeId: employee.id,
      work: `处理这封发到 ${row.address} 的来信。完成后，你最后的汇报只写要回复给对方的邮件正文（不要写别的说明）；如果不需要回复，汇报写「无需回复」。\n\n${mailText(message)}`.slice(0, 6000),
    },
  });
  if (posted.task) {
    state.threads = { ...Object.fromEntries(Object.entries(state.threads ?? {}).slice(-199)), [message.conversationId]: posted.task.id };
    state.tasks = { ...state.tasks, [posted.task.id]: { messageId: message.id, from: message.from, subject: message.subject } };
  }
  await dispatch(posted.task);
}

/** Mail in an administrator's "Super Agent" folder: that administrator speaking to Super Agent in the command room. */
async function adminMail(row: AccountConnection, message: MailMessage): Promise<void> {
  const user: UserContext = { tenantId: row.tenantId, userId: row.owner.id, roles: ['admin'], projectScopes: [] };
  await receiveRoomMessage({
    user, headers: {},
    body: { roomId: MAIL_ROOM_ID, clientMessageId: `mail:${row.id}:${message.id}`, body: `（邮件）${message.subject ? message.subject + '\n' : ''}${message.text}`.slice(0, 6000) },
  }, { code: () => ({ send: (payload: unknown) => payload }) });
}

/** Reports on tasks that came in by mail become replies, sent according to the mailbox's rule. */
async function draftReplies(row: AccountConnection, state: MailState, token: string, now: string): Promise<void> {
  const room = roomState.current;
  for (const [taskId, source] of Object.entries(state.tasks ?? {})) {
    if (source.drafted) continue;
    const task = room.listTasks(SYSTEM).find((item) => item.id === taskId);
    if (!task) { source.drafted = true; continue; }
    if (task.status === 'cancelled') { source.drafted = true; continue; }
    if (task.status !== 'completed') continue;
    source.drafted = true;
    const report = room.eventsAfter(MAIL_ROOM_ID, 0, SYSTEM).filter((message) => message.kind === 'report' && message.taskIds.includes(taskId)).at(-1)?.body.trim() ?? '';
    const say = (body: string) => room.announce({ roomId: MAIL_ROOM_ID, tenantId: row.tenantId, body, clientMessageId: `mail-reply:${row.id}:${taskId}`, taskIds: [taskId] });
    if (!report || /^无需回复[。.!！]?$/.test(report)) continue;
    if (row.sendRule === 'deny') { say(`${row.address} 设为「不允许发邮件」，T-${taskId.replace('task_', '')} 的回复没有发出。`); continue; }
    const draft: MailDraft = {
      id: randomUUID(), tenantId: row.tenantId, accountId: row.id, address: row.address, employeeId: row.owner.id, taskId, messageId: source.messageId,
      to: source.from, subject: source.subject.startsWith('Re:') ? source.subject : `Re: ${source.subject}`, body: report.slice(0, 20_000),
      status: 'pending', createdAt: now, decidedBy: null, decidedAt: null, note: '',
    };
    if (!(await mailState.drafts.add(draft))) continue;
    if (row.sendRule === 'allow') {
      try {
        await mailState.client.reply(token, draft.messageId, draft.body);
        await mailState.drafts.save({ ...draft, status: 'sent', decidedBy: 'rule', decidedAt: now });
        say(`已按设置从 ${row.address} 直接回复 ${draft.to}（${draft.subject}）。`);
      } catch (error) {
        await mailState.drafts.save({ ...draft, note: error instanceof Error ? error.message : String(error) });
        say(`从 ${row.address} 回复 ${draft.to} 没有成功，草稿放在「待我处理」里，请检查后再发。`);
      }
    } else {
      say(`给 ${draft.to} 的回复草稿（${draft.subject}）已放进「待我处理」，确认后才会从 ${row.address} 发出。`);
    }
  }
  await flushRoom();
}

/** One pass over every mailbox with mail turned on. Returns how many messages were handled. */
export async function pollMail(service: AccountService, now: () => number = Date.now): Promise<number> {
  let handled = 0;
  for (const row of await service.mailAccounts()) {
    // Every mailbox is read inside its own company: its tasks go to that company's room only.
    handled += await runAsTenant(row.tenantId, () => pollOne(service, row, now));
  }
  return handled;
}

async function pollOne(service: AccountService, row: AccountConnection, now: () => number): Promise<number> {
  let handled = 0;
  {
    const at = new Date(now()).toISOString();
    const state: MailState = structuredClone(row.mailState ?? {});
    try {
      const { token } = await service.accountAccess(row.tenantId, actorOf(row), row.id);
      const folder = row.owner.kind === 'admin' ? state.folderId ?? await mailState.client.folder(token, SUPER_AGENT_FOLDER) : 'inbox';
      if (row.owner.kind === 'admin') state.folderId = folder;
      const since = state.cursor ?? at;
      const seen = new Set(state.seen ?? []);
      const messages = (await mailState.client.newMail(token, folder, since)).filter((message) => !seen.has(message.id) && message.from.toLowerCase() !== row.address.toLowerCase());
      for (const message of messages) {
        if (row.owner.kind === 'admin') await adminMail(row, message); else await employeeMail(row, message, state);
        seen.add(message.id);
        handled++;
        state.received = (state.received ?? 0) + 1;
        if (message.receivedAt > (state.cursor ?? '')) state.cursor = message.receivedAt;
      }
      state.cursor ??= since;
      state.seen = [...seen].slice(-200);
      if (row.owner.kind === 'employee') await draftReplies(row, state, token, at);
      state.error = null;
    } catch (error) {
      state.error = error instanceof AccountError ? error.message : '读取邮件失败，稍后会再试。';
    }
    state.checkedAt = at;
    await service.saveMailState(row.tenantId, row.id, () => state);
  }
  return handled;
}

export function startMailPoller(service: () => AccountService, everyMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void pollMail(service()).catch((error: unknown) => console.warn(`mail poller failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Who may send or drop a draft: owners and admins, and the person responsible for the employee who wrote it. */
function mayDecide(user: UserContext, draft: MailDraft): boolean {
  if (user.roles.includes('owner') || user.roles.includes('admin')) return true;
  return roomState.current.roster({ userId: user.userId, roles: user.roles, projectScopes: user.projectScopes })
    .some((employee) => employee.id === draft.employeeId && employee.ownerUserId === user.userId);
}

/** /api/v1/mail: reply drafts waiting for a person ("ask me first"). */
export const mailModule: FastifyPluginAsync = async (app) => {
  app.get('/drafts', async (req) => {
    const user = req.user!;
    const drafts = (await mailState.drafts.pending(user.tenantId)).filter((draft) => mayDecide(user, draft));
    const roster = roomState.current.roster(SYSTEM);
    return { drafts: drafts.map((draft) => ({ ...draft, employeeName: roster.find((item) => item.id === draft.employeeId)?.name ?? null })) };
  });

  app.post<{ Params: { id: string } }>('/drafts/:id/send', async (req, reply) => {
    const user = req.user!;
    const draft = await mailState.drafts.get(user.tenantId, req.params.id);
    if (!draft || draft.status !== 'pending' || !mayDecide(user, draft)) return reply.code(404).send({ error: 'not_found' });
    const input = (req.body ?? {}) as { body?: unknown };
    const body = typeof input.body === 'string' && input.body.trim() ? input.body.trim().slice(0, 20_000) : draft.body;
    const service = mailState.accounts?.();
    if (!service) return reply.code(503).send({ error: 'not_configured' });
    const account = await service.find(user.tenantId, draft.accountId);
    if (!account) return reply.code(409).send({ error: 'account_gone', message: '这个邮箱已经断开，草稿不能发出。' });
    if (account.sendRule === 'deny') return reply.code(409).send({ error: 'send_denied', message: '这个邮箱设为不允许发邮件。' });
    try {
      const { token } = await service.accountAccess(user.tenantId, { kind: 'employee', id: draft.employeeId }, draft.accountId);
      await mailState.client.reply(token, draft.messageId, body);
    } catch (error) {
      const message = error instanceof AccountError ? error.message : '发送失败，请稍后再试。';
      return reply.code(502).send({ error: 'send_failed', message });
    }
    const at = new Date().toISOString();
    await mailState.drafts.save({ ...draft, body, status: 'sent', decidedBy: user.userId, decidedAt: at });
    roomState.current.announce({ roomId: MAIL_ROOM_ID, tenantId: user.tenantId, body: `已从 ${draft.address} 回复 ${draft.to}（${draft.subject}）。`, clientMessageId: `mail-sent:${draft.id}`, taskIds: [draft.taskId] });
    await flushRoom();
    return { sent: true };
  });

  app.post<{ Params: { id: string } }>('/drafts/:id/discard', async (req, reply) => {
    const user = req.user!;
    const draft = await mailState.drafts.get(user.tenantId, req.params.id);
    if (!draft || draft.status !== 'pending' || !mayDecide(user, draft)) return reply.code(404).send({ error: 'not_found' });
    await mailState.drafts.save({ ...draft, status: 'discarded', decidedBy: user.userId, decidedAt: new Date().toISOString() });
    return { discarded: true };
  });
};
