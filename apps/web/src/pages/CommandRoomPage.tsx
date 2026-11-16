import { useCallback, useEffect, useRef, useState } from 'react';
import './execution.css';
import { authHeaders } from '../api';
import { translate, useLang, useT, type Dict, type Lang } from '../i18n';

/**
 * Command room (PRD §3.7), layout and copy from the accepted v12 prototype. Everything on the page comes from the
 * server: the people and digital employees from /room/roster (which reads the employee module), the conversation
 * from /room/stream, the tasks from /room/tasks. There is no sample transcript; an empty room is shown as empty.
 * Root stays fixed; the transcript and the task list scroll.
 */
const ROOM_ID = 'room-1';
const POLL_MS = 4000;

export type MessageKind = 'message' | 'reply' | 'report' | 'review' | 'cancel' | 'hold' | 'resume' | 'contract';

export interface ApiMessage {
  id: string;
  seq: number;
  authorUserId: string;
  body: string;
  taskIds: string[];
  kind?: MessageKind;
}

export interface ApiTask {
  id: string;
  title: string;
  status: string;
  assigneeUserId: string;
  waitingReason: string | null;
  employeeId?: string;
  messageId?: string;
  createdByUserId?: string;
  followupTo?: string | null;
  promptSnapshot?: { employeeId: string; promptVersion: number | null; modelTier: string | null; takenAt: string } | null;
  approval?: 'none' | 'required';
  reviewedByUserId?: string | null;
  evidence?: { fields: { subject: string | null; body: string | null }; sent: boolean } | null;
  verification?: 'none' | 'verified' | 'failed';
  inputSupplement?: string | null;
  hold?: { reason: string; responsible: string } | null;
  contract?: { criteria: string; version: number; revisedByUserId: string; at: string } | null;
  runId?: string | null;
}

/** The linked run as the server reports it: its approvals and the external attempts the gateway recorded. */
export interface TaskOutcome {
  runId: string;
  runStatus: string;
  eventId: string;
  approvals: Array<{ id: string; status: string; standing: boolean; actionStatus: string | null }>;
  attempts: number;
  actions: Array<{ stepId: string; status: string; calls: number; externalRef: string | null; readback: unknown }>;
}

/**
 * Page text in both languages (English is the default; the Chinese is the accepted v12 prototype wording, unchanged).
 * The exported helpers take a language and default to Chinese so the existing unit tests keep their meaning.
 */
const TEXT = {
  en: {
    runCompleted: 'Completed', runRunning: 'Running', runWaitingHuman: 'Waiting for a person', runBlocked: 'Blocked', runUnknown: 'Outcome unknown', runFailed: 'Failed',
    approvalStanding: 'Approval in force', approvalRetired: 'Approval withdrawn', approvalMissing: 'Not yet approved',
    readUnknown: ', outcome unknown', readConfirmed: ', read-back matches',
    attempts: 'Submitted externally {n} time(s){read}. Changing the acceptance contract does not resubmit.',
    stateActive: 'Online', statePaused: 'Paused', stateOffline: 'Offline', stateUnconnected: 'Not connected',
    digitalEmployee: 'Digital employee',
    taskDone: 'Completed', taskCancelled: 'Cancelled', taskRejected: 'Returned', taskUnknown: 'Outcome unknown', taskWaiting: 'Waiting', taskRunning: 'In progress',
    waitConnection: 'Waiting for connection', waitInput: 'Waiting for input', waitModel: 'Waiting for model', waitOwner: 'Waiting for owner authorization',
    unsent: 'Not sent yet', fillIn: 'Please fill this in',
    kindReport: 'Report', kindReview: 'Review', kindCancel: 'Cancel', kindHold: 'Waiting for connection', kindResume: 'Resume', kindContract: 'Acceptance contract',
    kindTask: 'Task', kindReply: 'Reply', kindAssign: 'Assignment', kindMessage: 'Message',
    actorSuperAgent: 'Super agent', actorMe: 'Me', actorColleague: 'Colleague',
    refNotAssignee: 'Only the assigned colleague can report this task.', refClosed: 'This task has ended and can no longer be changed.',
    refReported: 'This task is already reported complete; it cannot be held or sent back for input.', refNotReported: 'Nothing has been reported yet.',
    refEvidence: 'Evidence check failed; this does not count as complete.', refEmptySupplement: 'Please fill in what to add.',
    refForbidden: 'You cannot do this to this task.', refNotFound: 'Task not found.',
    refOffline: 'The digital employee has not reconnected. Resume it in Digital employees first, then resume this task.',
    refContractUnchanged: 'The acceptance contract did not change.', refInvalidContract: 'Describe what counts as done (2,000 characters at most).',
    refNotWaiting: 'This task is not waiting for a connection.',
    sendFailed: 'This message was not sent. Your draft is still here; you can send it again.',
    actionFailed: 'That did not work.', actionRetry: 'That did not work; you can try again.',
    supplementFailed: 'The supplement was not saved.', contractFailed: 'The acceptance contract was not saved.',
    contractRetry: 'The acceptance contract was not saved; you can try again.',
    roomLabel: 'Agent Room command room', title: 'Agent Room',
    leadEmployee: 'Follow the digital employees you are responsible for: tasks given to them, their reports and follow-ups are all here.',
    leadOwner: 'One shared piece of work: the business owner, the super agent and digital employees share goals, context, tasks and reports.',
    configureBrain: 'Configure super agent',
    logLabel: 'Shared collaboration log', logTitle: 'Shared collaboration log', logHint: 'Shows task reasons and result summaries, not hidden chain-of-thought',
    emptyRoom: 'No conversation yet. Small talk only gets a reply; to assign work, @ a digital employee and say what needs doing.',
    offline: 'Cannot reach the command room right now; retrying automatically.', loadingRoom: 'Loading the command room…',
    viewTask: 'View task', sendTo: 'Send to the command room', followingUp: 'Follow-up: {title}', stopFollowup: 'Stop following up',
    followupPlaceholder: 'Write the follow-up. The original task’s employee and context come along.',
    draftPlaceholder: 'Small talk only gets a reply. To assign work, @ a digital employee.',
    chooseEmployee: 'Choose a digital employee', noEmployees: 'No digital employees can be assigned yet.',
    send: 'Send', mention: '@ Mention', composerHint: 'Enter to send, Shift+Enter for a new line. New messages from colleagues do not clear your draft',
    noticeLabel: 'Command room notice',
    tasksLabel: 'Task list', tasksTitle: 'Tasks', tasksHint: 'Created from the conversation, linked back to the message',
    noItems: 'Nothing yet', noTasks: 'No tasks from the conversation yet.',
    drawerLabel: 'Task details', drawerTitle: 'Task details', close: 'Close',
    overview: 'Overview', status: 'Status', assignee: 'Assigned to', yours: ' (you are responsible)',
    source: 'Source message', sourceMissing: 'The original message is not in the visible log.', backToSource: 'Back to the original message',
    followupOf: 'Follow-up of', originalMissing: 'The original task is not in the visible list.', openOriginal: 'Open the original task',
    snapshot: 'Prompt snapshot', snapshotLine: 'Prompt version {version} · model tier {tier} · assigned {at}', notRecorded: 'not recorded',
    noSnapshot: 'No prompt snapshot was recorded for this task.',
    basis: 'Basis and permissions', basisExternal: 'This is an external action: it must be approved in My work before it runs. Assigning it here is not authorization.',
    basisReadOnly: 'Read-only or drafting; no action approval needed. Only this employee’s authorized sources are used.',
    contract: 'Acceptance contract', contractLine: 'Version {version}: {criteria}', noContract: 'No acceptance contract yet.',
    execution: 'Execution and external actions', runLine: 'Event {event} · {status}', loadingRun: 'Loading execution record…',
    results: 'Results and evidence', noReports: 'No reports yet.', viewInChat: 'View in the conversation',
    reportedDone: 'Reported complete.', evidenceFailed: 'Evidence check failed; this does not count as complete.', responsible: 'Responsible: {name}',
    supplement: 'Supplementary material', saveSupplement: 'Save supplement',
    editContract: 'Edit acceptance contract', writeContract: 'Write acceptance contract',
    contractPlaceholder: 'What counts as done, e.g. amount, supplier and product number must be checked',
    contractWarning: 'Saving a new version voids the earlier completion and action approvals; external submissions and read-back evidence already made are kept.',
    saveContract: 'Save contract', reportContent: 'Report', submitReport: 'Submit report',
    review: 'Approve review', followup: 'Follow up', resumeTask: 'Resume task', cancelTask: 'Cancel task',
  },
  zh: {
    runCompleted: '已完成', runRunning: '进行中', runWaitingHuman: '等待人工', runBlocked: '已阻塞', runUnknown: '结果未知', runFailed: '失败',
    approvalStanding: '批准有效', approvalRetired: '批准已作废', approvalMissing: '尚未批准',
    readUnknown: '，结果未知', readConfirmed: '，回读一致',
    attempts: '外部提交 {n} 次{read}。修改验收契约不会重新提交。',
    stateActive: '在线', statePaused: '已暂停', stateOffline: '不在线', stateUnconnected: '未连接',
    digitalEmployee: '数字员工',
    taskDone: '已完成', taskCancelled: '已取消', taskRejected: '已退回', taskUnknown: '结果未知', taskWaiting: '等待', taskRunning: '进行中',
    waitConnection: '等待连接', waitInput: '等待补充', waitModel: '等待模型', waitOwner: '等待企业负责人授权',
    unsent: '尚未发送', fillIn: '请填写',
    kindReport: '回报', kindReview: '复核', kindCancel: '取消', kindHold: '等待连接', kindResume: '恢复', kindContract: '验收契约',
    kindTask: '任务', kindReply: '回复', kindAssign: '派活', kindMessage: '消息',
    actorSuperAgent: '超级智能体', actorMe: '我', actorColleague: '同事',
    refNotAssignee: '只有被指派的同事能回报这条任务。', refClosed: '这条任务已经结束，不能再改。',
    refReported: '这条任务已经回报完成，不能挂起或要求补充。', refNotReported: '还没有回报，不能操作。',
    refEvidence: '证据核验未通过，不能算完成。', refEmptySupplement: '请填写要补充的内容。',
    refForbidden: '你不能对这条任务做这个操作。', refNotFound: '找不到这条任务。',
    refOffline: '数字员工还没有重新连接。请先在「数字员工」里恢复它，再恢复这条任务。',
    refContractUnchanged: '验收契约没有变化。', refInvalidContract: '请写清楚怎样才算完成（不超过 2000 字）。',
    refNotWaiting: '这条任务没有在等待连接。',
    sendFailed: '这条消息没有发出去，草稿还在，可以再发一次。',
    actionFailed: '这个操作没有成功。', actionRetry: '这个操作没有成功，可以再试一次。',
    supplementFailed: '补充没有保存。', contractFailed: '验收契约没有保存。',
    contractRetry: '验收契约没有保存，可以再试一次。',
    roomLabel: 'Agent Room 指挥室', title: 'Agent Room 指挥室',
    leadEmployee: '跟进自己负责的数字员工：交给它的任务、它的回报和追问都在这里。',
    leadOwner: '同一件工作里，企业负责人、超级智能体和数字员工共享目标、上下文、任务与回报。',
    configureBrain: '配置超级智能体',
    logLabel: '共享协作记录', logTitle: '共享协作记录', logHint: '展示任务理由与结果摘要，不展示隐藏思维链',
    emptyRoom: '还没有对话。闲聊只会得到回复；要派活请 @数字员工 并说清楚要做的事。',
    offline: '暂时连不上指挥室，稍后会自动重试。', loadingRoom: '正在读取指挥室…',
    viewTask: '查看任务', sendTo: '发给指挥室', followingUp: '追问：{title}', stopFollowup: '不追问了',
    followupPlaceholder: '写下要追问的内容，原任务的员工和上下文会带上。',
    draftPlaceholder: '闲聊只会得到回复。要派活请 @数字员工。',
    chooseEmployee: '选择数字员工', noEmployees: '还没有可以指派的数字员工。',
    send: '发送', mention: '@ 提及', composerHint: 'Enter 发送，Shift+Enter 换行。同事的新消息不会清掉这里的草稿',
    noticeLabel: '指挥室提示',
    tasksLabel: '任务列表', tasksTitle: '任务', tasksHint: '由对话产生，链回原消息',
    noItems: '暂无事项', noTasks: '当前没有由对话产生的任务。',
    drawerLabel: '任务详情', drawerTitle: '任务详情', close: '关闭',
    overview: '概览', status: '状态', assignee: '指派', yours: '（由你负责）',
    source: '来源消息', sourceMissing: '原消息不在当前可见的记录里。', backToSource: '回到原消息',
    followupOf: '追问自', originalMissing: '原任务不在当前可见的列表里。', openOriginal: '打开原任务',
    snapshot: '提示词快照', snapshotLine: '提示词第 {version} 版 · 模型档位 {tier} · 交办于 {at}', notRecorded: '未记录',
    noSnapshot: '这条任务没有记录提示词快照。',
    basis: '依据与权限', basisExternal: '这是对外动作：执行前要在「待我处理」里批准，这里交办不等于授权。',
    basisReadOnly: '只读或起草，不需要动作审批。只使用该员工被授权的来源。',
    contract: '验收契约', contractLine: '第 {version} 版：{criteria}', noContract: '还没有写验收契约。',
    execution: '执行与外部动作', runLine: '事件 {event} · {status}', loadingRun: '正在读取执行记录…',
    results: '结果与证据', noReports: '还没有回报。', viewInChat: '在对话里看',
    reportedDone: '已回报完成。', evidenceFailed: '证据核验未通过，不能算完成。', responsible: '负责人：{name}',
    supplement: '补充资料', saveSupplement: '保存补充',
    editContract: '修改验收契约', writeContract: '写验收契约',
    contractPlaceholder: '怎样才算完成，例如：必须核对金额、供应商和产品编号',
    contractWarning: '保存新版本后，之前的完成状态和动作批准作废；已有的外部提交和回读证据保留。',
    saveContract: '保存契约', reportContent: '回报内容', submitReport: '提交回报',
    review: '复核通过', followup: '追问', resumeTask: '恢复任务', cancelTask: '取消任务',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;
const tr = (lang: Lang, key: Key, vars?: Record<string, string | number>) => translate(TEXT, lang, key, vars);

const RUN_STATUS: Record<string, Key> = {
  completed: 'runCompleted', running: 'runRunning', waiting_human: 'runWaitingHuman', blocked: 'runBlocked', outcome_unknown: 'runUnknown', failed: 'runFailed',
};

/** Server waiting reasons are stable Chinese identifiers; they are compared as-is and only translated for display. */
const WAITING_REASONS: Record<string, Key> = {
  等待连接: 'waitConnection', 等待补充: 'waitInput', 等待模型: 'waitModel', 等待企业负责人授权: 'waitOwner',
};

/** Whether an approval still authorises anything. A retired one is closed with no decision. */
export function approvalLine(approval: TaskOutcome['approvals'][number], lang: Lang = 'zh'): string {
  if (approval.standing) return tr(lang, 'approvalStanding');
  return tr(lang, approval.status === 'closed' || approval.status === 'withdrawn' ? 'approvalRetired' : 'approvalMissing');
}

/** The external attempts the gateway recorded for the run, and what the read-back said. */
export function attemptsLine(outcome: Pick<TaskOutcome, 'attempts' | 'actions'>, lang: Lang = 'zh'): string {
  const statuses = outcome.actions.map((action) => action.status);
  const read = statuses.includes('outcome_unknown') ? tr(lang, 'readUnknown') : statuses.includes('confirmed') ? tr(lang, 'readConfirmed') : '';
  return tr(lang, 'attempts', { n: outcome.attempts, read });
}

export function runStatusLabel(status: string, lang: Lang = 'zh'): string {
  const key = RUN_STATUS[status];
  return key ? tr(lang, key) : status;
}


export interface RosterEmployee {
  id: string;
  name: string;
  duty: string;
  status: 'active' | 'paused' | 'offline' | 'unconnected';
  ownerUserId: string;
}

export interface RoomViewer {
  userId: string;
  roles: string[];
  owner: boolean;
}

interface Roster {
  viewer: RoomViewer;
  employees: RosterEmployee[];
}

/** One-shot SSE body from GET /api/v1/room/stream. A broken frame is skipped. */
export function roomEventsFromSse(body: string): ApiMessage[] {
  return body.split('\n\n').flatMap((block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (!data) return [];
    try {
      const message = JSON.parse(data) as ApiMessage;
      if (typeof message?.id !== 'string' || typeof message.body !== 'string') return [];
      return [{ ...message, taskIds: Array.isArray(message.taskIds) ? message.taskIds : [] }];
    } catch {
      return [];
    }
  });
}

export function roomDraftKey(key: string, shift: boolean): 'send' | 'newline' {
  return key === 'Enter' && !shift ? 'send' : 'newline';
}

export function nextRoomCursor(messages: readonly ApiMessage[], after: number): number {
  return messages.reduce((max, message) => (Number.isFinite(message.seq) ? Math.max(max, message.seq) : max), after);
}

/** Adds messages the page does not have yet and keeps the room's order. A message already shown is not replaced. */
export function mergeRoomMessages(current: readonly ApiMessage[], incoming: readonly ApiMessage[]): ApiMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const added = incoming.filter((message) => !seen.has(message.id) && (seen.add(message.id), true));
  if (added.length === 0) return current as ApiMessage[];
  const order = (message: ApiMessage) => (Number.isFinite(message.seq) ? message.seq : Number.MAX_SAFE_INTEGER);
  return [...current, ...added].sort((a, b) => order(a) - order(b));
}

/** Picking an employee writes "@name " into the draft. A trailing "@" the person just typed is not doubled. */
export function insertMention(draft: string, name: string): string {
  const base = draft.endsWith('@') ? draft.slice(0, -1) : draft;
  const gap = base === '' || /\s$/u.test(base) ? '' : ' ';
  return `${base}${gap}@${name} `;
}

/** Drafts are kept per signed-in person, so one person's unsent text never shows up under another identity. */
export function draftStorageKey(userId: string): string {
  return `superagent.room-draft.${ROOM_ID}.${userId}`;
}

function readDraft(userId: string): string {
  try {
    return window.localStorage.getItem(draftStorageKey(userId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(userId: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(draftStorageKey(userId), value);
    else window.localStorage.removeItem(draftStorageKey(userId));
  } catch {
    // Storage can be unavailable (private window); the draft then lives only in this page.
  }
}

const EMPLOYEE_STATE: Record<RosterEmployee['status'], Key> = {
  active: 'stateActive',
  paused: 'statePaused',
  offline: 'stateOffline',
  unconnected: 'stateUnconnected',
};

export function employeeName(employees: readonly RosterEmployee[], employeeId: string | undefined, lang: Lang = 'zh'): string {
  return employees.find((employee) => employee.id === employeeId)?.name ?? tr(lang, 'digitalEmployee');
}

/** A waiting reason the server sent; known ones are translated, anything else is shown as sent. */
export function waitingReasonLabel(reason: string | null, lang: Lang = 'zh'): string {
  if (reason === null) return tr(lang, 'taskWaiting');
  const key = WAITING_REASONS[reason];
  return key ? tr(lang, key) : reason;
}

export function taskStatusLabel(task: Pick<ApiTask, 'status' | 'waitingReason'>, lang: Lang = 'zh'): string {
  if (task.status === 'completed' || task.status === 'reviewed' || task.status === 'reported') return tr(lang, 'taskDone');
  if (task.status === 'cancelled') return tr(lang, 'taskCancelled');
  if (task.status === 'rejected') return tr(lang, 'taskRejected');
  if (task.status === 'outcome_unknown') return tr(lang, 'taskUnknown');
  if (task.status === 'waiting') return waitingReasonLabel(task.waitingReason, lang);
  return tr(lang, 'taskRunning');
}

export function taskLine(task: ApiTask, employees: readonly RosterEmployee[], lang: Lang = 'zh'): string {
  return `${taskStatusLabel(task, lang)} · ${employeeName(employees, task.employeeId, lang)}`;
}

/** An unsent draft says so. The evidence object itself is never printed. ('草稿' is the server's draft-title marker.) */
export function unsentDraftBoundary(task: Pick<ApiTask, 'title' | 'evidence'>, lang: Lang = 'zh'): string | null {
  if (!task.evidence || task.evidence.sent) return null;
  if (!task.title.includes('草稿')) return null;
  return tr(lang, 'unsent');
}

/** Drawer overview: the title and, for an unsent draft, the boundary. No implementation JSON. */
export function resultOverview(task: Pick<ApiTask, 'title' | 'evidence'>, lang: Lang = 'zh'): string {
  const boundary = unsentDraftBoundary(task, lang);
  return boundary ? `${task.title}${lang === 'zh' ? '。' : '. '}${boundary}` : task.title;
}

export function supplementError(text: string, lang: Lang = 'zh'): string | null {
  return text.trim() ? null : tr(lang, 'fillIn');
}

/** Incoming room events do not replace a workflow draft the person is still editing. */
export function applyAsyncReport<T>(draft: T): T {
  return draft;
}

/** The reports attached to a task, oldest first. Only a report counts: follow-ups and notices are not results. */
export function taskReports(task: Pick<ApiTask, 'id'>, messages: readonly ApiMessage[]): ApiMessage[] {
  return messages.filter((message) => message.kind === 'report' && message.taskIds.includes(task.id));
}

const OPEN_STATUS = new Set(['assigned', 'running', 'waiting']);

/** What this person may do with a task. The server decides again on every call; this only hides dead buttons. */
export interface TaskActions { report: boolean; review: boolean; cancel: boolean; followup: boolean; resume: boolean; contract: boolean }

/** A task held because its employee disconnected. Only reconnecting the employee and resuming it moves it on. */
export function waitingForConnection(task: Pick<ApiTask, 'status' | 'waitingReason'>): boolean {
  return task.status === 'waiting' && task.waitingReason === '等待连接';
}

export function taskActions(task: ApiTask, viewer: RoomViewer | null): TaskActions {
  if (!viewer) return { report: false, review: false, cancel: false, followup: false, resume: false, contract: false };
  const asked = viewer.owner || task.createdByUserId === viewer.userId;
  return {
    report: task.assigneeUserId === viewer.userId && OPEN_STATUS.has(task.status),
    review: false,
    cancel: asked && OPEN_STATUS.has(task.status),
    followup: (asked || task.assigneeUserId === viewer.userId) && task.status !== 'cancelled',
    resume: asked && waitingForConnection(task),
    contract: asked && task.status !== 'cancelled',
  };
}

export function messageKindLabel(message: ApiMessage, tasks: readonly ApiTask[], lang: Lang = 'zh'): string {
  if (message.kind === 'report') return tr(lang, 'kindReport');
  if (message.kind === 'review') return tr(lang, 'kindReview');
  if (message.kind === 'cancel') return tr(lang, 'kindCancel');
  if (message.kind === 'hold') return tr(lang, 'kindHold');
  if (message.kind === 'resume') return tr(lang, 'kindResume');
  if (message.kind === 'contract') return tr(lang, 'kindContract');
  if (message.kind === 'reply') return tr(lang, message.taskIds.length > 0 ? 'kindTask' : 'kindReply');
  return tr(lang, tasks.some((task) => task.messageId === message.id) ? 'kindAssign' : 'kindMessage');
}

export function actorLabel(message: ApiMessage, viewer: RoomViewer | null, tasks: readonly ApiTask[], employees: readonly RosterEmployee[], lang: Lang = 'zh'): string {
  if (message.authorUserId === 'super-agent') return tr(lang, 'actorSuperAgent');
  if (message.kind === 'report') {
    const task = tasks.find((item) => message.taskIds.includes(item.id));
    return employeeName(employees, task?.employeeId, lang);
  }
  return tr(lang, viewer && message.authorUserId === viewer.userId ? 'actorMe' : 'actorColleague');
}

const REFUSALS: Record<string, Key> = {
  not_assignee: 'refNotAssignee',
  task_closed: 'refClosed',
  task_reported: 'refReported',
  not_reported: 'refNotReported',
  evidence_failed: 'refEvidence',
  empty_supplement: 'refEmptySupplement',
  forbidden: 'refForbidden',
  task_not_found: 'refNotFound',
  employee_offline: 'refOffline',
  contract_unchanged: 'refContractUnchanged',
  invalid_contract: 'refInvalidContract',
  not_waiting: 'refNotWaiting',
};

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function CommandRoomPage() {
  const [lang] = useLang();
  const t = useT(TEXT);
  const refusal = (code: string | undefined, fallback: Key) => t(REFUSALS[code ?? ''] ?? fallback);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [offline, setOffline] = useState(false);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [draft, setDraft] = useState('');
  const [followupId, setFollowupId] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [reportDraft, setReportDraft] = useState('');
  const [supplementDraft, setSupplementDraft] = useState('');
  const [supplementHelp, setSupplementHelp] = useState('');
  const [contractDraft, setContractDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ taskId: string; data: TaskOutcome | null } | null>(null);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);

  const cursor = useRef(0);
  const pulling = useRef(false);
  const pullAgain = useRef(false);
  const pending = useRef<{ id: string; body: string; followupTo: string | null } | null>(null);
  const actionId = useRef<{ key: string; id: string } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const caretAfterMention = useRef<string | null>(null);

  const viewer = roster?.viewer ?? null;
  const viewerId = viewer?.userId ?? null;
  const employees = roster?.employees ?? [];

  const pull = useCallback(async () => {
    if (pulling.current) {
      pullAgain.current = true;
      return;
    }
    pulling.current = true;
    try {
      const headers = await authHeaders();
      const [rosterRes, streamRes, tasksRes] = await Promise.all([
        fetch(`/api/v1/room/roster?roomId=${ROOM_ID}`, { headers }),
        fetch(`/api/v1/room/stream?roomId=${ROOM_ID}&after=${cursor.current}`, { headers }),
        fetch(`/api/v1/room/tasks?roomId=${ROOM_ID}`, { headers }),
      ]);
      if (!rosterRes.ok || !streamRes.ok || !tasksRes.ok) {
        setOffline(true);
        return;
      }
      const nextRoster = (await rosterRes.json()) as Roster;
      const incoming = roomEventsFromSse(await streamRes.text());
      const data = (await tasksRes.json()) as { tasks?: ApiTask[] };
      setOffline(false);
      setRoster(nextRoster);
      cursor.current = nextRoomCursor(incoming, cursor.current);
      setMessages((current) => mergeRoomMessages(current, incoming));
      setTasks((data.tasks ?? []).filter((task) => typeof task.id === 'string' && typeof task.title === 'string'));
    } catch {
      setOffline(true);
    } finally {
      pulling.current = false;
      if (pullAgain.current) {
        pullAgain.current = false;
        void pull();
      }
    }
  }, []);

  useEffect(() => {
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(timer);
  }, [pull]);

  // The saved draft belongs to the signed-in person. It is restored once they are known and never over typed text.
  useEffect(() => {
    if (!viewerId) return;
    const saved = readDraft(viewerId);
    if (saved) setDraft((current) => (current === '' ? saved : current));
  }, [viewerId]);

  // New messages keep the view at the latest line only while the reader is already there (or has just sent one).
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function changeDraft(value: string) {
    setDraft(value);
    if (viewerId) writeDraft(viewerId, value);
    if (value.endsWith('@')) setMentionOpen(true);
  }

  function pickMention(name: string) {
    const next = insertMention(draft, name);
    caretAfterMention.current = next;
    changeDraft(next);
    setMentionOpen(false);
    input.current?.focus();
  }

  // Typing continues right after the inserted name. The caret moves only if the box still holds exactly what the
  // picker wrote: once the person has typed, moving it would split their text and break the mention.
  useEffect(() => {
    const el = input.current;
    const want = caretAfterMention.current;
    if (!el || want === null) return;
    caretAfterMention.current = null;
    if (el.value === want) el.setSelectionRange(want.length, want.length);
  }, [draft]);

  async function sendDraft() {
    const body = draft.trim();
    if (!body || sending || !viewerId) return;
    const same = pending.current && pending.current.body === body && pending.current.followupTo === followupId;
    const id = same ? pending.current!.id : newId('web');
    pending.current = { id, body, followupTo: followupId };
    setSending(true);
    setNotice('');
    try {
      const response = await fetch('/api/v1/room/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ roomId: ROOM_ID, body, clientMessageId: id, followupTo: followupId }),
      });
      if (!response.ok) {
        setNotice(t('sendFailed'));
        return;
      }
      const data = (await response.json()) as { message: ApiMessage; reply: ApiMessage | null };
      pending.current = null;
      stick.current = true;
      setMessages((current) => mergeRoomMessages(current, [data.message, ...(data.reply ? [data.reply] : [])]));
      setDraft('');
      writeDraft(viewerId, '');
      setFollowupId(null);
      setMentionOpen(false);
      void pull();
    } catch {
      setNotice(t('sendFailed'));
    } finally {
      setSending(false);
    }
  }

  /** report / review / cancel. The same click retried keeps its client id, so it lands once. */
  async function act(task: ApiTask, action: 'report' | 'review' | 'cancel' | 'resume', text?: string) {
    if (acting) return;
    const key = `${action}:${task.id}:${text ?? ''}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId(`web-${action}`);
    actionId.current = { key, id };
    setActing(true);
    setNotice('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ clientMessageId: id, ...(action === 'report' ? { body: text } : {}) }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setNotice(refusal(error?.error, 'actionFailed'));
        return;
      }
      const message = (await response.json()) as ApiMessage;
      actionId.current = null;
      setMessages((current) => mergeRoomMessages(current, [message]));
      if (action === 'report') setReportDraft('');
      void pull();
    } catch {
      setNotice(t('actionRetry'));
    } finally {
      setActing(false);
    }
  }

  async function saveSupplement(task: ApiTask) {
    const help = supplementError(supplementDraft, lang);
    if (help) {
      setSupplementHelp(help);
      return;
    }
    if (acting) return;
    const key = `supplement:${task.id}:${supplementDraft.trim()}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId('web-supplement');
    actionId.current = { key, id };
    setActing(true);
    setSupplementHelp('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/supplement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ text: supplementDraft.trim(), clientMessageId: id }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setSupplementHelp(error?.error === 'empty_supplement' ? t('fillIn') : t('supplementFailed'));
        return;
      }
      actionId.current = null;
      setSupplementDraft('');
      void pull();
    } catch {
      setSupplementHelp(t('supplementFailed'));
    } finally {
      setActing(false);
    }
  }

  // The linked run's approvals and attempts, read again whenever the task list refreshes while the drawer is open.
  useEffect(() => {
    if (!openTaskId) return;
    let stop = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(openTaskId)}/outcome`, { headers: await authHeaders() });
        if (!response.ok || stop) return;
        const data = (await response.json()) as { outcome: TaskOutcome | null };
        if (!stop) setOutcome({ taskId: openTaskId, data: data.outcome });
      } catch {
        // The drawer keeps the last outcome it had.
      }
    })();
    return () => {
      stop = true;
    };
  }, [openTaskId, tasks]);

  async function saveContract(task: ApiTask) {
    const criteria = (contractDraft ?? '').trim();
    if (acting || !criteria) return;
    const key = `contract:${task.id}:${criteria}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId('web-contract');
    actionId.current = { key, id };
    setActing(true);
    setNotice('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/contract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ criteria, clientMessageId: id }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setNotice(refusal(error?.error, 'contractFailed'));
        return;
      }
      const data = (await response.json()) as { message: ApiMessage };
      actionId.current = null;
      setContractDraft(null);
      setMessages((current) => mergeRoomMessages(current, [data.message]));
      void pull();
    } catch {
      setNotice(t('contractRetry'));
    } finally {
      setActing(false);
    }
  }

  function jumpTo(messageId: string) {
    stick.current = false;
    setFocusMessageId(messageId);
    document.getElementById(`room-msg-${messageId}`)?.scrollIntoView({ block: 'center' });
  }

  function openTaskDrawer(id: string | null) {
    setContractDraft(null);
    setOpenTaskId(id);
  }

  function startFollowup(task: ApiTask) {
    setFollowupId(task.id);
    input.current?.focus();
  }

  const openTask = tasks.find((task) => task.id === openTaskId) ?? null;
  const openOutcome = outcome && openTask && outcome.taskId === openTask.id ? outcome.data : null;
  const followupTask = tasks.find((task) => task.id === followupId) ?? null;
  const source = openTask ? messages.find((message) => message.id === openTask.messageId) ?? null : null;
  const original = openTask?.followupTo ? tasks.find((task) => task.id === openTask.followupTo) ?? null : null;
  const reports = openTask ? taskReports(openTask, messages) : [];
  const may = openTask ? taskActions(openTask, viewer) : null;
  const employeeView = viewer !== null && !viewer.owner;

  return (
    <section className="exec-room" aria-label={t('roomLabel')} data-view={viewer ? (viewer.owner ? 'owner' : 'employee') : 'loading'}>
      <div className="page-head">
        <h1>{t('title')}</h1>
        <p>
          {employeeView
            ? t('leadEmployee')
            : t('leadOwner')}
        </p>
        {viewer?.owner ? <a className="exec-action" href="#brain">{t('configureBrain')}</a> : null}
      </div>
      <div className="exec-grid">
        <section className="panel exec-pane" aria-label={t('logLabel')}>
          <div className="exec-pane-head">
            <h2>{t('logTitle')}</h2>
            <span>{t('logHint')}</span>
          </div>
          <div
            className="exec-scroll exec-stream"
            ref={scroller}
            onScroll={(event) => {
              const el = event.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {messages.length === 0 ? (
              <p className="exec-empty">{roster ? t('emptyRoom') : offline ? t('offline') : t('loadingRoom')}</p>
            ) : messages.map((message) => (
              <article
                key={message.id}
                id={`room-msg-${message.id}`}
                data-message={message.id}
                data-kind={message.kind ?? 'message'}
                className={`exec-message${focusMessageId === message.id ? ' exec-message-focus' : ''}`}
              >
                <header>
                  <strong>{actorLabel(message, viewer, tasks, employees, lang)}</strong>
                  <span>{messageKindLabel(message, tasks, lang)}</span>
                </header>
                <p>{message.body}</p>
                {message.taskIds.filter((id) => tasks.some((task) => task.id === id)).slice(-1).map((id) => (
                  <button type="button" className="exec-link" key={id} data-open-task={id} onClick={() => openTaskDrawer(id)}>{t('viewTask')}</button>
                ))}
              </article>
            ))}
          </div>
          <form className="exec-composer" onSubmit={(event) => { event.preventDefault(); void sendDraft(); }}>
            <label htmlFor="room-draft">{t('sendTo')}</label>
            {followupTask ? (
              <p className="exec-followup" data-followup={followupTask.id}>
                <span>{t('followingUp', { title: followupTask.title })}</span>
                <button type="button" onClick={() => setFollowupId(null)}>{t('stopFollowup')}</button>
              </p>
            ) : null}
            <textarea
              id="room-draft"
              ref={input}
              value={draft}
              disabled={!viewer}
              onChange={(event) => changeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && mentionOpen) {
                  setMentionOpen(false);
                  return;
                }
                if (event.nativeEvent.isComposing || roomDraftKey(event.key, event.shiftKey) !== 'send') return;
                event.preventDefault();
                void sendDraft();
              }}
              placeholder={followupTask ? t('followupPlaceholder') : t('draftPlaceholder')}
            />
            {mentionOpen ? (
              <div className="exec-mentions" role="listbox" aria-label={t('chooseEmployee')}>
                {employees.length === 0 ? (
                  <p>{t('noEmployees')}</p>
                ) : employees.map((employee) => (
                  <button type="button" role="option" aria-selected="false" key={employee.id} data-mention={employee.id} onClick={() => pickMention(employee.name)}>
                    <strong>@{employee.name}</strong>
                    <span>{[employee.duty, t(EMPLOYEE_STATE[employee.status])].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="exec-composer-actions">
              <button type="submit" disabled={sending || !viewer}>{t('send')}</button>
              <button type="button" aria-haspopup="listbox" aria-expanded={mentionOpen} disabled={!viewer} onClick={() => setMentionOpen((open) => !open)}>{t('mention')}</button>
              <span>{t('composerHint')}</span>
            </div>
            <p className="exec-notice" role="status" aria-label={t('noticeLabel')}>{notice}</p>
          </form>
        </section>
        <aside className="panel exec-pane" aria-label={t('tasksLabel')}>
          <div className="exec-pane-head">
            <h2>{t('tasksTitle')}</h2>
            <span>{t('tasksHint')}</span>
          </div>
          <div data-outcome="summary">
            {tasks.length === 0 ? <p>{t('noItems')}</p> : (
              <ul>
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="outcome-message-card"
                      data-outcome="summary-message"
                      onClick={() => { if (task.messageId) jumpTo(task.messageId); setOpenTaskId(task.id); }}
                    >
                      {task.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="exec-scroll">
            {tasks.length === 0 ? (
              <p className="exec-empty">{t('noTasks')}</p>
            ) : tasks.map((task) => (
              <button type="button" className="exec-task" key={task.id} data-task={task.id} data-status={task.status} onClick={() => openTaskDrawer(task.id)}>
                <strong>{task.title}</strong>
                <span>{taskLine(task, employees, lang)}</span>
              </button>
            ))}
          </div>
        </aside>
        {openTask && may ? (
          <aside className="panel exec-drawer" aria-label={t('drawerLabel')} data-task-detail={openTask.id}>
            <div className="exec-pane-head">
              <h2>{t('drawerTitle')}</h2>
              <button type="button" onClick={() => openTaskDrawer(null)}>{t('close')}</button>
            </div>
            <dl>
              <div><dt>{t('overview')}</dt><dd data-overview>{resultOverview(openTask, lang)}</dd></div>
              <div><dt>{t('status')}</dt><dd data-status>{taskStatusLabel(openTask, lang)}</dd></div>
              <div><dt>{t('assignee')}</dt><dd data-assignee>@{employeeName(employees, openTask.employeeId, lang)}{openTask.assigneeUserId === viewerId ? t('yours') : ''}</dd></div>
              <div>
                <dt>{t('source')}</dt>
                <dd data-source>
                  {source ? source.body : t('sourceMissing')}
                  {source ? <button type="button" className="exec-link" onClick={() => jumpTo(source.id)}>{t('backToSource')}</button> : null}
                </dd>
              </div>
              {openTask.followupTo ? (
                <div>
                  <dt>{t('followupOf')}</dt>
                  <dd data-followup-of>
                    {original ? original.title : t('originalMissing')}
                    {original ? <button type="button" className="exec-link" onClick={() => openTaskDrawer(original.id)}>{t('openOriginal')}</button> : null}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('snapshot')}</dt>
                <dd data-snapshot>
                  {openTask.promptSnapshot
                    ? t('snapshotLine', { version: openTask.promptSnapshot.promptVersion ?? '?', tier: openTask.promptSnapshot.modelTier ?? t('notRecorded'), at: openTask.promptSnapshot.takenAt })
                    : t('noSnapshot')}
                </dd>
              </div>
              <div>
                <dt>{t('basis')}</dt>
                <dd data-approval>
                  {openTask.approval === 'required'
                    ? t('basisExternal')
                    : t('basisReadOnly')}
                </dd>
              </div>
              <div>
                <dt>{t('contract')}</dt>
                <dd data-contract>
                  {openTask.contract ? t('contractLine', { version: openTask.contract.version, criteria: openTask.contract.criteria }) : t('noContract')}
                </dd>
              </div>
              {openTask.runId ? (
                <div>
                  <dt>{t('execution')}</dt>
                  <dd data-outcome>
                    {openOutcome ? (
                      <>
                        <p data-run={openOutcome.runId}>{t('runLine', { event: openOutcome.eventId, status: runStatusLabel(openOutcome.runStatus, lang) })}</p>
                        <ul>
                          {openOutcome.approvals.map((approval) => (
                            <li key={approval.id} data-approval-item={approval.id} data-standing={approval.standing ? 'yes' : 'no'}>{approvalLine(approval, lang)}</li>
                          ))}
                        </ul>
                        <p data-attempts={openOutcome.attempts}>{attemptsLine(openOutcome, lang)}</p>
                      </>
                    ) : t('loadingRun')}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('results')}</dt>
                <dd data-evidence>
                  {reports.length === 0 ? t('noReports') : (
                    <ul>
                      {reports.map((report) => (
                        <li key={report.id}>
                          {report.body}
                          <button type="button" className="exec-link" onClick={() => jumpTo(report.id)}>{t('viewInChat')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {openTask.status === 'completed' || openTask.status === 'reviewed' || openTask.status === 'reported' ? <p>{t('reportedDone')}</p> : null}
                  {openTask.verification === 'failed' ? <p>{t('evidenceFailed')}</p> : null}
                  {unsentDraftBoundary(openTask) ? <p data-boundary>{unsentDraftBoundary(openTask)}</p> : null}
                  {openTask.hold ? <p data-blocker>{t('responsible', { name: openTask.hold.responsible })}</p> : null}
                </dd>
              </div>
            </dl>
            {openTask.waitingReason === '等待补充' ? (
              <div className="exec-report">
                <label htmlFor="outcome-input">{t('supplement')}</label>
                <input id="outcome-input" value={supplementDraft} onChange={(event) => setSupplementDraft(event.target.value)} />
                <p id="outcome-input-help">{supplementHelp}</p>
                <button type="button" data-outcome="save-input" disabled={acting} onClick={() => void saveSupplement(openTask)}>{t('saveSupplement')}</button>
              </div>
            ) : null}
            {may.contract ? (
              <div className="exec-report">
                <label htmlFor="room-contract">{openTask.contract ? t('editContract') : t('writeContract')}</label>
                <textarea
                  id="room-contract"
                  value={contractDraft ?? openTask.contract?.criteria ?? ''}
                  onChange={(event) => setContractDraft(event.target.value)}
                  placeholder={t('contractPlaceholder')}
                />
                {openTask.contract ? <p className="exec-empty">{t('contractWarning')}</p> : null}
                <button type="button" disabled={acting || (contractDraft ?? '').trim() === ''} onClick={() => void saveContract(openTask)}>{t('saveContract')}</button>
              </div>
            ) : null}
            {may.report ? (
              <div className="exec-report">
                <label htmlFor="room-report">{t('reportContent')}</label>
                <textarea id="room-report" value={reportDraft} onChange={(event) => setReportDraft(event.target.value)} />
                <button type="button" disabled={acting || reportDraft.trim() === ''} onClick={() => void act(openTask, 'report', reportDraft.trim())}>{t('submitReport')}</button>
              </div>
            ) : null}
            <div className="exec-composer-actions">
              {may.review ? <button type="button" data-review disabled={acting || openTask.verification === 'failed'} onClick={() => void act(openTask, 'review')}>{t('review')}</button> : null}
              {may.followup ? <button type="button" onClick={() => startFollowup(openTask)}>{t('followup')}</button> : null}
              {may.resume ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'resume')}>{t('resumeTask')}</button> : null}
              {may.cancel ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'cancel')}>{t('cancelTask')}</button> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
