import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Replies digital employees drafted to incoming mail, waiting for a person ("ask me first"). Shown at the top of
 * My work: who it goes to, from which mailbox, the text (editable), and send or drop.
 */
interface Draft {
  id: string; address: string; employeeName: string | null; taskId: string; to: string; subject: string; body: string; createdAt: string; note: string;
}

const TEXT = {
  en: {
    title: 'Replies to send', lead: 'Digital employees drafted these replies. Nothing is sent until you send it.',
    from: 'From {address} (@{employee})', to: 'To {to}', task: 'Task T-{n}', send: 'Send', discard: 'Don’t send', edit: 'Edit', done: 'Done editing',
    sent: 'Sent.', dropped: 'Not sent.', error: 'That did not work. Try again.', failed: 'Sending directly failed: {note}',
  },
  zh: {
    title: '待发送的回复', lead: '数字员工起草了这些回复。你点发送之前，什么都不会发出。',
    from: '从 {address} 发（@{employee}）', to: '发给 {to}', task: '任务 T-{n}', send: '发送', discard: '不发', edit: '修改', done: '改好了',
    sent: '已发送。', dropped: '已放弃，不会发出。', error: '没有成功，请重试。', failed: '直接发送失败：{note}',
  },
};

export function MailDrafts({ onCount }: { onCount?: (count: number) => void }) {
  const t = useT(TEXT);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ drafts?: Draft[] }>('/api/v1/mail/drafts');
    if (r.status === 200 && Array.isArray(r.body.drafts)) setDrafts(r.body.drafts);
  }, []);
  useEffect(() => {
    void load().catch(() => {});
    const timer = setInterval(() => { void load().catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => { onCount?.(drafts.length); }, [drafts.length, onCount]);

  async function decide(draft: Draft, action: 'send' | 'discard') {
    setBusy(draft.id); setMessage(null);
    const body = action === 'send' && texts[draft.id] !== undefined ? { body: texts[draft.id] } : {};
    const r = await api<{ message?: string }>(`/api/v1/mail/drafts/${draft.id}/${action}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    setBusy(null);
    if (!r || r.status !== 200) { setMessage({ text: r?.body.message ?? t('error'), error: true }); return; }
    setMessage({ text: action === 'send' ? t('sent') : t('dropped') });
    setDrafts((list) => list.filter((item) => item.id !== draft.id));
    setEditing(null);
  }

  if (!drafts.length && !message) return null;
  return <section className="panel mail-drafts" aria-labelledby="mail-drafts-title">
    <header><h2 id="mail-drafts-title" className="h2">{t('title')} <span className="chip-n">{drafts.length || ''}</span></h2><p className="helper">{t('lead')}</p></header>
    {message ? <p className={message.error ? 'warn' : 'accounts-done'} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    <ul>{drafts.map((draft) => (
      <li key={draft.id} className="mail-draft">
        <div className="mail-draft-head">
          <strong>{draft.subject}</strong>
          <span className="helper">{t('to', { to: draft.to })} · {t('from', { address: draft.address, employee: draft.employeeName ?? '' })} · <a href="#room">{t('task', { n: draft.taskId.replace('task_', '') })}</a></span>
        </div>
        {draft.note ? <p className="warn">{t('failed', { note: draft.note })}</p> : null}
        {editing === draft.id
          ? <textarea rows={8} value={texts[draft.id] ?? draft.body} maxLength={20000} aria-label={draft.subject} onChange={(event) => setTexts((all) => ({ ...all, [draft.id]: event.target.value }))} />
          : <pre className="mail-draft-body">{texts[draft.id] ?? draft.body}</pre>}
        <div className="mail-draft-actions">
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void decide(draft, 'send')}>{t('send')}</button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => setEditing(editing === draft.id ? null : draft.id)}>{editing === draft.id ? t('done') : t('edit')}</button>
          <button type="button" className="btn quiet" disabled={busy !== null} onClick={() => void decide(draft, 'discard')}>{t('discard')}</button>
        </div>
      </li>
    ))}</ul>
  </section>;
}
