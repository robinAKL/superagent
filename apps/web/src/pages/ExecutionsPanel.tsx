import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { PublishedWorkflow } from './CompanyContextPanel';
import { useT, type Dict } from '../i18n';

/** SOP runs (T-56): manual trigger for the published version and the record of every run with its steps. */
interface Step {
  nodeId: string;
  kind: string;
  label: string;
  status: 'pending' | 'done' | 'waiting_human' | 'blocked' | 'outcome_unknown';
  detail: string | null;
  workItemId: string | null;
  readback: unknown | null;
  responsible?: string;
  resumeReason?: 'input' | 'readiness';
  missingFields?: string[];
}
export interface ExecutionView {
  id: string;
  versionNumber: number;
  eventId: string;
  startedBy: string;
  status: 'running' | 'waiting_human' | 'completed' | 'blocked' | 'outcome_unknown';
  steps: Step[];
  exceptionItemId: string | null;
  canReconcile?: boolean;
  canResume?: boolean;
  companyContext?: { version: number; name: string; goal: string; boundaries: string } | null;
  workflow?: { title: string; completion: string };
}

const TEXT = {
  en: {
    runRunning: 'Running', runWaitingHuman: 'Waiting for a person', runCompleted: 'Completed', runBlocked: 'Blocked', runUnknown: 'Outcome unknown (frozen)',
    stepPending: 'Not started', stepDone: 'Done', stepWaitingHuman: 'Waiting for a person', stepBlocked: 'Blocked', stepUnknown: 'Outcome unknown',
    badJson: 'The input is not valid JSON', triggered: 'Run {id} triggered: {status}', notTriggered: 'Not triggered: {reason}',
    reconcileMatched: 'Read-back matches the original approval; no external action was submitted again.',
    reconcilePending: 'The original run was checked; the outcome is still unconfirmed. No external action was submitted again.',
    reconcileForbidden: 'The current employee, tool or connection does not allow read-back; no external system was called.',
    reconcileNotFound: 'No original run to check, or your identity has no access.',
    reconcileUnavailable: 'Read-only check is unavailable right now; no external action was resubmitted.',
    reconcileDropped: 'The connection dropped and the check is unconfirmed. Refresh the original run; no write was resubmitted.',
    start: 'Start workflow', starting: 'Starting…', requestId: 'Request reference', deliverable: 'Expected deliverable',
    provision: 'Supply the missing details and continue', resume: 'Check readiness and continue', resuming: 'Continuing…',
    missing: 'Complete the missing fields to continue this run.', responsible: 'Responsible: {name}', requester: 'Requester',
    resumeError: 'Could not continue this run. Refresh its status and try again.', context: 'Company context v{version}',
    loadError: 'Could not load run history.', changed: 'The active version changed. Reopen the workflow to load it.',
    goal: 'Business goal', boundaries: 'Decision boundaries', namedRun: 'Workflow runs',
    runsLabel: 'Run history', runsTitle: 'Run history', triggerLabel: 'Manual trigger',
    eventHint: 'Event ID (one instance per event)', eventLabel: 'Event ID', inputHint: 'Input data (JSON)', inputLabel: 'Input data',
    triggerPublished: 'Trigger the published version', noPublished: 'No published version yet.', refresh: 'Refresh',
    resultLabel: 'Trigger result', noRuns: 'No runs yet.', event: 'event {id}', exception: 'Exception item {id}',
    reconcileHelp: 'Only reads back the external result of the original action, keeping the same run and approval; nothing is resent. Employee status, tools and account permissions are re-checked first.',
    checking: 'Checking (read-only)…', reconcileButton: 'Read back the external result only',
    reconcileOff: 'Read-only check is not available for your identity.', reconcileResultLabel: 'Read-back check result',
    goToWork: 'Go to My work', readback: 'Read-back {value}',
    stepLine: '{label}: {status}{detail}', stepDetail: ' ({detail})',
  },
  zh: {
    runRunning: '运行中', runWaitingHuman: '等待人工', runCompleted: '已完成', runBlocked: '已阻塞', runUnknown: '结果未知（已冻结）',
    stepPending: '未开始', stepDone: '完成', stepWaitingHuman: '等待人工', stepBlocked: '阻塞', stepUnknown: '结果未知',
    badJson: '输入数据不是有效的 JSON', triggered: '已触发运行 {id}：{status}', notTriggered: '未触发：{reason}',
    reconcileMatched: '回读已匹配原批准内容；没有再次提交外部动作。',
    reconcilePending: '已核对原执行，结果仍待确认；没有再次提交外部动作。',
    reconcileForbidden: '当前员工、工具或连接不允许回读；未调用外部系统。',
    reconcileNotFound: '找不到可核对的原执行，或当前身份没有访问权限。',
    reconcileUnavailable: '只读核对暂不可用；没有重新提交外部动作。',
    reconcileDropped: '连接中断，核对结果尚未确认；请刷新原执行记录，没有重新提交写入。',
    start: '启动流程', starting: '正在启动…', requestId: '业务编号', deliverable: '预期交付',
    provision: '补齐信息并继续', resume: '重新检查并继续', resuming: '正在继续…',
    missing: '补齐以下信息后，可继续同一次运行。', responsible: '负责人：{name}', requester: '业务发起人',
    resumeError: '无法继续本次运行，请刷新状态后重试。', context: '企业上下文 v{version}',
    loadError: '无法读取运行记录。', changed: '生效版本已更新，请重新打开流程。',
    goal: '业务目标', boundaries: '决策边界', namedRun: '流程运行',
    runsLabel: '运行记录', runsTitle: '运行记录', triggerLabel: '手动触发',
    eventHint: '事件编号（同一事件只会开一次实例）', eventLabel: '事件编号', inputHint: '输入数据（JSON）', inputLabel: '输入数据',
    triggerPublished: '按已发布版本触发', noPublished: '还没有已发布版本。', refresh: '刷新',
    resultLabel: '触发结果', noRuns: '还没有运行。', event: '事件 {id}', exception: '例外事项 {id}',
    reconcileHelp: '仅回读原动作的外部结果，保留同一执行和批准；不会重新发送。回读前会重新核对员工状态、工具和账号权限。',
    checking: '正在只读核对…', reconcileButton: '只回读核对外部结果',
    reconcileOff: '当前身份的只读核对入口不可用。', reconcileResultLabel: '回读核对结果',
    goToWork: '去待我处理', readback: '回读 {value}',
    stepLine: '{label}：{status}{detail}', stepDetail: '（{detail}）',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;

const RUN_LABEL: Record<ExecutionView['status'], Key> = { running: 'runRunning', waiting_human: 'runWaitingHuman', completed: 'runCompleted', blocked: 'runBlocked', outcome_unknown: 'runUnknown' };
const STEP_LABEL: Record<Step['status'], Key> = { pending: 'stepPending', done: 'stepDone', waiting_human: 'stepWaitingHuman', blocked: 'stepBlocked', outcome_unknown: 'stepUnknown' };

export function ExecutionsPanel({ sopId, publishedVersionId, roomWorkflow }: {
  sopId: string;
  publishedVersionId: string | null;
  roomWorkflow?: PublishedWorkflow;
}) {
  const t = useT(TEXT);
  const [runs, setRuns] = useState<ExecutionView[]>([]);
  const [eventId, setEventId] = useState('');
  const [input, setInput] = useState('{\n  \n}');
  const [msg, setMsg] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  // Keys, not text, so a language switch re-renders the messages already shown.
  const [reconcileMessages, setReconcileMessages] = useState<Record<string, Key>>({});

  const load = useCallback(async () => {
    try {
      const r = await api<{ executions?: ExecutionView[] }>(`/api/v1/executions?sopId=${encodeURIComponent(sopId)}`);
      if (r.status !== 200 || !r.body.executions) { setLoadError(true); return; }
      setRuns([...r.body.executions].reverse());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [sopId]);
  useEffect(() => void load(), [load]);

  async function trigger(e: FormEvent) {
    e.preventDefault();
    if (starting || !publishedVersionId) return;
    let data: unknown;
    try {
      data = roomWorkflow ? workflowInput(fields, roomWorkflow.numericField) : JSON.parse(input);
    } catch {
      setMsg(t('badJson'));
      return;
    }
    setStarting(true);
    try {
      const r = await api<ExecutionView & { message?: string; error?: string }>('/api/v1/executions', { method: 'POST', body: JSON.stringify({
        versionId: publishedVersionId, sopId: roomWorkflow?.sopId, eventId: eventId.trim(), input: data,
      }) });
      if (r.status === 201) {
        setRuns(previous => [r.body, ...previous.filter(run => run.id !== r.body.id)]);
        setMsg(t('triggered', { id: r.body.id, status: t(RUN_LABEL[r.body.status]) }));
      } else {
        setMsg(r.body.error === 'published_version_changed' ? t('changed') : t('notTriggered', { reason: r.body.message ?? r.status }));
      }
      await load();
    } catch {
      setMsg(t('loadError'));
    } finally {
      setStarting(false);
    }
  }

  async function reconcile(run: ExecutionView) {
    if (!run.canReconcile || checking) return;
    setChecking(run.id);
    try {
      const response = await api<ExecutionView>(`/api/v1/executions/${encodeURIComponent(run.id)}/reconcile`, { method: 'POST', body: '{}' });
      const message: Key = response.status === 200
        ? response.body.status === 'completed' ? 'reconcileMatched' : 'reconcilePending'
        : response.status === 403 ? 'reconcileForbidden'
        : response.status === 404 ? 'reconcileNotFound'
        : 'reconcileUnavailable';
      setReconcileMessages(previous => ({ ...previous, [run.id]: message }));
      await load();
    } catch {
      setReconcileMessages(previous => ({ ...previous, [run.id]: 'reconcileDropped' }));
    } finally { setChecking(null); }
  }

  return (
    <section className="panel stack" aria-label={t('runsLabel')}>
      <h2 className="h2">{t(roomWorkflow ? 'namedRun' : 'runsTitle')}</h2>
      {roomWorkflow?.completion ? <p className="helper"><strong>{t('deliverable')}</strong> · {roomWorkflow.completion}</p> : null}
      <form className="stack" onSubmit={trigger} aria-label={t(roomWorkflow ? 'start' : 'triggerLabel')}>
        <label className="field">
          <span>{t(roomWorkflow ? 'requestId' : 'eventHint')}</span>
          <input aria-label={t(roomWorkflow ? 'requestId' : 'eventLabel')} value={eventId} onChange={(e) => setEventId(e.target.value)} required />
        </label>
        {roomWorkflow ? <div className="agent-fields">
          {Array.from(new Set([...roomWorkflow.requiredFields, ...(roomWorkflow.numericField ? [roomWorkflow.numericField] : [])])).map(field =>
            <label className="field" key={field}><span>{field}</span>
              <input type={field === roomWorkflow.numericField ? 'number' : 'text'} step="any" value={Object.hasOwn(fields, field) ? fields[field] : ''}
                onChange={event => setFields({ ...fields, [field]: event.target.value })} />
            </label>)}
        </div> : <label className="field">
          <span>{t('inputHint')}</span>
          <textarea aria-label={t('inputLabel')} rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
        </label>}
        <div className="workflow-actions">
          <button className={roomWorkflow ? 'btn primary' : 'btn'} type="submit" disabled={!publishedVersionId || starting || !eventId.trim()}>
            {t(starting ? 'starting' : roomWorkflow ? 'start' : 'triggerPublished')}
          </button>
          <button className="btn" type="button" onClick={() => void load()}>{t('refresh')}</button>
        </div>
        {!publishedVersionId ? <p className="helper">{t('noPublished')}</p> : null}
      </form>
      {msg ? <p className="helper" role="status" aria-label={t('resultLabel')}>{msg}</p> : null}
      {loadError ? <p className="warn" role="alert">{t('loadError')}</p> : !runs.length ? <p className="helper">{t('noRuns')}</p> : null}
      <ul className="onto-list">
        {runs.map((r) => (
          <li key={r.id} data-run={r.id}>
            <strong>{r.id}</strong> · {t('event', { id: r.eventId })} · v{r.versionNumber} · <span data-run-status={r.status}>{t(RUN_LABEL[r.status])}</span>
            {r.exceptionItemId ? <> · <a href="#work">{t('exception', { id: r.exceptionItemId })}</a></> : null}
            {r.status === 'outcome_unknown' ? <div className="stack">
              <p className="helper">{t('reconcileHelp')}</p>
              <button className="btn" type="button" disabled={!r.canReconcile || checking !== null} onClick={() => void reconcile(r)}>{checking === r.id ? t('checking') : t('reconcileButton')}</button>
              {!r.canReconcile ? <p className="helper">{t('reconcileOff')}</p> : null}
            </div> : null}
            {reconcileMessages[r.id] ? <p role="status" aria-label={t('reconcileResultLabel')}>{t(reconcileMessages[r.id]!)}</p> : null}
            {roomWorkflow && r.workflow?.completion && r.workflow.completion !== roomWorkflow.completion
              ? <p className="helper"><strong>{t('deliverable')}</strong> · {r.workflow.completion}</p> : null}
            {roomWorkflow && r.companyContext ? <details className="workflow-context">
              <summary>{t('context', { version: r.companyContext.version })} · {r.companyContext.name}</summary>
              <dl className="agent-readiness">
                <div><dt>{t('goal')}</dt><dd>{r.companyContext.goal}</dd></div>
                {r.companyContext.boundaries ? <div><dt>{t('boundaries')}</dt><dd>{r.companyContext.boundaries}</dd></div> : null}
              </dl>
            </details> : null}
            {r.canResume ? <ResumeRun run={r} numericField={roomWorkflow?.numericField ?? null} onResumed={run => {
              setRuns(previous => previous.map(row => row.id === run.id ? run : row));
              void load();
            }} /> : null}
            <ol className="run-steps">
              {r.steps.map((s) => (
                <li key={s.nodeId} data-step={s.nodeId} data-step-status={s.status}>
                  {t('stepLine', { label: s.label, status: t(STEP_LABEL[s.status]), detail: s.detail ? t('stepDetail', { detail: s.detail }) : '' })}
                  {roomWorkflow && s.responsible && s.status !== 'pending' ? <span className="run-responsible"> · {t('responsible', { name: s.responsible === r.startedBy ? t('requester') : s.responsible })}</span> : null}
                  {s.workItemId && s.status === 'waiting_human' ? <> · <a href="#work">{t('goToWork')}</a></> : null}
                  {s.readback ? <code className="readback">{t('readback', { value: JSON.stringify(s.readback) })}</code> : null}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}

function workflowInput(fields: Record<string, string>, numericField: string | null) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim()).map(([key, value]) => [
    key, key === numericField ? Number(value) : value.trim(),
  ]));
}

function ResumeRun({ run, numericField, onResumed }: {
  run: ExecutionView;
  numericField: string | null;
  onResumed: (run: ExecutionView) => void;
}) {
  const t = useT(TEXT);
  const [input, setInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const step = run.steps.find(item => item.status === 'blocked' && item.resumeReason);
  if (!step) return null;
  const fields = step.missingFields ?? [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const supplied = Object.fromEntries(fields.map(field => [field, Object.hasOwn(input, field) ? (input[field] ?? '') : '']));
      const response = await api<ExecutionView>(`/api/v1/executions/${encodeURIComponent(run.id)}/resume`, {
        method: 'POST', body: JSON.stringify({ input: workflowInput(supplied, numericField) }),
      });
      if (response.status === 200) { setInput({}); onResumed(response.body); }
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return <form className="workflow-resume stack" onSubmit={submit}>
    {fields.length ? <p className="helper">{t('missing')}</p> : null}
    <div className="agent-fields">
      {fields.map(field => <label className="field" key={field}><span>{field}</span>
        <input required disabled={busy} type={field === numericField ? 'number' : 'text'} step="any"
          value={Object.hasOwn(input, field) ? (input[field] ?? '') : ''} onChange={event => setInput({ ...input, [field]: event.target.value })} />
      </label>)}
    </div>
    <button className="btn" disabled={busy} type="submit">{t(busy ? 'resuming' : fields.length ? 'provision' : 'resume')}</button>
    {error ? <p className="warn" role="alert">{t('resumeError')}</p> : null}
  </form>;
}
