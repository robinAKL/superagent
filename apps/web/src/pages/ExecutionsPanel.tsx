import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
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
}
export interface ExecutionView {
  id: string;
  versionNumber: number;
  eventId: string;
  status: 'running' | 'waiting_human' | 'completed' | 'blocked' | 'outcome_unknown';
  steps: Step[];
  exceptionItemId: string | null;
  canReconcile?: boolean;
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

export function ExecutionsPanel({ sopId, publishedVersionId }: { sopId: string; publishedVersionId: string | null }) {
  const t = useT(TEXT);
  const [runs, setRuns] = useState<ExecutionView[]>([]);
  const [eventId, setEventId] = useState('');
  const [input, setInput] = useState('{\n  \n}');
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  // Keys, not text, so a language switch re-renders the messages already shown.
  const [reconcileMessages, setReconcileMessages] = useState<Record<string, Key>>({});

  const load = useCallback(async () => {
    const r = await api<{ executions?: ExecutionView[] }>(`/api/v1/executions?sopId=${encodeURIComponent(sopId)}`);
    setRuns(r.status === 200 ? [...(r.body.executions ?? [])].reverse() : []);
  }, [sopId]);
  useEffect(() => void load(), [load]);

  async function trigger(e: FormEvent) {
    e.preventDefault();
    let data: unknown;
    try {
      data = JSON.parse(input);
    } catch {
      setMsg(t('badJson'));
      return;
    }
    const r = await api<ExecutionView & { message?: string }>('/api/v1/executions', { method: 'POST', body: JSON.stringify({ versionId: publishedVersionId, eventId: eventId.trim(), input: data }) });
    setMsg(r.status === 201 ? t('triggered', { id: r.body.id, status: t(RUN_LABEL[r.body.status]) }) : t('notTriggered', { reason: r.body.message ?? r.status }));
    await load();
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
      <h2 className="h2">{t('runsTitle')}</h2>
      <form className="stack" onSubmit={trigger} aria-label={t('triggerLabel')}>
        <label className="field">
          <span>{t('eventHint')}</span>
          <input aria-label={t('eventLabel')} value={eventId} onChange={(e) => setEventId(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('inputHint')}</span>
          <textarea aria-label={t('inputLabel')} rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={!publishedVersionId}>{t('triggerPublished')}</button>
        {!publishedVersionId ? <p className="helper">{t('noPublished')}</p> : null}
        <button className="btn" type="button" onClick={() => void load()}>{t('refresh')}</button>
      </form>
      {msg ? <p className="helper" role="status" aria-label={t('resultLabel')}>{msg}</p> : null}
      {!runs.length ? <p className="helper">{t('noRuns')}</p> : null}
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
            <ol className="run-steps">
              {r.steps.map((s) => (
                <li key={s.nodeId} data-step={s.nodeId} data-step-status={s.status}>
                  {t('stepLine', { label: s.label, status: t(STEP_LABEL[s.status]), detail: s.detail ? t('stepDetail', { detail: s.detail }) : '' })}
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
