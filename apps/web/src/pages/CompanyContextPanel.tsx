import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

export interface PublishedWorkflow {
  id: string;
  sopId: string;
  version: number;
  title: string;
  completion: string;
  requiredFields: string[];
  numericField: string | null;
}

interface CompanyContext {
  version: number;
  name: string;
  goal: string;
  boundaries: string;
}

const TEXT = {
  en: {
    title: 'Company information and work boundaries', name: 'Company name', goal: 'Work to hand to the digital team',
    boundaries: 'Boundaries that must be followed', boundaryHint: 'Name the decisions that still need a person, and the limits the digital team must not cross.',
    save: 'Save configuration', saving: 'Saving…', saved: 'Saved configuration v{version}.',
    loading: 'Loading company setup…', loadError: 'Could not load the company setup.',
    conflict: 'The configuration changed while you were editing. Reload to see the latest version.',
    saveError: 'Could not save the configuration. Try again.',
    reload: 'Reload',
    enable: 'Set up work', knowledge: 'Enterprise knowledge', knowledgeHint: '{n} confirmed sources; rules stay evidence-backed',
    knowledgeEmpty: 'Confirm sources so rules have evidence.',
    flow: 'Run a workflow', flowHint: '{name} · ready to start', flowEmpty: 'No workflow is enabled yet.',
    employees: 'Digital employees', employeeHint: 'Set the number of employees who will do the work.',
    review: 'Review workflow candidates',
  },
  zh: {
    title: '企业信息与工作边界', name: '企业名称', goal: '希望交给数字团队的工作',
    boundaries: '必须遵守的边界', boundaryHint: '写清哪些事需要人决定，以及数字团队不得越过的限制。',
    save: '保存配置', saving: '保存中…', saved: '已保存配置 v{version}。',
    loading: '正在读取企业配置…', loadError: '无法读取企业配置。',
    conflict: '编辑期间配置已更新，请重新读取最新版本。',
    saveError: '无法保存配置，请重试。',
    reload: '重新读取',
    enable: '工作设置', knowledge: '企业知识', knowledgeHint: '{n}个来源已确认，规则有据可查',
    knowledgeEmpty: '先确认资料来源，规则才有依据。',
    flow: '运行流程', flowHint: '{name} · 可启动', flowEmpty: '还没有已启用的流程。',
    employees: '数字员工', employeeHint: '设置执行工作所需的员工人数。',
    review: '审阅候选流程',
  },
};
const EMPTY = { name: '', goal: '', boundaries: '' };
const TIMEOUT = 12_000;

export function CompanyContextPanel({ fromOrganization }: { fromOrganization: boolean }) {
  const t = useT(TEXT);
  const [context, setContext] = useState<CompanyContext | null>();
  const [fields, setFields] = useState(EMPTY);
  const [saved, setSaved] = useState(false);
  const [workflows, setWorkflows] = useState<PublishedWorkflow[] | null>();
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'saving' | 'conflict' | 'saveError'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT)]);
    setState('loading');
    void api<{ context: CompanyContext | null }>('/api/v1/sop/company-context', { signal }).then(({ status, body }) => {
      if (controller.signal.aborted) return;
      if (status !== 200 || !Object.hasOwn(body, 'context')) { setState('error'); return; }
      setContext(body.context);
      setFields(body.context ? { name: body.context.name, goal: body.context.goal, boundaries: body.context.boundaries } : EMPTY);
      setState('ready');
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    void api<{ workflows: PublishedWorkflow[] }>('/api/v1/sop/published', { signal }).then(({ status, body }) => {
      if (!controller.signal.aborted) setWorkflows(status === 200 && Array.isArray(body.workflows) ? body.workflows : null);
    }).catch(() => { if (!controller.signal.aborted) setWorkflows(null); });
    void api<{ items: { confirmed: boolean }[] }>('/api/v1/knowledge/overview', { signal }).then(({ status, body }) => {
      if (!controller.signal.aborted) setKnowledgeCount(status === 200 && Array.isArray(body.items)
        ? body.items.filter(item => item.confirmed).length : null);
    }).catch(() => { if (!controller.signal.aborted) setKnowledgeCount(null); });
    return () => controller.abort();
  }, [attempt]);

  async function persistContext(): Promise<CompanyContext | null> {
    const response = await api<{ context: CompanyContext }>('/api/v1/sop/company-context', {
      method: 'PUT', body: JSON.stringify({ ...fields, expectedVersion: context?.version ?? 0 }),
    });
    if (response.status === 409) { setState('conflict'); return null; }
    if (response.status !== 200 || !response.body.context) { setState('saveError'); return null; }
    const next = response.body.context;
    setContext(next);
    setFields({ name: next.name, goal: next.goal, boundaries: next.boundaries });
    return next;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (state === 'saving' || state === 'conflict' || !fields.name.trim() || !fields.goal.trim()) return;
    setState('saving');
    setSaved(false);
    try {
      if (!(await persistContext())) return;
      setSaved(true);
      setState('ready');
    } catch {
      setState('saveError');
    }
  }

  const dirty = Object.keys(fields).some(key => {
    const field = key as keyof typeof EMPTY;
    return fields[field] !== (context?.[field] ?? '');
  });
  const flow = workflows?.[0];
  return <div className="ux-company-layout">
    <section className="panel stack company-setup" aria-labelledby="company-context-heading">
      <h2 className="h2" id="company-context-heading">{t('title')}</h2>
      {state === 'error' ? <p className="warn" role="alert">{t('loadError')}</p> : <form className="stack" onSubmit={event => void save(event)}>
          {state === 'loading' ? <p className="helper" role="status">{t('loading')}</p> : null}
          <label className="field"><span>{t('name')}</span><input required maxLength={160} disabled={state === 'saving' || state === 'loading'} value={fields.name}
            onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
          <label className="field"><span>{t('goal')}</span><textarea required maxLength={4000} rows={3} disabled={state === 'saving' || state === 'loading'} value={fields.goal}
            onChange={event => setFields({ ...fields, goal: event.target.value })} /></label>
          <label className="field"><span>{t('boundaries')}</span><textarea maxLength={4000} rows={3} disabled={state === 'saving' || state === 'loading'} value={fields.boundaries}
            aria-describedby="company-context-boundary-hint" onChange={event => setFields({ ...fields, boundaries: event.target.value })} /></label>
          <p className="helper" id="company-context-boundary-hint">{t('boundaryHint')}</p>
          {state === 'conflict' || state === 'saveError' ? <p className="warn" role="alert">{t(state)}</p> : null}
          <div className="org-row">
            <button className="btn primary" disabled={state === 'saving' || state === 'loading' || state === 'conflict' || !fields.name.trim() || !fields.goal.trim()}>
              {state === 'saving' ? t('saving') : t('save')}
            </button>
          </div>
          {state === 'ready' && saved && context && !dirty ? <p className="helper" role="status">{t('saved', { version: context.version })}</p> : null}
        </form>}
      {state === 'error' || state === 'conflict' ? <button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>{t('reload')}</button> : null}
      {fromOrganization ? <a className="btn" href="#brain?tab=results&org=1">{t('review')}</a> : null}
    </section>
    <aside className="ux-setup-guide">
      <h2>{t('enable')}</h2>
      <a href="#knowledge"><span><strong>{t('knowledge')}</strong><small>{knowledgeCount ? t('knowledgeHint', { n: knowledgeCount }) : t('knowledgeEmpty')}</small></span></a>
      <a href="#employees"><span><strong>{t('employees')}</strong><small>{t('employeeHint')}</small></span></a>
      <a href="#room?workflows=1"><span><strong>{t('flow')}</strong><small>{flow ? t('flowHint', { name: flow.title }) : t('flowEmpty')}</small></span></a>
    </aside>
  </div>;
}
