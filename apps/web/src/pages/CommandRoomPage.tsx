import { useCallback, useEffect, useRef, useState } from 'react';
import './execution.css';
import { authHeaders } from '../api';
import { useLang, type Lang } from '../i18n';
import { roomMessage, roomText } from './command-room-copy';
import { CommandWorkflowPanel } from './CommandWorkflowPanel';
import { WorkerApprovals } from './WorkerApprovals';
import { Icon } from '../components/Icon';

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

const RUN_STATUS: Record<string, string> = {
  completed: '已完成', running: '进行中', waiting_human: '等待人工', blocked: '已阻塞', outcome_unknown: '结果未知', failed: '失败',
};

/** Whether an approval still authorises anything. A retired one is closed with no decision. */
export function approvalLine(approval: TaskOutcome['approvals'][number], lang: Lang = 'zh'): string {
  if (approval.standing) return roomText('批准有效', lang);
  return roomText(approval.status === 'closed' || approval.status === 'withdrawn' ? '批准已作废' : '尚未批准', lang);
}

/** The external attempts the gateway recorded for the run, and what the read-back said. */
export function attemptsLine(outcome: Pick<TaskOutcome, 'attempts' | 'actions'>, lang: Lang = 'zh'): string {
  const statuses = outcome.actions.map((action) => action.status);
  if (lang === 'en') {
    const read = statuses.includes('outcome_unknown') ? ' Outcome unknown.' : statuses.includes('confirmed') ? ' Readback verified.' : '';
    return 'External attempts: ' + outcome.attempts + '.' + read + ' Editing the acceptance criteria will not resubmit.';
  }
  const read = statuses.includes('outcome_unknown') ? '，结果未知' : statuses.includes('confirmed') ? '，回读一致' : '';
  return `外部提交 ${outcome.attempts} 次${read}。修改验收契约不会重新提交。`;
}

export function runStatusLabel(status: string, lang: Lang = 'zh'): string {
  return roomText(RUN_STATUS[status] ?? status, lang);
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

const EMPLOYEE_STATE: Record<RosterEmployee['status'], string> = {
  active: '在线',
  paused: '已暂停',
  offline: '不在线',
  unconnected: '未连接',
};

export function employeeName(employees: readonly RosterEmployee[], employeeId: string | undefined, lang: Lang = 'zh'): string {
  return employees.find((employee) => employee.id === employeeId)?.name ?? roomText('数字员工', lang);
}

export function taskStatusLabel(task: Pick<ApiTask, 'status' | 'waitingReason'>, lang: Lang = 'zh'): string {
  if (task.status === 'completed' || task.status === 'reviewed' || task.status === 'reported') return roomText('已完成', lang);
  if (task.status === 'cancelled') return roomText('已取消', lang);
  if (task.status === 'rejected') return roomText('已退回', lang);
  if (task.status === 'outcome_unknown') return roomText('结果未知', lang);
  if (task.status === 'waiting') return roomText(task.waitingReason ?? '等待', lang);
  return roomText('进行中', lang);
}

export function taskLine(task: ApiTask, employees: readonly RosterEmployee[], lang: Lang = 'zh'): string {
  return `${taskStatusLabel(task, lang)} · ${employeeName(employees, task.employeeId, lang)}`;
}

/** An unsent draft says so. The evidence object itself is never printed. */
export function unsentDraftBoundary(task: Pick<ApiTask, 'title' | 'evidence'>): '尚未发送' | null {
  if (!task.evidence || task.evidence.sent) return null;
  if (!task.title.includes('草稿')) return null;
  return '尚未发送';
}

/** Drawer overview: the title and, for an unsent draft, the boundary. No implementation JSON. */
export function resultOverview(task: Pick<ApiTask, 'title' | 'evidence'>, lang: Lang = 'zh'): string {
  const boundary = unsentDraftBoundary(task);
  if (boundary && lang === 'en') return task.title + ' (' + roomText(boundary, lang) + ')';
  return boundary ? `${task.title}。${boundary}` : task.title;
}

export function supplementError(text: string): '请填写' | null {
  return text.trim() ? null : '请填写';
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
  if (message.kind === 'report') return roomText('回报', lang);
  if (message.kind === 'review') return roomText('复核', lang);
  if (message.kind === 'cancel') return roomText('取消', lang);
  if (message.kind === 'hold') return roomText('等待连接', lang);
  if (message.kind === 'resume') return roomText('恢复', lang);
  if (message.kind === 'contract') return roomText('验收契约', lang);
  if (message.kind === 'reply') return roomText(message.taskIds.length > 0 ? '任务' : '回复', lang);
  return roomText(tasks.some((task) => task.messageId === message.id) ? '派活' : '消息', lang);
}

export function actorLabel(message: ApiMessage, viewer: RoomViewer | null, tasks: readonly ApiTask[], employees: readonly RosterEmployee[], lang: Lang = 'zh'): string {
  if (message.authorUserId === 'super-agent') return roomText('超级智能体', lang);
  if (message.kind === 'report') {
    const task = tasks.find((item) => message.taskIds.includes(item.id));
    return employeeName(employees, task?.employeeId, lang);
  }
  return roomText(viewer && message.authorUserId === viewer.userId ? '我' : '同事', lang);
}

const REFUSALS: Record<string, string> = {
  not_assignee: '只有被指派的同事能回报这条任务。',
  task_closed: '这条任务已经结束，不能再改。',
  task_reported: '这条任务已经回报完成，不能挂起或要求补充。',
  not_reported: '还没有回报，不能操作。',
  evidence_failed: '证据核验未通过，不能算完成。',
  empty_supplement: '请填写要补充的内容。',
  forbidden: '你不能对这条任务做这个操作。',
  task_not_found: '找不到这条任务。',
  employee_offline: '数字员工还没有重新连接。请先在「数字员工」里恢复它，再恢复这条任务。',
  contract_unchanged: '验收契约没有变化。',
  invalid_contract: '请写清楚怎样才算完成（不超过 2000 字）。',
  not_waiting: '这条任务没有在等待连接。',
};

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function CommandRoomPage() {
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
  const [teamOpen, setTeamOpen] = useState(false);
  // Business workflows live behind a header button (prototype); a #room?workflow= link opens them directly.
  const linkedWorkflow = () => typeof window !== 'undefined' && new URLSearchParams(window.location.hash.split('?')[1] ?? '').has('workflow');
  const [flowsOpen, setFlowsOpen] = useState(linkedWorkflow);
  useEffect(() => {
    const open = () => { if (linkedWorkflow()) setFlowsOpen(true); };
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  const [taskTab, setTaskTab] = useState<'open' | 'review' | 'all'>('all');
  const summaryRef = useRef<HTMLDivElement | null>(null);

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
        setNotice('这条消息没有发出去，草稿还在，可以再发一次。');
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
      setNotice('这条消息没有发出去，草稿还在，可以再发一次。');
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
        setNotice(REFUSALS[error?.error ?? ''] ?? '这个操作没有成功。');
        return;
      }
      const message = (await response.json()) as ApiMessage;
      actionId.current = null;
      setMessages((current) => mergeRoomMessages(current, [message]));
      if (action === 'report') setReportDraft('');
      void pull();
    } catch {
      setNotice('这个操作没有成功，可以再试一次。');
    } finally {
      setActing(false);
    }
  }

  async function saveSupplement(task: ApiTask) {
    const help = supplementError(supplementDraft);
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
        setSupplementHelp(error?.error === 'empty_supplement' ? '请填写' : '补充没有保存。');
        return;
      }
      actionId.current = null;
      setSupplementDraft('');
      void pull();
    } catch {
      setSupplementHelp('补充没有保存。');
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
        setNotice(REFUSALS[error?.error ?? ''] ?? '验收契约没有保存。');
        return;
      }
      const data = (await response.json()) as { message: ApiMessage };
      actionId.current = null;
      setContractDraft(null);
      setMessages((current) => mergeRoomMessages(current, [data.message]));
      void pull();
    } catch {
      setNotice('验收契约没有保存，可以再试一次。');
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
  const [lang] = useLang();
  const t = (copy: string) => roomText(copy, lang);

  const reviewStatus = new Set(['reported', 'outcome_unknown']);
  const tabTasks = taskTab === 'open' ? tasks.filter((task) => OPEN_STATUS.has(task.status))
    : taskTab === 'review' ? tasks.filter((task) => reviewStatus.has(task.status)) : tasks;
  const counts = { open: tasks.filter((task) => OPEN_STATUS.has(task.status)).length, review: tasks.filter((task) => reviewStatus.has(task.status)).length };
  const firstEmployee = employees.find((employee) => employee.status === 'active') ?? employees[0];
  function startWith(text: string) {
    changeDraft(text);
    window.setTimeout(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(text.length, text.length); } }, 0);
  }
  function showSummary() {
    setTaskTab('all');
    summaryRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    summaryRef.current?.focus();
  }

  return (
    <section className="exec-room room" aria-label={t('Agent Room 指挥室')} data-view={viewer ? (viewer.owner ? 'owner' : 'employee') : 'loading'}>
      <div className="page-head room-head">
        <h1>{t('指挥室')}</h1>
        <p>
          {employeeView
            ? t('跟进自己负责的数字员工：交给它的任务、它的回报和追问都在这里。')
            : t('和超级智能体一起，把工作推进到交付。')}
        </p>
        <div className="room-head-actions">
          <button type="button" className="room-head-btn" aria-expanded={teamOpen} aria-controls="room-team" onClick={() => setTeamOpen((open) => !open)}>
            <Icon name="team" /><span>{t('团队')}</span>
          </button>
          <button type="button" className="room-head-btn" onClick={showSummary}><Icon name="summary" /><span>{t('工作摘要')}</span></button>
          {viewer?.owner ? <button type="button" className="room-head-btn" aria-expanded={flowsOpen} onClick={() => setFlowsOpen((open) => !open)}><Icon name="flow" /><span>{t('业务流程')}</span></button> : null}
          {viewer?.owner ? <a className="exec-action room-head-btn" href="#brain"><Icon name="brain" /><span>{t('配置超级智能体')}</span></a> : null}
        </div>
      </div>
      {viewer?.owner ? <>
        {flowsOpen ? <CommandWorkflowPanel defaultOpen /> : null}
        <WorkerApprovals key={viewer.userId} />
      </> : null}
      <div className="exec-grid">
        <section className="panel exec-pane room-chat" aria-label={t('共享协作记录')}>
          <header className="room-chat-head">
            <span className="room-avatar" aria-hidden="true"><Icon name="brain" size={20} /></span>
            <div className="room-chat-id">
              <h2 className="sr-only">{t('共享协作记录')}</h2>
              <strong>{t('超级智能体')}</strong>
              <span>{t('统一协调，按企业规则工作')}</span>
            </div>
            <span className="room-chip">{t('展示任务理由与结果摘要，不展示隐藏思维链')}</span>
          </header>
          <div
            className="exec-scroll exec-stream"
            ref={scroller}
            onScroll={(event) => {
              const el = event.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {messages.length === 0 ? (
              roster && viewer ? (
                <div className="room-welcome">
                  <span className="room-avatar room-avatar-lg" aria-hidden="true"><Icon name="brain" size={26} /></span>
                  <h3>{t('今天，有什么工作要推进？')}</h3>
                  <p className="exec-empty">{t('还没有对话。闲聊只会得到回复；要派活请 @数字员工 并说清楚要做的事。')}</p>
                  <div className="room-starts">
                    <button type="button" className="room-start" onClick={() => startWith(firstEmployee ? `@${firstEmployee.name} ` : '@')}>
                      <Icon name="mail" /><span><strong>{t('交办一项工作')}</strong><small>{firstEmployee ? `@${firstEmployee.name} · ${t('写清要做的事和交付物')}` : t('先在数字员工页确认组织')}</small></span><Icon name="arrow" />
                    </button>
                    <button type="button" className="room-start" onClick={() => startWith(t('今天要推进的目标是：'))}>
                      <Icon name="box" /><span><strong>{t('说说今天的目标')}</strong><small>{t('超级智能体会拆解并建议分工')}</small></span><Icon name="arrow" />
                    </button>
                    <button type="button" className="room-start" onClick={() => setTeamOpen(true)}>
                      <Icon name="team" /><span><strong>{t('看看团队状态')}</strong><small>{t('了解谁在线、谁可以接单')}</small></span><Icon name="arrow" />
                    </button>
                  </div>
                </div>
              ) : <p className="exec-empty">{offline ? t('暂时连不上指挥室，稍后会自动重试。') : t('正在读取指挥室…')}</p>
            ) : messages.map((message) => (
              <article
                key={message.id}
                id={`room-msg-${message.id}`}
                data-message={message.id}
                data-kind={message.kind ?? 'message'}
                data-mine={message.authorUserId === viewerId ? 'yes' : undefined}
                className={`exec-message${focusMessageId === message.id ? ' exec-message-focus' : ''}`}
              >
                <header>
                  <strong>{actorLabel(message, viewer, tasks, employees, lang)}</strong>
                  <span>{messageKindLabel(message, tasks, lang)}</span>
                </header>
                <p>{message.authorUserId === 'super-agent' ? roomMessage(message.body, lang) : message.body}</p>
                {message.taskIds.filter((id) => tasks.some((task) => task.id === id)).slice(-1).map((id) => (
                  <button type="button" className="exec-link" key={id} data-open-task={id} onClick={() => openTaskDrawer(id)}>{t('查看任务')}</button>
                ))}
              </article>
            ))}
          </div>
          <form className="exec-composer room-composer" onSubmit={(event) => { event.preventDefault(); void sendDraft(); }}>
            <label htmlFor="room-draft" className="sr-only">{t('发给指挥室')}</label>
            {followupTask ? (
              <p className="exec-followup" data-followup={followupTask.id}>
                <span>{t('追问：')}{followupTask.title}</span>
                <button type="button" onClick={() => setFollowupId(null)}>{t('不追问了')}</button>
              </p>
            ) : null}
            <div className="room-composer-box">
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
                placeholder={followupTask ? t('写下要追问的内容，原任务的员工和上下文会带上。') : t('发消息，或 @数字员工…')}
              />
              {mentionOpen ? (
                <div className="exec-mentions" role="listbox" aria-label={t('选择数字员工')}>
                  {employees.length === 0 ? (
                    <p>{t('还没有可以指派的数字员工。')}</p>
                  ) : employees.map((employee) => (
                    <button type="button" role="option" aria-selected="false" key={employee.id} data-mention={employee.id} onClick={() => pickMention(employee.name)}>
                      <strong>@{employee.name}</strong>
                      <span>{[employee.duty, t(EMPLOYEE_STATE[employee.status])].filter(Boolean).join(' · ')}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="exec-composer-actions room-composer-bar">
                <button type="button" className="room-icon-btn" aria-label={t('@ 提及')} title={t('@ 提及')} aria-haspopup="listbox" aria-expanded={mentionOpen} disabled={!viewer} onClick={() => setMentionOpen((open) => !open)}><Icon name="at" size={20} /></button>
                <span>{t('Enter 发送，Shift+Enter 换行')}</span>
                <button type="submit" className="room-send" aria-label={t('发送')} title={t('发送')} disabled={sending || !viewer}><Icon name="send" size={18} /></button>
              </div>
            </div>
            <p className="exec-notice" role="status" aria-label={t('指挥室提示')}>{t(notice)}</p>
          </form>
        </section>
        <aside className="panel exec-pane room-tasks" aria-label={t('任务列表')}>
          {teamOpen ? (
            <section id="room-team" className="room-team" aria-label={t('团队')}>
              <div className="room-section-head">
                <h3>{t('团队')} <span className="room-count">{employees.length}</span></h3>
                <button type="button" className="room-icon-btn" aria-label={t('关闭')} onClick={() => setTeamOpen(false)}><Icon name="close" size={16} /></button>
              </div>
              {employees.length === 0 ? <p className="exec-empty">{t('还没有可以指派的数字员工。')}</p> : (
                <ul>
                  {employees.map((employee) => (
                    <li key={employee.id} data-team-member={employee.id}>
                      <span className={`room-dot is-${employee.status}`} aria-hidden="true" />
                      <span><strong>{employee.name}</strong><small>{[employee.duty, t(EMPLOYEE_STATE[employee.status])].filter(Boolean).join(' · ')}</small></span>
                      {viewer ? <button type="button" className="exec-link" onClick={() => { startWith(`@${employee.name} `); }}>{t('交办')}</button> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          <div className="exec-pane-head room-tasks-head">
            <h2>{t('任务')} <span className="room-count">{tasks.length}</span></h2>
            <span>{t('进展、待办与交付，都在这里。')}</span>
          </div>
          <div className="room-tabs" role="tablist" aria-label={t('任务')}>
            {(['open', 'review', 'all'] as const).map((tab) => (
              <button key={tab} type="button" role="tab" aria-selected={taskTab === tab} onClick={() => setTaskTab(tab)}>
                {t(tab === 'open' ? '进行中' : tab === 'review' ? '待复核' : '全部')}{tab !== 'all' && counts[tab] ? <span className="room-count">{counts[tab]}</span> : null}
              </button>
            ))}
          </div>
          <div className="exec-scroll room-task-list">
            {tabTasks.length === 0 ? (
              <div className="room-tasks-empty">
                <Icon name="check" size={22} />
                <strong>{tasks.length === 0 ? t('还没有待处理任务') : t('这一栏暂时没有任务')}</strong>
                <p className="exec-empty">{tasks.length === 0 ? t('当前没有由对话产生的任务。') : t('切换到「全部」查看其他任务。')}</p>
                {tasks.length === 0 ? <p className="exec-empty">{t('明确交办的工作会形成任务。普通讨论可以直接继续。')}</p> : null}
              </div>
            ) : tabTasks.map((task) => (
              <button type="button" className="exec-task" key={task.id} data-task={task.id} data-status={task.status} aria-current={openTaskId === task.id ? 'true' : undefined} onClick={() => openTaskDrawer(task.id)}>
                <strong>{task.title}</strong>
                <span>{taskLine(task, employees, lang)}</span>
              </button>
            ))}
          </div>
          <div className="room-summary" data-outcome="summary" ref={summaryRef} tabIndex={-1} aria-label={t('工作摘要')}>
            <h3>{t('工作摘要')}</h3>
            {tasks.length === 0 ? <p>{t('暂无事项')}</p> : (
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
        </aside>
        {openTask && may ? (
          <aside className="panel exec-drawer" aria-label={t('任务详情')} data-task-detail={openTask.id}>
            <div className="exec-pane-head">
              <h2>{t('任务详情')}</h2>
              <button type="button" onClick={() => openTaskDrawer(null)}>{t('关闭')}</button>
            </div>
            <dl>
              <div><dt>{t('概览')}</dt><dd data-overview>{resultOverview(openTask, lang)}</dd></div>
              <div><dt>{t('状态')}</dt><dd data-status>{taskStatusLabel(openTask, lang)}</dd></div>
              <div><dt>{t('指派')}</dt><dd data-assignee>@{employeeName(employees, openTask.employeeId, lang)}{openTask.assigneeUserId === viewerId ? t('（由你负责）') : ''}</dd></div>
              <div>
                <dt>{t('来源消息')}</dt>
                <dd data-source>
                  {source ? source.body : t('原消息不在当前可见的记录里。')}
                  {source ? <button type="button" className="exec-link" onClick={() => jumpTo(source.id)}>{t('回到原消息')}</button> : null}
                </dd>
              </div>
              {openTask.followupTo ? (
                <div>
                  <dt>{t('追问自')}</dt>
                  <dd data-followup-of>
                    {original ? original.title : t('原任务不在当前可见的列表里。')}
                    {original ? <button type="button" className="exec-link" onClick={() => openTaskDrawer(original.id)}>{t('打开原任务')}</button> : null}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('提示词快照')}</dt>
                <dd data-snapshot>
                  {openTask.promptSnapshot
                    ? lang === 'en'
                    ? 'Prompt version ' + (openTask.promptSnapshot.promptVersion ?? '?') + ' · Model tier ' + (openTask.promptSnapshot.modelTier ?? 'Unknown') + ' · Assigned ' + openTask.promptSnapshot.takenAt
                    : `提示词第 ${openTask.promptSnapshot.promptVersion ?? '?'} 版 · 模型档位 ${openTask.promptSnapshot.modelTier ?? '未记录'} · 交办于 ${openTask.promptSnapshot.takenAt}`
                    : t('这条任务没有记录提示词快照。')}
                </dd>
              </div>
              <div>
                <dt>{t('依据与权限')}</dt>
                <dd data-approval>
                  {openTask.approval === 'required'
                    ? t('这是对外动作：执行前要在「待我处理」里批准，这里交办不等于授权。')
                    : t('只读或起草，不需要动作审批。只使用该员工被授权的来源。')}
                </dd>
              </div>
              <div>
                <dt>{t('验收契约')}</dt>
                <dd data-contract>
                  {openTask.contract ? (lang === 'en' ? 'Version ' + openTask.contract.version + ': ' + openTask.contract.criteria : `第 ${openTask.contract.version} 版：${openTask.contract.criteria}`) : t('还没有写验收契约。')}
                </dd>
              </div>
              {openTask.runId ? (
                <div>
                  <dt>{t('执行与外部动作')}</dt>
                  <dd data-outcome>
                    {openOutcome ? (
                      <>
                        <p data-run={openOutcome.runId}>{t('事件 ')}{openOutcome.eventId} · {runStatusLabel(openOutcome.runStatus, lang)}</p>
                        <ul>
                          {openOutcome.approvals.map((approval) => (
                            <li key={approval.id} data-approval-item={approval.id} data-standing={approval.standing ? 'yes' : 'no'}>{approvalLine(approval, lang)}</li>
                          ))}
                        </ul>
                        <p data-attempts={openOutcome.attempts}>{attemptsLine(openOutcome, lang)}</p>
                      </>
                    ) : t('正在读取执行记录…')}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('结果与证据')}</dt>
                <dd data-evidence>
                  {reports.length === 0 ? t('还没有回报。') : (
                    <ul>
                      {reports.map((report) => (
                        <li key={report.id}>
                          {report.body}
                          <button type="button" className="exec-link" onClick={() => jumpTo(report.id)}>{t('在对话里看')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {openTask.status === 'completed' || openTask.status === 'reviewed' || openTask.status === 'reported' ? <p>{t('已回报完成。')}</p> : null}
                  {openTask.verification === 'failed' ? <p>{t('证据核验未通过，不能算完成。')}</p> : null}
                  {unsentDraftBoundary(openTask) ? <p data-boundary>{t(unsentDraftBoundary(openTask) ?? '')}</p> : null}
                  {openTask.hold ? <p data-blocker>{t('负责人：')}{t(openTask.hold.responsible)}</p> : null}
                </dd>
              </div>
            </dl>
            {openTask.waitingReason === '等待补充' ? (
              <div className="exec-report">
                <label htmlFor="outcome-input">{t('补充资料')}</label>
                <input id="outcome-input" value={supplementDraft} onChange={(event) => setSupplementDraft(event.target.value)} />
                <p id="outcome-input-help">{t(supplementHelp)}</p>
                <button type="button" data-outcome="save-input" disabled={acting} onClick={() => void saveSupplement(openTask)}>{t('保存补充')}</button>
              </div>
            ) : null}
            {may.contract ? (
              <div className="exec-report">
                <label htmlFor="room-contract">{openTask.contract ? t('修改验收契约') : t('写验收契约')}</label>
                <textarea
                  id="room-contract"
                  value={contractDraft ?? openTask.contract?.criteria ?? ''}
                  onChange={(event) => setContractDraft(event.target.value)}
                  placeholder={t('怎样才算完成，例如：必须核对金额、供应商和产品编号')}
                />
                {openTask.contract ? <p className="exec-empty">{t('保存新版本后，之前的完成状态和动作批准作废；已有的外部提交和回读证据保留。')}</p> : null}
                <button type="button" disabled={acting || (contractDraft ?? '').trim() === ''} onClick={() => void saveContract(openTask)}>{t('保存契约')}</button>
              </div>
            ) : null}
            {may.report ? (
              <div className="exec-report">
                <label htmlFor="room-report">{t('回报内容')}</label>
                <textarea id="room-report" value={reportDraft} onChange={(event) => setReportDraft(event.target.value)} />
                <button type="button" disabled={acting || reportDraft.trim() === ''} onClick={() => void act(openTask, 'report', reportDraft.trim())}>{t('提交回报')}</button>
              </div>
            ) : null}
            <div className="exec-composer-actions">
              {may.review ? <button type="button" data-review disabled={acting || openTask.verification === 'failed'} onClick={() => void act(openTask, 'review')}>{t('复核通过')}</button> : null}
              {may.followup ? <button type="button" onClick={() => startFollowup(openTask)}>{t('追问')}</button> : null}
              {may.resume ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'resume')}>{t('恢复任务')}</button> : null}
              {may.cancel ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'cancel')}>{t('取消任务')}</button> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
