import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT, type Dict } from '../i18n';

/**
 * Pending agent permission prompts (room task T-13). A headless agent that needs confirmation files a request
 * through its Link; the room owner allows or denies it here and the agent continues. Unanswered requests expire
 * after 10 minutes and count as denied.
 */
const TEXT = {
  en: {
    title: 'Agent confirmations', empty: 'No agent is waiting for confirmation.', loadError: 'Could not load confirmations.',
    tool: 'Action', task: 'Task', expires: 'Expires in {min} min', allow: 'Allow', deny: 'Deny',
    decided: 'Already decided by someone else.', actionError: 'Could not record the decision.',
  },
  zh: {
    title: '待确认的 agent 操作', empty: '目前没有 agent 在等确认。', loadError: '无法加载待确认操作。',
    tool: '操作', task: '任务', expires: '{min} 分钟后过期', allow: '允许', deny: '拒绝',
    decided: '已经有人处理过了。', actionError: '无法记录这次决定。',
  },
} satisfies Dict<string>;

interface Approval {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  roomTaskId: string | null;
  expiresAt: number;
}

const PATH = '/api/v1/workers/approvals';
const REFRESH_MS = 5_000;

export function WorkerApprovals() {
  const t = useT(TEXT);
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api<{ approvals: Approval[] }>(PATH + '?status=pending', { signal });
      if (signal?.aborted) return;
      if (res.status !== 200) throw new Error('load_failed');
      setItems(res.body.approvals);
      setError((e) => (e === t('loadError') ? null : e));
    } catch {
      if (!signal?.aborted) setError(t('loadError'));
    }
  }, [t]);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    const timer = window.setInterval(() => { void load(abort.signal); }, REFRESH_MS);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [load]);

  async function decide(id: string, decision: 'allow' | 'deny') {
    setBusy(id);
    setError(null);
    try {
      const res = await api(PATH + '/' + id + '/decide', { method: 'POST', body: JSON.stringify({ decision }) });
      if (res.status === 409) setError(t('decided'));
      else if (res.status !== 200) setError(t('actionError'));
      await load();
    } catch {
      setError(t('actionError'));
    } finally {
      setBusy(null);
    }
  }

  const now = Date.now();
  return (
    <section className="panel exec-approvals" aria-label={t('title')}>
      <h2>{t('title')}</h2>
      {error ? <p role="alert">{error}</p> : null}
      {items?.length === 0 ? <p className="exec-empty">{t('empty')}</p> : null}
      {items?.length ? <ul className="exec-approval-list">
        {items.map((item) => (
          <li key={item.id} data-approval={item.id}>
            <p className="exec-approval-summary">{item.summary}</p>
            <dl>
              <dt>{t('tool')}</dt><dd><code>{item.tool}</code></dd>
              {item.roomTaskId ? <><dt>{t('task')}</dt><dd>{item.roomTaskId}</dd></> : null}
            </dl>
            <pre className="exec-approval-input">{JSON.stringify(item.input, null, 2).slice(0, 2_000)}</pre>
            <div className="exec-approval-actions">
              <span>{t('expires', { min: Math.max(0, Math.ceil((item.expiresAt - now) / 60_000)) })}</span>
              <button type="button" className="exec-action" disabled={busy !== null} onClick={() => void decide(item.id, 'deny')}>{t('deny')}</button>
              <button type="button" className="exec-action exec-approval-allow" disabled={busy !== null} onClick={() => void decide(item.id, 'allow')}>{t('allow')}</button>
            </div>
          </li>
        ))}
      </ul> : null}
    </section>
  );
}
