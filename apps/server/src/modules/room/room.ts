import { isLinkAgent, type TaskStatus } from '@superagent/shared';
import { asksAvailability, asksPresence, isExternalAction, isGreeting, needsParameters, workText, askedTaskNumber, smallTalkReply } from './intent.js';
import {
  acceptSupplement, applyAsyncReport, evidenceFromReport, permissionHold, resultOverview, summaryLabel, verificationOf,
  type ResultEvidence, type ResultHold, type ResultVerification,
} from './result-gate.js';

export interface Viewer {
  userId: string;
  roles: Array<'admin' | 'owner' | 'employee' | 'reviewer'>;
  projectScopes: string[];
}

export interface EmployeeRef {
  id: string;
  name: string;
  /** The person responsible for this digital employee. Tasks given to it are theirs to see and report on. */
  ownerUserId: string;
  status: 'active' | 'paused' | 'offline' | 'unconnected';
  duty?: string;
  promptVersion?: number;
  modelTier?: string;
}

/** A fixed list (tests) or a live read of the digital-employee registry. */
export type EmployeeSource = EmployeeRef[] | (() => EmployeeRef[]);

export interface RoomMessage {
  id: string;
  seq: number;
  roomId: string;
  tenantId: string;
  authorUserId: string;
  body: string;
  clientMessageId: string;
  mentions: string[];
  taskIds: string[];
  /** message: someone speaking. reply: the super agent answering. report / review / cancel: an event on a task. */
  kind: MessageKind;
}

export type MessageKind = 'message' | 'reply' | 'report' | 'review' | 'cancel' | 'hold' | 'resume' | 'contract' | 'nudge';

/** What counts as done for a task. Each revision is a new version; acceptance is always against the current one. */
export interface TaskContract {
  criteria: string;
  version: number;
  revisedByUserId: string;
  at: string;
}

/** What the employee was running with when the task was handed over. */
export interface PromptSnapshot {
  employeeId: string;
  promptVersion: number | null;
  modelTier: string | null;
  takenAt: string;
}

export interface RoomTask {
  id: string;
  tenantId: string;
  roomId: string;
  projectId: string | null;
  messageId: string;
  assigneeUserId: string;
  employeeId: string;
  title: string;
  status: TaskStatus;
  waitingReason: string | null;
  createdByUserId: string;
  /** The task this one continues. The employee and project carry over from it. */
  followupTo: string | null;
  promptSnapshot: PromptSnapshot | null;
  /** "required" when the request is an outward action; reading and drafting need none. */
  approval: 'none' | 'required';
  reviewedByUserId: string | null;
  /** Structured result. Null until someone reports. Never rendered by stringifying it. */
  evidence: ResultEvidence | null;
  verification: ResultVerification;
  inputSupplement: string | null;
  /** Set while the task is waiting on a person. Cleared on release; the task id stays. */
  hold: ResultHold | null;
  contract: TaskContract | null;
  /** The execution run that carries this task's external action, linked by the runtime or the person who asked. */
  runId: string | null;
  /** What Super Agent, as the room's project manager, tracks about this task (see supervise()). */
  watch?: TaskWatch | null;
}

/** Super Agent's notes on an open task: since when it has been in its current state, retries and reminders. */
/** A task Super Agent wants sent to its computer again, with what it will tell the room once it was sent. */
export interface RetryRequest { task: RoomTask; body: string }

export interface TaskWatch {
  /** status + waiting reason it was last seen in; a change restarts the clock. */
  state: string;
  /** ISO time the task entered that state, or last showed progress. */
  since: string;
  /** Times Super Agent sent it to the computer again since a person last asked to retry (caps automatic retries). */
  attempts: number;
  /** Every time the task was sent again, never reset: Link runs a wake whose number is higher than the last it ran. */
  sends?: number;
  /** Reminders posted in the current state. */
  nudges: number;
  lastNudgeAt: string | null;
}

export interface RoomSnapshot {
  seq: number;
  messages: RoomMessage[];
  tasks: RoomTask[];
  members: Array<{ roomId: string; userIds: string[] }>;
}

export interface PostInput {
  roomId: string;
  tenantId: string;
  projectId?: string | null;
  authorUserId: string;
  authorRoles?: Viewer['roles'];
  authorProjectScopes?: string[];
  /** When false, a real assignment is kept and marked waiting for the model. */
  modelAvailable?: boolean;
  body: string;
  clientMessageId: string;
  /** Continue an earlier task instead of naming an employee again. */
  followupTo?: string | null;
  /**
   * Super Agent's reading of a message that names nobody: hand it to this employee as this work, or answer it.
   * Only a roster employee the author may assign is used; everything else still goes through the checks below.
   */
  understood?: { employeeId: string; work: string } | { answer: string } | null;
  /** Store the message now and answer later through answerDeferred() (Super Agent is still reading it). */
  defer?: boolean;
  /**
   * Work Super Agent started itself (a scheduled workflow, incoming mail). Anything it sends out is gated where it is
   * sent (a mailbox's sending rule), so the task needs no approval of its own. Never set from a person's message.
   */
  systemWork?: boolean;
}

const OPEN: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['assigned', 'running', 'waiting']);
const COMPLETED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'reviewed']);
const WAITING_CONNECTION = '等待连接';
const WAITING_FAILED = '执行失败';
const WAITING_SIGN_IN = '等待本地登录';
const ACTIVE = (employee: EmployeeRef | undefined) => employee?.status === 'active';

/** Set by the running app: a bound Link computer may still be working for this employee (see workers/presence). */
export const roomHooks: { linkMayBeOnline: (employeeId: string) => boolean } = { linkMayBeOnline: () => false };

/**
 * Link reports a task that stopped without a result with fixed texts (apps/link). They move the task out of
 * "running" so the room shows it failed or is waiting for the computer's sign-in, instead of "in progress".
 */
export function workerUpdateState(body: string): 'progress' | 'failed' | 'needs_sign_in' {
  const text = body.trim();
  const signIn = /^([a-z-]+) requires sign-in\.$/.exec(text);
  if (signIn && isLinkAgent(signIn[1])) return 'needs_sign_in';
  if (text.startsWith('Agent CLI did not return a completed result.') || text === 'Agent CLI could not be started.'
    || text === 'Project directory or local agent is unavailable.' || text === 'Codex App Server could not be started.'
    || text === 'Codex App Server disconnected.' || text === 'Codex App Server ended without a final response.') return 'failed';
  return 'progress';
}

function isOwner(viewer: Pick<Viewer, 'roles'>): boolean {
  return viewer.roles.includes('owner') || viewer.roles.includes('admin');
}

/** Rows written before messages carried a kind: a reply is known by its client id, a report by its task link. */
function kindOf(message: RoomMessage, tasks: readonly RoomTask[]): MessageKind {
  if (message.kind) return message.kind;
  if (message.clientMessageId.startsWith('reply:')) return 'reply';
  const isSource = tasks.some((task) => task.messageId === message.id);
  return message.taskIds.length > 0 && !isSource && message.authorUserId !== 'super-agent' ? 'report' : 'message';
}

/** Fields added after the first room snapshots were written get their defaults here. */
function withDefaults(task: RoomTask): RoomTask {
  return {
    ...task,
    createdByUserId: task.createdByUserId ?? '',
    followupTo: task.followupTo ?? null,
    promptSnapshot: task.promptSnapshot ? { ...task.promptSnapshot } : null,
    approval: task.approval ?? 'none',
    reviewedByUserId: task.reviewedByUserId ?? null,
    evidence: task.evidence
      ? {
          fields: { subject: task.evidence.fields?.subject ?? null, body: task.evidence.fields?.body ?? null },
          sent: task.evidence.sent === true,
        }
      : null,
    verification: task.verification === 'verified' || task.verification === 'failed' ? task.verification : 'none',
    inputSupplement: task.inputSupplement ?? null,
    hold: task.hold?.toolId ? { reason: task.hold.reason, responsible: task.hold.responsible, toolId: task.hold.toolId } : null,
    contract: task.contract ? { ...task.contract } : null,
    runId: task.runId ?? null,
    watch: task.watch ? { ...task.watch } : null,
  };
}

const MINUTE = 60_000;
/** Super Agent retries a task on the computer at most this many times before handing the decision to a person. */
const MAX_ATTEMPTS = 2;
/** Reminders per state, and the gap between them. */
const MAX_NUDGES = 3;
const NUDGE_EVERY = 120 * MINUTE;

/** "task_153" → "T-153". */
/** A task's title as Super Agent's notes quote it: short enough to read in one line (the task holds the full text). */
export function shortTitle(title: string, max = 28): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

export function taskCode(task: Pick<RoomTask, 'id'>): string {
  return `T-${/(\d+)$/.exec(task.id)?.[1] ?? task.id}`;
}

const STATE_TEXT: Record<string, string> = {
  assigned: '已派出，等电脑领取', running: '进行中', waiting: '等待', reported: '已回报，待复核', outcome_unknown: '结果待确认',
  completed: '已完成', reviewed: '已复核', cancelled: '已取消',
};

/** "进行中" / "等待（等待连接）", for the board and the people reading it. */
export function stateText(task: Pick<RoomTask, 'status' | 'waitingReason'>): string {
  return `${STATE_TEXT[task.status] ?? task.status}${task.waitingReason ? `（${task.waitingReason}）` : ''}`;
}

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / MINUTE));
}

/**
 * Command room (PRD §3.7). Messages and tasks stay in the store across reloads.
 * SSE clients pass the last seq they rendered; the same client message id posts once.
 *
 * Small talk, questions and vague outward requests get a reply and no task. A task exists only when someone names
 * a digital employee they may assign and says what to do, or continues a task they can already see.
 */
export class CommandRoom {
  private seq = 0;
  private readonly messages: RoomMessage[] = [];
  private readonly tasks: RoomTask[] = [];
  private readonly byClientId = new Map<string, RoomMessage>();
  /** Messages Super Agent is still reading, with what they were posted with. Process-local: a restart drops them. */
  private readonly deferred = new Map<string, PostInput>();
  private readonly members = new Map<string, Set<string>>();
  private readonly source: EmployeeSource;
  private readonly now: () => Date;

  constructor(employees: EmployeeSource, now: () => Date = () => new Date()) {
    this.source = employees;
    this.now = now;
  }

  private employees(): EmployeeRef[] {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  /** Enough state to rebuild the room after a process restart. */
  snapshot(): RoomSnapshot {
    return {
      seq: this.seq,
      messages: this.messages.map((message) => ({ ...message, mentions: [...message.mentions], taskIds: [...message.taskIds] })),
      tasks: this.tasks.map((task) => withDefaults(task)),
      members: [...this.members.entries()].map(([roomId, userIds]) => ({ roomId, userIds: [...userIds] })),
    };
  }

  static restore(employees: EmployeeSource, saved: RoomSnapshot): CommandRoom {
    const room = new CommandRoom(employees);
    room.seq = saved.seq;
    for (const message of saved.messages) {
      const copy = { ...message, mentions: [...message.mentions], taskIds: [...message.taskIds], kind: kindOf(message, saved.tasks) };
      room.messages.push(copy);
      room.byClientId.set(`${copy.roomId}:${copy.clientMessageId}`, copy);
    }
    for (const task of saved.tasks) room.tasks.push(withDefaults(task));
    for (const member of saved.members) room.members.set(member.roomId, new Set(member.userIds));
    return room;
  }

  addMember(roomId: string, userId: string): void {
    const set = this.members.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.members.set(roomId, set);
  }

  /** The digital employees this person may name: an owner sees all, anyone else only the ones they answer for. */
  roster(viewer: Viewer): EmployeeRef[] {
    return this.employees().filter((employee) => isOwner(viewer) || employee.ownerUserId === viewer.userId);
  }

  hasOpenWork(employeeId: string): boolean {
    return this.tasks.some(task => task.employeeId === employeeId && OPEN.has(task.status));
  }

  /** Tasks for this employee that a computer could still pick up: not started, not held, no approval pending. */
  dispatchableTasks(tenantId: string, employeeId: string): RoomTask[] {
    return this.tasks.filter(task => task.tenantId === tenantId && task.employeeId === employeeId
      && (task.status === 'assigned' || task.status === 'waiting') && task.approval === 'none' && !task.hold);
  }

  post(input: PostInput): { message: RoomMessage; reply: RoomMessage | null; task: RoomTask | null; duplicate: boolean } {
    const key = `${input.roomId}:${input.clientMessageId}`;
    const prior = this.byClientId.get(key);
    if (prior) {
      const task = this.tasks.find((item) => item.messageId === prior.id) ?? null;
      return { message: prior, reply: null, task, duplicate: true };
    }

    const author: Viewer = {
      userId: input.authorUserId,
      // No roles means the caller did not say who they are acting as; room-level callers are owners.
      roles: input.authorRoles && input.authorRoles.length > 0 ? input.authorRoles : ['owner'],
      projectScopes: input.authorProjectScopes ?? [],
    };
    const { mentions, work: named } = this.resolveMentions(input.body);
    const original = input.followupTo ? this.tasks.find((item) => item.id === input.followupTo) ?? null : null;
    const originalVisible = original !== null && original.roomId === input.roomId && this.canSeeTask(original, author);
    const message = this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: input.authorUserId,
      body: input.body,
      clientMessageId: input.clientMessageId,
      mentions: mentions.map((employee) => employee.id),
      // A follow-up belongs with the task it continues, so the people on that task see it.
      taskIds: originalVisible ? [original.id] : [],
      kind: 'message',
    });
    this.byClientId.set(key, message);
    if (input.defer) {
      // Stored now so the person sees it sent; Super Agent's answer follows through answerDeferred().
      this.deferred.set(message.id, input);
      return { message, reply: null, task: null, duplicate: false };
    }
    return this.respond(message, input);
  }

  /** Super Agent's answer to a message it took time to read: the same checks and outcomes as an immediate answer. */
  answerDeferred(messageId: string, understood: PostInput['understood']): { message: RoomMessage; reply: RoomMessage | null; task: RoomTask | null; duplicate: boolean } | null {
    const input = this.deferred.get(messageId);
    const message = this.messages.find((item) => item.id === messageId);
    if (!input || !message) return null;
    this.deferred.delete(messageId);
    return this.respond(message, { ...input, understood });
  }

  private respond(message: RoomMessage, input: PostInput): { message: RoomMessage; reply: RoomMessage | null; task: RoomTask | null; duplicate: boolean } {
    const author: Viewer = {
      userId: input.authorUserId,
      roles: input.authorRoles && input.authorRoles.length > 0 ? input.authorRoles : ['owner'],
      projectScopes: input.authorProjectScopes ?? [],
    };
    const { mentions, work: named } = this.resolveMentions(input.body);
    const original = input.followupTo ? this.tasks.find((item) => item.id === input.followupTo) ?? null : null;
    const originalVisible = original !== null && original.roomId === input.roomId && this.canSeeTask(original, author);
    const say = (body: string, link: { mentions?: string[]; taskIds?: string[] } = {}) => this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: 'super-agent',
      body,
      clientMessageId: `reply:${message.id}`,
      mentions: link.mentions ?? [],
      taskIds: link.taskIds ?? [],
      kind: 'reply',
    });
    const noTask = (body: string) => ({ message, reply: say(body, { taskIds: message.taskIds }), task: null, duplicate: false });

    if (input.followupTo && !originalVisible) return noTask('找不到要追问的任务，这条没有建任务。');

    // Work Super Agent started itself names the employee in its note ("交给 @员工") but carries the work separately:
    // the work it carries is the task, never the note.
    const understood = (input.systemWork && !original) || (!mentions.length && !original) ? input.understood ?? null : null;
    const routed = understood && 'employeeId' in understood
      ? this.roster(author).find((item) => item.id === understood.employeeId) ?? null
      : null;
    const employee = (input.systemWork && routed) || mentions[0] || (original ? this.employees().find((item) => item.id === original.employeeId) ?? null : routed);
    const work = routed && understood && 'work' in understood && understood.work.trim() ? understood.work.trim() : named;
    if (original && !employee) return noTask('原任务的数字员工已经不在了，这条没有建任务。');

    if (employee && this.outsideProject(input, original)) return noTask('这超出了你的项目范围，我不会创建这个任务。');

    const body = input.body.trim();
    if (!employee) {
      if (isGreeting(body)) return noTask('你好。需要派活时直接 @数字员工，并说清楚要做的事。');
      const small = smallTalkReply(body);
      if (small) return noTask(small);
      if (asksAvailability(body)) return noTask(this.availability(author));
      if (understood && 'answer' in understood && understood.answer.trim()) return noTask(understood.answer.trim());
      if (isExternalAction(body)) return noTask('这是对外动作。请先补充具体对象（收件人或单号）、内容和依据，再 @数字员工，我才会建任务。');
      const names = this.roster(author).filter((item) => item.status !== 'paused').slice(0, 3).map((item) => `@${item.name}`);
      return noTask(names.length
        ? `我还没读懂要交给谁。要派活请点名一位数字员工，例如 ${names.join('、')}，再说要做的事。`
        : '现在没有可以派活的数字员工。先到「数字员工」添加一位，再回来派活。');
    }

    if (!isOwner(author) && employee.ownerUserId !== author.userId) {
      return noTask(`@${employee.name} 不在当前身份可以指派的范围内，我不会创建这个任务。`);
    }
    // Naming an employee to greet it or ask after it ("在吗", "你在线吗", "忙吗") gets its state from Super Agent, who
    // watches every employee's work; punctuation alone ("@员工 、") is answered the same way rather than becoming a task.
    if (isGreeting(work) || asksPresence(work) || !/[\p{L}\p{N}]/u.test(work)) {
      return noTask(mentions.map((item) => this.employeeState(item, author)).join('\n'));
    }
    if (!input.systemWork && needsParameters(work)) {
      return noTask('这是对外动作。请先补充具体对象（收件人或单号）、内容和依据，我再交给数字员工。');
    }

    const offline = employee.status === 'paused' || employee.status === 'offline' || employee.status === 'unconnected';
    const modelDown = input.modelAvailable === false;
    const waiting = offline || modelDown;
    const task: RoomTask = {
      id: `task_${message.seq}`,
      tenantId: input.tenantId,
      roomId: input.roomId,
      projectId: input.projectId ?? original?.projectId ?? null,
      messageId: message.id,
      assigneeUserId: employee.ownerUserId,
      employeeId: employee.id,
      // The task is named by the work asked for; who it went to is on the task, not repeated in its name.
      title: work,
      status: waiting ? 'waiting' : 'assigned',
      waitingReason: modelDown ? '等待模型' : offline ? '等待连接' : null,
      createdByUserId: input.authorUserId,
      followupTo: original?.id ?? null,
      promptSnapshot: {
        employeeId: employee.id,
        promptVersion: employee.promptVersion ?? null,
        modelTier: employee.modelTier ?? null,
        takenAt: this.now().toISOString(),
      },
      approval: !input.systemWork && isExternalAction(work) ? 'required' : 'none',
      reviewedByUserId: null,
      // A draft is unsent from the moment it exists. Nothing is marked done until a person reports it.
      evidence: !input.systemWork && work.includes('草稿') ? { fields: { subject: null, body: null }, sent: false } : null,
      verification: 'none',
      inputSupplement: null,
      hold: null,
      contract: null,
      runId: null,
    };
    this.tasks.push(task);
    message.taskIds = original ? [original.id, task.id] : [task.id];
    // The person named the employee and the work themselves: the task is theirs, and Super Agent does not repeat it
    // back. It still watches the task like any other (supervise()) and speaks up when something needs someone.
    const direct = !input.systemWork && !original && mentions[0] === employee;
    if (direct && !waiting) return { message, reply: null, task, duplicate: false };
    const reply = say(
      modelDown
        ? '暂时无法处理。任务已保留，状态是等待模型。'
        : waiting
          ? `已把这件事交给 @${employee.name}，对方当前${employee.status === 'paused' ? '已暂停' : '不在线'}，任务标为等待连接。`
          : original
            ? `已作为「${original.title}」的追问交给 @${employee.name}：${task.title}`
            : `已交给 @${employee.name}：${task.title}`,
      { mentions: [employee.id], taskIds: [task.id] },
    );
    return { message, reply, task, duplicate: false };
  }

  updateFromWorker(taskId: string, tenantId: string, body: string, clientMessageId: string, final: boolean, permitted: (task: RoomTask) => boolean): RoomMessage {
    const task = this.tasks.find((item) => item.id === taskId && item.tenantId === tenantId);
    if (!task || task.approval !== 'none' || !permitted(task)) throw new Error('task_not_found');
    if (task.hold) throw new Error('task_held');
    if (final) return this.report(task.id, task.assigneeUserId, body, clientMessageId);
    const key = task.roomId + ':' + clientMessageId;
    const previous = this.byClientId.get(key);
    if (previous) return previous;
    if (!OPEN.has(task.status)) throw new Error('task_closed');
    // The computer is working on it (again): in progress. Its fixed failure texts say it stopped.
    const state = workerUpdateState(body);
    // Progress from the computer restarts Super Agent's clock on this task.
    if (task.watch) { task.watch.since = this.now().toISOString(); task.watch.nudges = 0; }
    task.status = state === 'progress' ? 'running' : 'waiting';
    task.waitingReason = state === 'progress' ? null : state === 'failed' ? WAITING_FAILED : WAITING_SIGN_IN;
    return this.push({
      roomId: task.roomId,
      tenantId,
      authorUserId: task.assigneeUserId,
      body,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'reply',
    });
  }

  report(taskId: string, authorUserId: string, body: string, clientMessageId: string): RoomMessage {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('task_not_found');
    if (task.assigneeUserId !== authorUserId) throw new Error('not_assignee');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    const text = body.trim();
    if (!text) throw new Error('empty_report');
    task.waitingReason = null;
    task.evidence = evidenceFromReport(text);
    task.verification = verificationOf(task.evidence, { contract: task.contract?.criteria ?? null });
    // Product decision (T-86): an employee report completes the task directly unless evidence verification fails,
    // in which case the task stays in 'assigned' (in-progress) so the assignee can submit a corrected report.
    task.status = task.verification === 'failed' ? 'assigned' : 'completed';
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId,
      body,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'report',
    });
  }

  /** The person who asked, or an owner, withdraws a task that has not been reported yet. */
  cancel(taskId: string, viewer: Viewer, clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (!OPEN.has(task.status)) throw new Error('task_closed');
    task.status = 'cancelled';
    task.waitingReason = null;
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: 'super-agent',
      body: `已取消：${task.title}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'cancel',
    });
  }

  /**
   * Human review step is retired (T-86: report completes the task directly when evidence verifies).
   * Kept as a refusal endpoint so callers get 404/403/409 (evidence_failed / task_closed / not_reported).
   */
  review(taskId: string, viewer: Viewer, _clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.verification === 'failed') throw new Error('evidence_failed');
    if (COMPLETED.has(task.status) || task.status === 'reported' || task.status === 'cancelled') throw new Error('task_closed');
    throw new Error('not_reported');
  }

  /**
   * Re-checks the evidence already stored on the task. The caller cannot supply a replacement body.
   * A linked run's read-back is passed in by the route, which reads it from the gateway.
   * If verification fails, a completed task drops back to 'assigned' so a failed report never counts as completed.
   */
  verifyEvidence(taskId: string, viewer: Viewer, check: { readbackMismatch?: boolean } = {}): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId && task.assigneeUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.verification = verificationOf(task.evidence, {
      contract: task.contract?.criteria ?? null,
      readbackMismatch: check.readbackMismatch === true,
    });
    if (task.verification === 'failed') {
      if (COMPLETED.has(task.status) || task.status === 'reported') task.status = 'assigned';
    } else if (task.verification === 'verified' && task.evidence?.fields.body) {
      task.status = 'completed';
    }
    return task;
  }

  /** Human text for the drawer. Evidence stays structured and is not printed. */
  overview(taskId: string, viewer: Viewer): string {
    const task = this.visibleTask(taskId, viewer);
    return resultOverview(task.title, task.evidence);
  }

  /** Marks the same task as waiting for a supplement. Does not open a second task. */
  askInput(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (COMPLETED.has(task.status) || task.status === 'reported') throw new Error('task_reported');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.status = 'waiting';
    task.waitingReason = '等待补充';
    return task;
  }

  /**
   * Writes a supplement onto the task that asked for it. An empty note is refused.
   * The task id and the length of the task list stay the same.
   */
  supplement(taskId: string, viewer: Viewer, text: string, clientMessageId: string): { task: RoomTask; message: RoomMessage } {
    const task = this.editableTask(taskId, viewer);
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { task, message: prior };
    const accepted = acceptSupplement(text);
    const id = task.id;
    const count = this.tasks.length;
    task.inputSupplement = accepted;
    if (task.waitingReason === '等待补充') {
      task.status = 'assigned';
      task.waitingReason = null;
    }
    if (task.id !== id || this.tasks.length !== count) throw new Error('task_replaced');
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: `已补充：${accepted}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'message',
    });
    return { task, message };
  }

  /** The task waits on one tool, named to the enterprise owner. The task itself is not replaced. */
  holdForPermission(taskId: string, viewer: Viewer, toolId: string): RoomTask {
    const id = toolId.trim();
    if (!id) throw new Error('missing_tool');
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (COMPLETED.has(task.status) || task.status === 'reported') throw new Error('task_reported');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.status = 'waiting';
    task.waitingReason = '等待企业负责人授权';
    task.hold = permissionHold(id);
    return task;
  }

  /**
   * Continues the same task only when the held tool is callable for that employee.
   * The route supplies that fact from the tool card. A request cannot set it.
   */
  releaseHold(taskId: string, viewer: Viewer, clientMessageId: string, gate: { toolUsable: boolean }): { task: RoomTask; message: RoomMessage } {
    const task = this.askedTask(taskId, viewer);
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { task, message: prior };
    if (!task.hold) throw new Error('not_held');
    if (!gate.toolUsable) throw new Error('hold_not_satisfied');
    const id = task.id;
    task.hold = null;
    task.waitingReason = null;
    task.status = 'assigned';
    if (task.id !== id) throw new Error('task_replaced');
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: `已恢复：${task.title}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'message',
    });
    return { task, message };
  }

  /**
   * Work given to an employee that has since gone offline (paused, disconnected) waits for the connection.
   * The task is not cancelled, re-created or handed to someone else, and nothing starts the employee remotely.
   * Called before every room read and write, so the state the page shows is the state the server acts on.
   */
  holdDisconnected(): RoomMessage[] {
    const employees = this.employees();
    const held: RoomMessage[] = [];
    for (const task of this.tasks) {
      if (task.status !== 'assigned' && task.status !== 'running') continue;
      const employee = employees.find((item) => item.id === task.employeeId);
      if (ACTIVE(employee)) continue;
      if (employee && employee.status !== 'paused' && roomHooks.linkMayBeOnline(employee.id)) continue;
      task.status = 'waiting';
      task.waitingReason = WAITING_CONNECTION;
      held.push(this.push({
        roomId: task.roomId,
        tenantId: task.tenantId,
        authorUserId: 'super-agent',
        body: `@${employee?.name ?? '数字员工'} 已断开，任务「${shortTitle(task.title)}」保留为等待连接，没有重建或转交。`,
        clientMessageId: `hold:${task.id}:${this.seq + 1}`,
        mentions: employee ? [employee.id] : [],
        taskIds: [task.id],
        kind: 'hold',
      }));
    }
    return held;
  }

  /**
   * Super Agent as the room's project manager: it watches every open task on the board and keeps work moving.
   * - A task waiting for its computer resumes by itself once that computer is back (the same task, never a new one).
   * - A failed run, or one no computer picked up, is sent again, at most MAX_ATTEMPTS times.
   * - Anything that needs a person (a decision, a sign-in, a supplement, an approval) or a run that has gone quiet
   *   gets a short reminder in the room, at most MAX_NUDGES per state, NUDGE_EVERY apart.
   * Returns the messages it posted and the tasks the caller must send to their computer again.
   */
  supervise(): { messages: RoomMessage[]; retry: RetryRequest[] } {
    const now = this.now();
    const at = now.toISOString();
    const employees = this.employees();
    const messages: RoomMessage[] = [];
    const retry: RetryRequest[] = [];
    for (const task of this.tasks) {
      if (!OPEN.has(task.status)) continue;
      const state = `${task.status}:${task.waitingReason ?? ''}`;
      if (!task.watch || task.watch.state !== state) {
        task.watch = { state, since: at, attempts: task.watch?.attempts ?? 0, nudges: 0, lastNudgeAt: null };
      }
      const watch = task.watch;
      const employee = employees.find((item) => item.id === task.employeeId);
      const name = employee?.name ?? '数字员工';
      const online = Boolean(employee && (ACTIVE(employee) || (employee.status !== 'paused' && roomHooks.linkMayBeOnline(employee.id))));
      const age = minutesSince(watch.since, now);
      const code = taskCode(task);
      const say = (body: string, kind: MessageKind) => {
        messages.push(this.push({
          roomId: task.roomId, tenantId: task.tenantId, authorUserId: 'super-agent', body,
          clientMessageId: `watch:${task.id}:${this.seq + 1}`, mentions: employee ? [employee.id] : [], taskIds: [task.id], kind,
        }));
      };
      // Said and counted only once a computer has the task again: see retried().
      const again = (body: string) => { retry.push({ task, body }); };
      const remind = (firstAfter: number, body: string) => {
        if (age < firstAfter || watch.nudges >= MAX_NUDGES) return;
        if (watch.lastNudgeAt && now.getTime() - new Date(watch.lastNudgeAt).getTime() < NUDGE_EVERY) return;
        watch.nudges += 1;
        watch.lastNudgeAt = at;
        say(body, 'nudge');
      };
      if (task.approval !== 'none' || task.hold) {
        if (task.hold) remind(30, `${code}「${shortTitle(task.title)}」在等企业负责人授权工具 ${task.hold.toolId}，授权后我会让 @${name} 继续。`);
        continue;
      }
      if (task.status === 'waiting' && task.waitingReason === WAITING_CONNECTION) {
        if (online) again(`@${name} 的电脑已在线，我把 ${code}「${shortTitle(task.title)}」重新派给它继续做（同一个任务，没有新建）。`);
        else remind(30, `${code}「${shortTitle(task.title)}」在等 @${name} 的电脑上线，已经 ${age} 分钟。请打开那台电脑上的 Link，上线后我会自动继续。`);
      } else if (task.status === 'waiting' && task.waitingReason === WAITING_FAILED) {
        if (online && watch.attempts < MAX_ATTEMPTS && age >= 1) again(`${code}「${shortTitle(task.title)}」上次执行失败，我已让 @${name} 自动重试（第 ${watch.attempts + 1} 次）。`);
        else if (watch.attempts >= MAX_ATTEMPTS) remind(0, `${code}「${shortTitle(task.title)}」已自动重试 ${watch.attempts} 次仍然失败，需要你决定：补充说明后重试、改派给别人，或取消。`);
      } else if (task.status === 'waiting' && task.waitingReason === WAITING_SIGN_IN) {
        remind(5, `${code}「${shortTitle(task.title)}」在等 @${name} 的电脑完成本地登录（Claude Code / Codex）。登录后我会自动继续。`);
      } else if (task.status === 'waiting' && task.waitingReason === '等待补充') {
        remind(10, `${code}「${shortTitle(task.title)}」还在等你补充信息，补充后 @${name} 会继续。`);
      } else if (task.status === 'waiting' && task.waitingReason === '等待模型') {
        remind(10, `${code}「${shortTitle(task.title)}」在等模型恢复。请到「管理设置」检查模型连接和额度。`);
      } else if (task.status === 'assigned' && online) {
        if (age >= 10 && watch.attempts < MAX_ATTEMPTS) again(`${code}「${shortTitle(task.title)}」派出 ${age} 分钟还没被 @${name} 的电脑领取，我已重新派发。`);
        else if (watch.attempts >= MAX_ATTEMPTS) remind(10, `${code}「${shortTitle(task.title)}」重新派发 ${watch.attempts} 次仍没被领取。请检查 @${name} 那台电脑的 Link 是否在运行、项目是否已绑定。`);
      } else if (task.status === 'running') {
        remind(30, `${code}「${shortTitle(task.title)}」@${name} 已经 ${age} 分钟没有新进展，我在盯着。如果卡住了，可以在任务上取消，或告诉我重试。`);
      }
    }
    return { messages, retry };
  }

  /**
   * The outcome of sending a task again. Sent: it is assigned again, the attempt counts, and the room is told.
   * Not sent (no single computer is bound for this employee): nothing counts, the task keeps its state, and the room
   * hears why, as a reminder (so at most every two hours).
   */
  retried(request: RetryRequest, sent: boolean): RoomMessage | null {
    const note = this.retryNote(request, sent, false);
    if (!note) return null;
    const { task } = request;
    const employee = this.employees().find((item) => item.id === task.employeeId);
    return this.push({
      roomId: task.roomId, tenantId: task.tenantId, authorUserId: 'super-agent', body: note.body,
      clientMessageId: `watch:${task.id}:${this.seq + 1}`, mentions: employee ? [employee.id] : [], taskIds: [task.id], kind: note.kind,
    });
  }

  /**
   * The same outcome as retried(), told in Super Agent's reply to the person who asked instead of as its own message
   * (so the room reads: their request, then one answer). Always says why when it could not send.
   */
  retriedForReply(request: RetryRequest, sent: boolean): string {
    return this.retryNote(request, sent, true)!.body;
  }

  private retryNote(request: RetryRequest, sent: boolean, asked: boolean): { body: string; kind: MessageKind } | null {
    const { task, body } = request;
    const at = this.now().toISOString();
    const employee = this.employees().find((item) => item.id === task.employeeId);
    const watch = task.watch ?? { state: '', since: at, attempts: 0, nudges: 0, lastNudgeAt: null };
    task.watch = watch;
    const post = (text: string, kind: MessageKind) => ({ body: text, kind });
    if (sent) {
      task.status = 'assigned';
      task.waitingReason = null;
      watch.attempts += 1;
      watch.sends = (watch.sends ?? 0) + 1;
      watch.state = 'assigned:';
      watch.since = at;
      watch.nudges = 0;
      watch.lastNudgeAt = null;
      return post(body, 'resume');
    }
    if (!asked) {
      if (watch.lastNudgeAt && this.now().getTime() - new Date(watch.lastNudgeAt).getTime() < NUDGE_EVERY) return null;
      watch.nudges += 1;
      watch.lastNudgeAt = at;
    }
    return post(`${taskCode(task)}「${shortTitle(task.title)}」现在没有电脑能接：@${employee?.name ?? '数字员工'} 没有绑定到唯一的一台电脑和项目。请到「管理设置 → 已连接的电脑」检查绑定，绑好后我会自动派出。`, 'nudge');
  }

  /**
   * "重试 T-5" / "全部重试": a person asks Super Agent to start these open tasks over. Their retry count is reset and each
   * is sent again (the caller sends them and reports through retried()). Returns the tasks it will send, and the
   * numbers it could not use (unknown, not visible, or already finished).
   */
  retryRequested(viewer: Viewer, roomId: string, numbers: number[] | 'all'): { retry: RetryRequest[]; skipped: string[] } {
    const visible = this.listTasks(viewer, roomId);
    const wanted = numbers === 'all'
      ? visible.filter((task) => OPEN.has(task.status))
      : numbers.map((n) => visible.find((task) => task.id === `task_${n}`)).filter((task): task is RoomTask => Boolean(task));
    const skipped = numbers === 'all' ? [] : numbers.filter((n) => !wanted.some((task) => task.id === `task_${n}` && OPEN.has(task.status))).map((n) => `T-${n}`);
    const retry: RetryRequest[] = [];
    for (const task of wanted) {
      if (!OPEN.has(task.status) || task.approval !== 'none' || task.hold) continue;
      if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) continue;
      if (task.watch) task.watch.attempts = 0;
      retry.push({ task, body: `${taskCode(task)}「${shortTitle(task.title)}」已重新派给 @${this.employees().find((item) => item.id === task.employeeId)?.name ?? '数字员工'}（同一个任务，没有新建）。` });
    }
    return { retry, skipped };
  }

  /** The board as Super Agent reads it to a person: every open task, how long it has been so, and what happens next. */
  boardSummary(viewer: Viewer, roomId: string): string {
    const tasks = this.listTasks(viewer, roomId);
    const open = tasks.filter((task) => OPEN.has(task.status));
    const done = tasks.filter((task) => COMPLETED.has(task.status)).length;
    if (!open.length) return `看板上没有未完成的任务（共 ${tasks.length} 个，${done} 个已完成）。`;
    const now = this.now();
    const employees = this.employees();
    const lines = open.slice(-12).map((task) => {
      const name = employees.find((item) => item.id === task.employeeId)?.name ?? '数字员工';
      const age = task.watch ? `，${minutesSince(task.watch.since, now)} 分钟` : '';
      return `- ${taskCode(task)}「${task.title.slice(0, 40)}」@${name}：${stateText(task)}${age}。${this.nextStep(task)}`;
    });
    const more = open.length > 12 ? `\n（另有 ${open.length - 12} 个更早的未完成任务）` : '';
    return `看板上还有 ${open.length} 个未完成（共 ${tasks.length} 个，${done} 个已完成）：\n${lines.join('\n')}${more}`;
  }

  /** What happens next with an open task, in one short clause. */
  private nextStep(task: RoomTask): string {
    if (task.hold) return '等企业负责人授权工具。';
    if (task.status === 'running') return '电脑正在做，我在盯进度。';
    if (task.status === 'assigned') return (task.watch?.attempts ?? 0) >= MAX_ATTEMPTS ? '多次派发没被领取，需要检查那台电脑的 Link。' : '等电脑领取，超时我会重新派发。';
    if (task.waitingReason === WAITING_CONNECTION) return '电脑上线后我会自动继续。';
    if (task.waitingReason === WAITING_FAILED) return (task.watch?.attempts ?? 0) >= MAX_ATTEMPTS ? '已重试仍失败，需要你决定：补充、改派或取消。' : '我会自动重试。';
    if (task.waitingReason === WAITING_SIGN_IN) return '需要那台电脑完成本地登录。';
    if (task.waitingReason === '等待补充') return '需要你补充信息。';
    if (task.waitingReason === '等待模型') return '需要检查模型设置。';
    return '';
  }

  /** The room's other open tasks, for the employee working on this one: the same board everyone in the room sees. */
  boardFor(task: RoomTask): string {
    const employees = this.employees();
    return this.tasks
      .filter((item) => item.roomId === task.roomId && item.tenantId === task.tenantId && item.id !== task.id && OPEN.has(item.status))
      .slice(-10)
      .map((item) => `- ${taskCode(item)} @${employees.find((employee) => employee.id === item.employeeId)?.name ?? '数字员工'}：${item.title.slice(0, 80)}（${stateText(item)}）`)
      .join('\n');
  }

  /** The text Link runs for a task, with the team board as context. Only this task is the work. */
  dispatchPrompt(task: RoomTask): string {
    const board = this.boardFor(task);
    return board
      ? `${task.title}\n\n---\n你在做的是 ${taskCode(task)}，只做这一个任务。下面是指挥室看板上其他未完成的任务，仅供了解团队进度，不要去做：\n${board}`
      : task.title;
  }

  /**
   * The person who asked, or an owner, resumes the same task once its employee is connected again.
   * Still offline is refused; nothing is re-created, and the task keeps its id, source and history.
   */
  resume(taskId: string, viewer: Viewer, clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (task.status !== 'waiting' || task.waitingReason !== WAITING_CONNECTION) throw new Error('not_waiting');
    const employee = this.employees().find((item) => item.id === task.employeeId);
    if (!ACTIVE(employee)) throw new Error('employee_offline');
    task.status = 'assigned';
    task.waitingReason = null;
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: 'super-agent',
      body: `@${employee!.name} 已重新连接，同一任务「${shortTitle(task.title)}」继续进行，没有重建。`,
      clientMessageId,
      mentions: [employee!.id],
      taskIds: [task.id],
      kind: 'resume',
    });
  }

  /** Link the execution run that carries this task's external action. A task carries one run; it is never swapped. */
  linkRun(taskId: string, viewer: Viewer, runId: string): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.runId && task.runId !== runId) throw new Error('run_already_linked');
    task.runId = runId;
    return withDefaults(task);
  }

  /**
   * Set or revise what counts as done. Revising the contract (or setting a contract that existing evidence fails)
   * reopens a completed task to 'assigned' and the caller retires the linked run's action approval. Nothing here runs
   * or repeats an external action, and the task keeps its id, source, reports and run.
   */
  reviseContract(taskId: string, viewer: Viewer, criteria: string, clientMessageId: string): { message: RoomMessage; task: RoomTask; revised: boolean } {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { message: prior, task: withDefaults(task), revised: false };
    const text = criteria.trim();
    if (!text || text.length > 2000) throw new Error('invalid_contract');
    if (task.status === 'cancelled') throw new Error('task_closed');
    if (task.contract?.criteria === text) throw new Error('contract_unchanged');
    const version = (task.contract?.version ?? 0) + 1;
    task.contract = { criteria: text, version, revisedByUserId: viewer.userId, at: this.now().toISOString() };
    const wasCompleted = COMPLETED.has(task.status) || task.status === 'reported';
    if (task.evidence?.fields.body) {
      task.verification = verificationOf(task.evidence, { contract: text });
    }
    if (wasCompleted && (version > 1 || task.verification === 'failed')) {
      task.status = 'assigned';
    }
    task.reviewedByUserId = null;
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: version === 1
        ? `验收契约第 1 版：${text}`
        : `验收契约改为第 ${version} 版：${text}。之前的完成状态和动作批准作废；已有的外部提交和回读证据保留，不会自动重新执行。`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'contract',
    });
    return { message, task: withDefaults(task), revised: version > 1 || (wasCompleted && task.status === 'assigned') };
  }

  /** Visible work only. An empty list is "暂无事项", never a made-up item. */
  summary(viewer: Viewer): { label: '暂无事项' | null; tasks: RoomTask[] } {
    const tasks = this.listTasks(viewer);
    return { label: summaryLabel(tasks.length), tasks };
  }

  /** A report may arrive while a workflow draft is open. The draft is returned untouched. */
  reportBesideDraft<T>(taskId: string, authorUserId: string, body: string, clientMessageId: string, draft: T): { message: RoomMessage; draft: T } {
    const message = this.report(taskId, authorUserId, body, clientMessageId);
    return { message, draft: applyAsyncReport(draft) };
  }

  /** One task as the caller may see it. */
  task(taskId: string, viewer: Viewer): RoomTask {
    return withDefaults(this.visibleTask(taskId, viewer));
  }

  /** Events with seq greater than lastSeq. Unknown rooms and non-members get nothing. */
  eventsAfter(roomId: string, lastSeq: number, viewer: Viewer): RoomMessage[] {
    if (!this.canSeeRoom(roomId, viewer)) return [];
    return this.messages.filter((message) => message.roomId === roomId && message.seq > lastSeq && this.canSeeMessage(message, viewer));
  }

  listTasks(viewer: Viewer, roomId?: string): RoomTask[] {
    return this.tasks.filter((task) => (roomId === undefined || task.roomId === roomId) && this.canSeeTask(task, viewer));
  }

  /** The asker, or an owner. Someone who cannot see the task gets task_not_found. */
  private askedTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    return task;
  }

  /** The asker, the assignee, or an owner. */
  private editableTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId && task.assigneeUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    return task;
  }

  private visibleTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.tasks.find((item) => item.id === taskId);
    // Someone who cannot see the task must not learn that it exists.
    if (!task || !this.canSeeTask(task, viewer)) throw new Error('task_not_found');
    return task;
  }

  /** What Super Agent says when someone asks after one employee: online or not, and what it is working on. */
  private employeeState(employee: EmployeeRef, viewer: Viewer): string {
    const now = this.now();
    const online = ACTIVE(employee) || (employee.status !== 'paused' && roomHooks.linkMayBeOnline(employee.id));
    const where = employee.status === 'paused' ? '已暂停'
      : online ? '在线'
        : employee.status === 'unconnected' ? '还没有连接电脑' : '的电脑现在不在线';
    const open = this.tasks.filter((task) => task.employeeId === employee.id && OPEN.has(task.status) && this.canSeeTask(task, viewer));
    const running = open.filter((task) => task.status === 'running');
    const queued = open.filter((task) => task.status !== 'running');
    const quiet = (task: RoomTask) => task.watch?.state === `${task.status}:${task.waitingReason ?? ''}` ? minutesSince(task.watch.since, now) : 0;
    const parts: string[] = [];
    if (running.length) {
      parts.push(`正在处理 ${running.slice(0, 3).map((task) => {
        const age = quiet(task);
        return `${taskCode(task)}「${shortTitle(task.title)}」${age >= 10 ? `（已 ${age} 分钟没有新进展）` : ''}`;
      }).join('、')}`);
    } else if (online && employee.status !== 'paused') {
      parts.push('现在空闲');
    }
    if (queued.length) {
      parts.push(`还有 ${queued.length} 个任务在等：${queued.slice(0, 3).map((task) => `${taskCode(task)}（${stateText(task)}）`).join('、')}`);
    }
    const stuck = running.find((task) => quiet(task) >= 30);
    const next = stuck
      ? `如果 ${taskCode(stuck)} 卡住了，可以在任务上取消，或告诉我“重试 ${taskCode(stuck)}”。`
      : employee.status === 'paused' ? '恢复这名员工后，它才会接新任务。'
        : !online ? '那台电脑上线后，我会把它的任务继续派过去。'
          : '要派活请直接 @它 并说清楚要做的事。';
    return `@${employee.name} ${where}${parts.length ? '，' + parts.join('；') : ''}。${next}`;
  }

  private availability(viewer: Viewer): string {
    const online = this.roster(viewer).filter((employee) => employee.status === 'active');
    if (online.length === 0) return '当前没有在线的数字员工。';
    return `当前有 ${online.length} 名数字员工在线：${online.map((employee) => employee.name).join('、')}。`;
  }

  private canSeeRoom(roomId: string, viewer: Viewer): boolean {
    if (isOwner(viewer)) return true;
    if (this.members.get(roomId)?.has(viewer.userId)) return true;
    // Whoever answers for a digital employee follows that employee's work here.
    return roomId === 'room-1' && this.employees().some((employee) => employee.ownerUserId === viewer.userId);
  }

  private canSeeTask(task: RoomTask, viewer: Viewer): boolean {
    if (!isOwner(viewer) && task.assigneeUserId !== viewer.userId && task.createdByUserId !== viewer.userId) return false;
    if (viewer.projectScopes.length > 0 && task.projectId && !viewer.projectScopes.includes(task.projectId)) return false;
    return true;
  }

  /**
   * An owner reads the whole room. Anyone else reads what they wrote, the replies to it, and what is attached to a
   * task they can see. Other people's work stays out of view.
   */
  private canSeeMessage(message: RoomMessage, viewer: Viewer): boolean {
    if (isOwner(viewer)) return true;
    if (message.authorUserId === viewer.userId) return true;
    if (message.taskIds.length > 0) {
      return message.taskIds.some((id) => {
        const task = this.tasks.find((item) => item.id === id);
        return task !== undefined && this.canSeeTask(task, viewer);
      });
    }
    if (message.kind === 'reply' && message.clientMessageId.startsWith('reply:')) {
      const parent = this.messages.find((item) => item.id === message.clientMessageId.slice('reply:'.length));
      return parent !== undefined && this.canSeeMessage(parent, viewer);
    }
    // A mention that did not become a task (small talk, a refused request) stays between its author and the owner.
    return false;
  }

  private outsideProject(input: PostInput, original: RoomTask | null): boolean {
    const roles = input.authorRoles ?? [];
    if (roles.includes('owner') || roles.includes('admin') || roles.length === 0) return false;
    const projectId = input.projectId ?? original?.projectId ?? null;
    if (!projectId) return false;
    return !(input.authorProjectScopes ?? []).includes(projectId);
  }

  /**
   * "T-5是什么任务？" answered from the task itself: its title, state and who has it, plus the start of its report.
   * Never a model call, so a question about a task can't be mistaken for a request to do it again.
   */
  answerAboutTask(body: string, viewer: Viewer, roomId: string): string | null {
    const number = askedTaskNumber(body);
    if (number === null) return null;
    const task = this.listTasks(viewer, roomId).find((item) => item.id === `task_${number}`);
    if (!task) return `我看不到 T-${number} 这个任务：它不在这个房间，或不在你能看到的范围里。`;
    const employee = this.employees().find((item) => item.id === task.employeeId)?.name ?? '数字员工';
    const state = stateText(task);
    const report = [...this.messages].reverse().find((message) => message.kind === 'report' && message.taskIds.includes(task.id));
    const summary = report ? `
回报：${report.body.replace(/\s+/g, ' ').trim().slice(0, 160)}${report.body.length > 160 ? '…' : ''}` : '';
    return `T-${number}：${task.title}
状态：${state}；负责：@${employee}。${OPEN.has(task.status) ? this.nextStep(task) : ''}${summary}`;
  }

  /** Whether a message names a digital employee with @, so the room can skip reading it with the model. */
  namesEmployee(body: string): boolean {
    return this.resolveMentions(body).mentions.length > 0;
  }

  hasClientMessage(roomId: string, clientMessageId: string): boolean {
    return this.byClientId.has(`${roomId}:${clientMessageId}`);
  }

  private resolveMentions(body: string): { mentions: EmployeeRef[]; work: string } {
    const aliases = this.employees().flatMap(employee => [employee.name, employee.id]
      .filter(Boolean).map(alias => ({ alias, employee }))).sort((a, b) => b.alias.length - a.alias.length);
    const mentions = new Map<string, EmployeeRef>();
    let cursor = 0;
    let text = '';
    // Email local parts are ASCII; a mention may follow Chinese text directly ("请@销售员工").
    for (const marker of body.matchAll(/(?<![A-Za-z0-9_.+-])@/gu)) {
      const index = marker.index!;
      if (index < cursor) continue;
      const match = aliases.find(({ alias }) => body.startsWith(alias, index + 1)
        && /^[\s@,，。:：!?！？;；]?$/.test(body.charAt(index + 1 + alias.length)));
      if (!match) continue;
      mentions.set(match.employee.id, match.employee);
      text += body.slice(cursor, index) + ' ';
      cursor = index + 1 + match.alias.length;
    }
    return { mentions: [...mentions.values()], work: workText(text + body.slice(cursor)) };
  }

  /** One message from Super Agent (a note from the mail or calendar automation). Posting the same id again returns the first. */
  announce(input: { roomId: string; tenantId: string; body: string; clientMessageId: string; taskIds?: string[]; mentions?: string[]; kind?: MessageKind }): RoomMessage {
    const prior = this.byClientId.get(`${input.roomId}:${input.clientMessageId}`);
    if (prior) return prior;
    return this.push({
      roomId: input.roomId, tenantId: input.tenantId, authorUserId: 'super-agent', body: input.body, clientMessageId: input.clientMessageId,
      mentions: input.mentions ?? [], taskIds: input.taskIds ?? [], kind: input.kind ?? 'reply',
    });
  }

  private push(input: Omit<RoomMessage, 'id' | 'seq'>): RoomMessage {
    const message: RoomMessage = { ...input, id: `msg_${this.seq + 1}`, seq: ++this.seq };
    this.messages.push(message);
    this.byClientId.set(`${message.roomId}:${message.clientMessageId}`, message);
    return message;
  }
}
