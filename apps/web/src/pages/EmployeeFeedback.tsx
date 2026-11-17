import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { WallEmployee } from './EmployeeWall';
import { mentionsEmployee } from './EmployeeManage';

interface WorkItem { id: string; kind: string; status: string; payload: Record<string, unknown> }
interface ToolRow { toolId: string; name: string; stage: string; state: string }

const TEXT = {
  en: {
    title: 'Employee feedback and capability requests ({n})',
    empty: 'No employee feedback or missing-capability requests yet. This list is the inbox items that name a digital employee, plus tool placeholders that still need a capability.',
    feedback: 'Feedback', capability: 'Capability request', placeholder: 'Placeholder · {name}',
    openInbox: 'Open My work',
  },
  zh: {
    title: '员工反馈与能力申请（{n}）',
    empty: '还没有员工反馈或能力申请。这里只列出点名了数字员工的待办，以及仍缺能力的工具占位，不会编造。',
    feedback: '反馈', capability: '能力申请', placeholder: '占位 · {name}',
    openInbox: '打开待我处理',
  },
};

export function EmployeeFeedback({ employees }: { employees: WallEmployee[] }) {
  const t = useT(TEXT);
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [placeholders, setPlaceholders] = useState<ToolRow[]>([]);
  const ids = new Set(employees.map(e => e.id));

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<{ items?: WorkItem[] }>('/api/v1/work-items').catch(() => ({ status: 0, body: {} as { items?: WorkItem[] } })),
      api<ToolRow[]>('/api/v1/tools/').catch(() => ({ status: 0, body: [] as ToolRow[] })),
    ]).then(([inbox, tools]) => {
      if (cancelled) return;
      setItems(inbox.status === 200 && Array.isArray(inbox.body.items) ? inbox.body.items.filter(item => mentionsEmployee(item.payload ?? {}, ids)) : []);
      setPlaceholders(tools.status === 200 && Array.isArray(tools.body) ? tools.body.filter(tool => tool.stage === 'placeholder' || tool.state === 'placeholder') : []);
    });
    return () => { cancelled = true; };
  }, [employees]);

  const n = (items?.length ?? 0) + placeholders.length;
  return <section className="emp-feedback" aria-labelledby="emp-feedback-title">
    <h2 id="emp-feedback-title">{t('title', { n })}</h2>
    {items === null ? <p className="helper">…</p> : n === 0 ? <p className="helper" role="status">{t('empty')}</p> : <>
      <ul className="emp-feedback-list">
        {items?.map(item => <li key={item.id}><span>{t('feedback')}</span> {String(item.payload.title ?? item.kind)} · {item.status}</li>)}
        {placeholders.map(tool => <li key={tool.toolId}><span>{t('capability')}</span> {t('placeholder', { name: tool.name })}</li>)}
      </ul>
      <a href="#work">{t('openInbox')}</a>
    </>}
  </section>;
}
