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
    title: 'Company setup', name: 'Company name', goal: 'Work to hand to the digital team',
    boundaries: 'Boundaries that must be followed', boundaryHint: 'Name the decisions that still need a person, and the limits the digital team must not cross.',
    save: 'Save configuration', saving: 'Saving…', saved: 'Saved configuration v{version}.',
    loading: 'Loading company setup…', loadError: 'Could not load the company setup.',
    conflict: 'The configuration changed while you were editing. Reload to see the latest version.',
    saveError: 'Could not save the configuration. Try again.', reload: 'Reload',
    ready: 'Team and workflow readiness', employees: 'Digital employees', tools: 'Tools',
    employeeCount: '{ready} online of {total}', toolCount: '{ready} available of {total}',
    unavailable: 'Unavailable', checking: 'Checking…', published: 'Active workflows',
    noWorkflows: 'Publish a workflow to make it available in the command room.',
    configure: 'Open workflow editor', review: 'Review workflow candidates', openRoom: 'Open command room',
  },
  zh: {
    title: '企业配置', name: '企业名称', goal: '希望交给数字团队的工作',
    boundaries: '必须遵守的边界', boundaryHint: '写清哪些事需要人决定，以及数字团队不得越过的限制。',
    save: '保存配置', saving: '保存中…', saved: '已保存配置 v{version}。',
    loading: '正在读取企业配置…', loadError: '无法读取企业配置。',
    conflict: '编辑期间配置已更新，请重新读取最新版本。',
    saveError: '无法保存配置，请重试。', reload: '重新读取',
    ready: '团队与流程就绪', employees: '数字员工', tools: '工具',
    employeeCount: '在线 {ready} / 共 {total}', toolCount: '可用 {ready} / 共 {total}',
    unavailable: '暂不可用', checking: '正在核对…', published: '生效流程',
    noWorkflows: '流程发布生效后，指挥室即可启动。',
    configure: '打开流程编辑器', review: '审阅候选流程', openRoom: '进入指挥室',
  },
};
const EMPTY = { name: '', goal: '', boundaries: '' };
const TIMEOUT = 12_000;
type Readiness = { ready: number; total: number } | null;

export function CompanyContextPanel({ fromOrganization }: { fromOrganization: boolean }) {
  const t = useT(TEXT);
  const [context, setContext] = useState<CompanyContext | null>();
  const [fields, setFields] = useState(EMPTY);
  const [workflows, setWorkflows] = useState<PublishedWorkflow[] | null>();
  const [team, setTeam] = useState<Readiness>();
  const [tools, setTools] = useState<Readiness>();
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
    void api<{ status: string }[]>('/api/v1/employees/', { signal }).then(({ status, body }) => {
      if (!controller.signal.aborted) setTeam(status === 200 && Array.isArray(body)
        ? { total: body.length, ready: body.filter(row => row.status === 'online' || row.status === 'busy').length } : null);
    }).catch(() => { if (!controller.signal.aborted) setTeam(null); });
    void api<{ stage: string; state: string }[]>('/api/v1/tools/', { signal }).then(({ status, body }) => {
      if (!controller.signal.aborted) setTools(status === 200 && Array.isArray(body)
        ? { total: body.length, ready: body.filter(row => row.stage === 'available' && row.state === 'active').length } : null);
    }).catch(() => { if (!controller.signal.aborted) setTools(null); });
    return () => controller.abort();
  }, [attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (state === 'saving' || state === 'conflict') return;
    setState('saving');
    try {
      const response = await api<{ context: CompanyContext }>('/api/v1/sop/company-context', {
        method: 'PUT', body: JSON.stringify({ ...fields, expectedVersion: context?.version ?? 0 }),
      });
      if (response.status === 409) { setState('conflict'); return; }
      if (response.status !== 200 || !response.body.context) { setState('saveError'); return; }
      const next = response.body.context;
      setContext(next);
      setFields({ name: next.name, goal: next.goal, boundaries: next.boundaries });
      setState('ready');
    } catch {
      setState('saveError');
    }
  }

  const dirty = Object.keys(fields).some(key => {
    const field = key as keyof typeof EMPTY;
    return fields[field] !== (context?.[field] ?? '');
  });
  return <section className="panel stack company-setup" aria-labelledby="company-context-heading">
    <h2 className="h2" id="company-context-heading">{t('title')}</h2>
    {state === 'loading' ? <p className="helper" role="status">{t('loading')}</p> : state === 'error' ?
      <p className="warn" role="alert">{t('loadError')}</p> : <form className="stack" onSubmit={save}>
        <label className="field"><span>{t('name')}</span><input required maxLength={160} disabled={state === 'saving'} value={fields.name}
          onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
        <label className="field"><span>{t('goal')}</span><textarea required maxLength={4000} rows={3} disabled={state === 'saving'} value={fields.goal}
          onChange={event => setFields({ ...fields, goal: event.target.value })} /></label>
        <label className="field"><span>{t('boundaries')}</span><textarea maxLength={4000} rows={3} disabled={state === 'saving'} value={fields.boundaries}
          aria-describedby="company-context-boundary-hint" onChange={event => setFields({ ...fields, boundaries: event.target.value })} /></label>
        <p className="helper" id="company-context-boundary-hint">{t('boundaryHint')}</p>
        {state === 'conflict' || state === 'saveError' ? <p className="warn" role="alert">{t(state)}</p> : null}
        <button className="btn primary" disabled={!dirty || state === 'saving' || state === 'conflict' || !fields.name.trim() || !fields.goal.trim()}>
          {state === 'saving' ? t('saving') : t('save')}
        </button>
        {state === 'ready' && context && !dirty ? <p className="helper" role="status">{t('saved', { version: context.version })}</p> : null}
      </form>}
    {state === 'error' || state === 'conflict' ? <button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>{t('reload')}</button> : null}
    <div className="company-setup-ready">
      <h3 id="workflow-readiness-heading">{t('ready')}</h3>
      <dl className="agent-readiness">
        <div><dt><a href="#employees">{t('employees')}</a></dt><dd>{team ? t('employeeCount', team) : t(team === null ? 'unavailable' : 'checking')}</dd></div>
        <div><dt><a href="#tools">{t('tools')}</a></dt><dd>{tools ? t('toolCount', tools) : t(tools === null ? 'unavailable' : 'checking')}</dd></div>
      </dl>
      <h3>{t('published')}</h3>
      {workflows?.length ? <ul className="agent-workflow-list">
        {workflows.map(workflow => <li key={workflow.id}>
          <a href={`#brain?tab=sop&sop=${encodeURIComponent(workflow.sopId)}`}>{workflow.title}</a><span>v{workflow.version}</span>
        </li>)}
      </ul> : <p className="helper">{t(workflows === undefined ? 'checking' : workflows === null ? 'unavailable' : 'noWorkflows')}</p>}
      {fromOrganization ? <a className="btn" href="#brain?tab=results&org=1">{t('review')}</a> : null}
      <a href={workflows?.length ? '#room' : '#brain?tab=sop'}>{t(workflows?.length ? 'openRoom' : 'configure')}</a>
    </div>
  </section>;
}
