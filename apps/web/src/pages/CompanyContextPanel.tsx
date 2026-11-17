import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { OrganizationPublish } from './OrganizationPublish';

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
    save: 'Confirm and publish configuration, generate digital employees', saving: 'Saving…', saved: 'Saved configuration v{version}.', savedNoOrg: 'Saved configuration v{version}. Digital employees are published once an analysis has produced an organization draft.',
    loading: 'Loading company setup…', loadError: 'Could not load the company setup.',
    conflict: 'The configuration changed while you were editing. Reload to see the latest version.',
    saveError: 'Could not save the configuration. Try again.', reload: 'Reload',
    enable: 'Confirm before enabling', knowledge: 'Enterprise knowledge', knowledgeHint: '{n} confirmed sources; rules stay evidence-backed',
    knowledgeEmpty: 'Confirm sources so rules have evidence.',
    flow: 'Business workflows', flowHint: '{name} / v{version}', flowEmpty: 'Publish a company workflow.',
    employees: 'Digital employees', employeeHint: 'Roles, owners, connections and tools are confirmed separately.',
    enableNote: 'Publishing generates role drafts. New roles still need a bound agent and tools before they can work.',
    review: 'Review workflow candidates',
  },
  zh: {
    title: '企业信息与工作边界', name: '企业名称', goal: '希望交给数字团队的工作',
    boundaries: '必须遵守的边界', boundaryHint: '写清哪些事需要人决定，以及数字团队不得越过的限制。',
    save: '确认并发布配置，生成数字员工', saving: '保存中…', saved: '已保存配置 v{version}。', savedNoOrg: '已保存配置 v{version}。分析资料生成组织草案后，再发布数字员工。',
    loading: '正在读取企业配置…', loadError: '无法读取企业配置。',
    conflict: '编辑期间配置已更新，请重新读取最新版本。',
    saveError: '无法保存配置，请重试。', reload: '重新读取',
    enable: '启用前确认', knowledge: '企业知识', knowledgeHint: '{n}个来源已确认，规则有据可查',
    knowledgeEmpty: '先确认资料来源，规则才有依据。',
    flow: '业务流程', flowHint: '{name} / v{version}', flowEmpty: '先发布一条企业流程。',
    employees: '数字员工', employeeHint: '岗位、负责人、连接和工具分别确认',
    enableNote: '发布企业配置会生成岗位建议。新岗位仍需人工绑定 Agent、配置工具，才能开始工作。',
    review: '审阅候选流程',
  },
};
const EMPTY = { name: '', goal: '', boundaries: '' };
const TIMEOUT = 12_000;

export function CompanyContextPanel({ fromOrganization }: { fromOrganization: boolean }) {
  const t = useT(TEXT);
  const confirmRef = useRef<(() => Promise<boolean>) | null>(null);
  const [orgGate, setOrgGate] = useState({ loaded: false, ready: false, busy: false });
  const [context, setContext] = useState<CompanyContext | null>();
  const [fields, setFields] = useState(EMPTY);
  const [published, setPublished] = useState(false);
  const [orgPublished, setOrgPublished] = useState(false);
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

  async function save(event: FormEvent) {
    event.preventDefault();
    if (state === 'saving' || state === 'conflict' || !orgGate.loaded || orgGate.busy) return;
    setState('saving');
    setPublished(false);
    setOrgPublished(false);
    try {
      const response = await api<{ context: CompanyContext }>('/api/v1/sop/company-context', {
        method: 'PUT', body: JSON.stringify({ ...fields, expectedVersion: context?.version ?? 0 }),
      });
      if (response.status === 409) { setState('conflict'); return; }
      if (response.status !== 200 || !response.body.context) { setState('saveError'); return; }
      const next = response.body.context;
      setContext(next);
      setFields({ name: next.name, goal: next.goal, boundaries: next.boundaries });
      // The context always saves. The team is published only when an organization draft is ready to confirm,
      // so an empty draft never turns into a failed confirmation.
      if (orgGate.ready) {
        const confirmed = await confirmRef.current?.() ?? false;
        if (!confirmed) { setState('saveError'); return; }
        setOrgPublished(true);
      }
      setPublished(true);
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
      {state === 'error' ? <p className="warn" role="alert">{t('loadError')}</p> : <form className="stack" onSubmit={save}>
          {state === 'loading' ? <p className="helper" role="status">{t('loading')}</p> : null}
          <label className="field"><span>{t('name')}</span><input required maxLength={160} disabled={state === 'saving' || state === 'loading'} value={fields.name}
            onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
          <label className="field"><span>{t('goal')}</span><textarea required maxLength={4000} rows={3} disabled={state === 'saving' || state === 'loading'} value={fields.goal}
            onChange={event => setFields({ ...fields, goal: event.target.value })} /></label>
          <label className="field"><span>{t('boundaries')}</span><textarea maxLength={4000} rows={3} disabled={state === 'saving' || state === 'loading'} value={fields.boundaries}
            aria-describedby="company-context-boundary-hint" onChange={event => setFields({ ...fields, boundaries: event.target.value })} /></label>
          <p className="helper" id="company-context-boundary-hint">{t('boundaryHint')}</p>
          <OrganizationPublish embedded confirmRef={confirmRef} onGate={setOrgGate} />
          {state === 'conflict' || state === 'saveError' ? <p className="warn" role="alert">{t(state)}</p> : null}
          <button className="btn primary" disabled={state === 'saving' || state === 'loading' || state === 'conflict' || !orgGate.loaded || orgGate.busy || !fields.name.trim() || !fields.goal.trim()}>
            {state === 'saving' ? t('saving') : t('save')}
          </button>
          {state === 'ready' && published && context && !dirty ? <p className="helper" role="status">{t(orgPublished ? 'saved' : 'savedNoOrg', { version: context.version })}</p> : null}
        </form>}
      {state === 'error' || state === 'conflict' ? <button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>{t('reload')}</button> : null}
      {fromOrganization ? <a className="btn" href="#brain?tab=results&org=1">{t('review')}</a> : null}
    </section>
    <aside className="ux-setup-guide">
      <h2>{t('enable')}</h2>
      <a href="#knowledge"><span><strong>{t('knowledge')}</strong><small>{knowledgeCount ? t('knowledgeHint', { n: knowledgeCount }) : t('knowledgeEmpty')}</small></span></a>
      <a href="#brain?tab=sop"><span><strong>{t('flow')}</strong><small>{flow ? t('flowHint', { name: flow.title, version: flow.version }) : t('flowEmpty')}</small></span></a>
      <a href="#employees"><span><strong>{t('employees')}</strong><small>{t('employeeHint')}</small></span></a>
      <p>{t('enableNote')}</p>
    </aside>
  </div>;
}
