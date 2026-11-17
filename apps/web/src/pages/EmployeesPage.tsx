import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useLang, useT, type Dict } from '../i18n';
import './EmployeesPage.css';
import { PLAN_TEXT, planErrorKey, TeamPlanPreview, TeamSizePlanner, type TeamPlanView } from './TeamSizePlanner';
import { translate } from '../i18n';
import { EmployeeWall } from './EmployeeWall';
import { EmployeeManage, type RegistryEmployee } from './EmployeeManage';
import { EmployeeFeedback } from './EmployeeFeedback';

/**
 * Digital employees = the organization draft (PRD §3.3 step 3 and §3.4). Step 2 of the main line:
 * knowledge analysis → review roles here → one "Confirm organization" → publish SOPs in Super Agent.
 * Edits on this page apply directly; the only confirmation is the one that creates the team.
 */
const ROOT = '/api/v1/knowledge';

interface Evidence { sourceId: string; version: string; locator: string; quote: string }
interface Role {
  id: string; key: string; name: string; duty: string; prompt: string; promptEdited: boolean; origin: 'manual' | 'inferred';
  evidence: Evidence[]; privateSource: boolean; tools: string[]; sops: string[]; employeeId: string | null;
}
interface ToolDraft { id: string; key: string; name: string; description: string; evidence: Evidence[]; toolId: string | null; match: 'existing' | 'placeholder'; matchName: string | null }
interface SopDraft { id: string; key: string; name: string; description: string; evidence: Evidence[] }
interface Organization {
  employees: Role[]; tools: ToolDraft[]; sops: SopDraft[];
  confirmation: { confirmedAt: string; revision: number; employees: number; tools: number } | null;
  changedSinceConfirmation: boolean; missing: number;
  blocked: 'analysis_running' | 'analysis_stale' | 'no_employees' | null;
  canConfirm: boolean;
  teamPlan?: TeamPlanView | null;
}

export const TEXT = {
  en: {
    title: 'Digital employees',
    subtitle: 'Review the organization draft from your company knowledge: who does what, with which tools, in which workflows.',
    wallSubtitle: 'Make duties, owners and tools clear, then hand work to the right employee.',
    backToWall: 'All employees',
    stepKnowledge: '1 Knowledge', stepTeam: '2 Organization', stepFlow: '3 Workflows', stepRun: '4 Command room',
    loading: 'Loading the organization draft…',
    loadFailed: 'Could not load the organization draft.',
    retry: 'Try again',
    noAccess: 'Only an owner or administrator can review and confirm the organization.',
    blockedRunning: 'Analysis is still running. The draft will be ready to confirm when it finishes.',
    blockedStale: 'Materials changed while they were being analyzed. Run the analysis again before confirming.',
    emptyTitle: 'No organization draft yet',
    emptyBody: 'Add and check materials in Company knowledge, then run an analysis. Suggested roles, tools and workflows appear here with their sources.',
    goKnowledge: 'Go to Company knowledge',
    rolesTitle: 'Roles ({n})',
    toolsTitle: 'Tools ({n})',
    sopsTitle: 'Workflows ({n})',
    originInferred: 'From analysis',
    originManual: 'Added by hand · no source',
    privateSource: 'From your MCP source',
    confirmedRole: 'Created · not connected',
    duty: 'Responsibilities',
    prompt: 'System prompt',
    promptDefault: 'Starting prompt — edit it to fit this role.',
    usesTools: 'Tools', joinsSops: 'Workflows', none: 'None yet',
    evidence: 'Sources ({n})',
    edit: 'Edit', save: 'Save', cancel: 'Cancel', remove: 'Delete', merge: 'Merge into…',
    mergeInto: 'Merge “{name}” into', mergeConfirm: 'Merge',
    mergeHint: 'The kept role takes over its tools and workflows.',
    removeConfirm: 'Delete “{name}”?', removeImpact: 'It is removed from: {list}. Future analyses will not add it back.', removeNoImpact: 'Future analyses will not add it back.',
    removeTool: 'Delete “{name}”? Roles that use it: {list}.',
    toolExisting: 'Reusable: {name}', toolPlaceholder: 'Missing · placeholder will be created', toolCreated: 'Placeholder created', toolReused: 'Reusing existing tool',
    usedBy: 'Used by: {list}', joinedBy: 'Roles: {list}', nobody: 'no role yet',
    addRole: 'Add a role', roleName: 'Role name', addRoleBtn: 'Add role',
    confirmBtn: 'Confirm organization', applyBtn: 'Apply changes', confirming: 'Confirming…',
    summaryNew: 'Creates {e} employees (not connected, no tools or accounts granted) and {t} tool placeholders.',
    summaryChanged: 'You changed the draft since it was confirmed. Applying updates the same team — nothing is duplicated.',
    summaryDone: 'Team created: {e} employees and {t} tools. Next, review and publish the workflows.',
    summaryMissing: 'This server restarted and {n} employees need to be restored. Confirm again to restore them under the same IDs.',
    nextFlow: 'Next: publish workflows',
    openTools: 'Open employee tools',
    confirmedAt: 'Confirmed {date} · revision {n}',
    draft: 'Draft',
    unsaved: 'Changes not yet applied',
    saved: 'Saved.', merged: 'Merged.', removed: 'Deleted.', added: 'Role added.',
    confirmed: 'Organization confirmed. {e} new employees, {t} new tool placeholders.',
    confirmedRetired: 'Organization confirmed. {e} new, {r} removed, {t} new tool placeholders.',
    busyKept: 'Not removed yet because they still have work in progress: {names}. Reassign or finish that work, then confirm again.',
    planPending: 'A plan for {n} roles is waiting below. Confirming now uses the current {m} roles — adopt the plan first if you want {n}.',
    error_analysis_running: 'Analysis is still running.',
    error_analysis_stale: 'Materials changed during analysis. Run it again first.',
    error_no_employees: 'The draft has no roles yet.',
    error_not_found: 'That draft item no longer exists. Refresh and try again.',
    error_forbidden: 'You need owner or administrator access.',
    error_generic: 'The request did not complete. Try again.',
    sep: ', ',
  },
  zh: {
    title: '数字员工',
    subtitle: '审阅从企业知识生成的组织草案：谁负责什么、用哪些工具、参与哪些流程。',
    wallSubtitle: '明确职责、负责人和可用工具，再把工作交给合适的员工。',
    backToWall: '全部员工',
    stepKnowledge: '1 企业知识', stepTeam: '2 确认组织', stepFlow: '3 发布流程', stepRun: '4 指挥室执行',
    loading: '正在加载组织草案…',
    loadFailed: '组织草案加载失败。',
    retry: '重试',
    noAccess: '只有企业负责人或管理员可以审阅和确认组织。',
    blockedRunning: '分析仍在进行，完成后即可确认组织。',
    blockedStale: '资料在分析期间发生了变化，请重新分析后再确认。',
    emptyTitle: '还没有组织草案',
    emptyBody: '先在企业知识里添加并核对资料，然后开始分析。推荐的岗位、工具和流程会带着原文依据出现在这里。',
    goKnowledge: '去企业知识',
    rolesTitle: '岗位（{n}）',
    toolsTitle: '工具（{n}）',
    sopsTitle: '流程（{n}）',
    originInferred: '分析推荐',
    originManual: '人工创建 · 无知识依据',
    privateSource: '来自你的 MCP 来源',
    confirmedRole: '已创建 · 未连接',
    duty: '职责',
    prompt: '系统提示词',
    promptDefault: '初始提示词，可按岗位修改。',
    usesTools: '工具', joinsSops: '流程', none: '暂无',
    evidence: '依据（{n}）',
    edit: '编辑', save: '保存', cancel: '取消', remove: '删除', merge: '合并到…',
    mergeInto: '把「{name}」合并到', mergeConfirm: '合并',
    mergeHint: '保留的岗位会接手它的工具和流程。',
    removeConfirm: '删除「{name}」？', removeImpact: '会从这些地方移除：{list}。之后重新分析也不会再加回。', removeNoImpact: '之后重新分析也不会再加回。',
    removeTool: '删除「{name}」？正在使用它的岗位：{list}。',
    toolExisting: '可复用：{name}', toolPlaceholder: '缺失 · 确认后建占位', toolCreated: '已建占位', toolReused: '复用已有工具',
    usedBy: '使用岗位：{list}', joinedBy: '参与岗位：{list}', nobody: '暂无岗位',
    addRole: '新增岗位', roleName: '岗位名称', addRoleBtn: '添加岗位',
    confirmBtn: '确认组织', applyBtn: '应用修改', confirming: '正在确认…',
    summaryNew: '将创建 {e} 名数字员工（未连接，不授予工具或账号）和 {t} 个工具占位。',
    summaryChanged: '确认之后草案有改动。应用修改会更新同一套团队，不会重复创建。',
    summaryDone: '团队已建立：{e} 名数字员工、{t} 个工具。下一步审阅并发布流程。',
    summaryMissing: '服务重启后有 {n} 名员工需要恢复，再确认一次即按原 ID 恢复。',
    nextFlow: '下一步：发布流程',
    openTools: '查看员工工具',
    confirmedAt: '{date} 已确认 · 第 {n} 版',
    draft: '草案',
    unsaved: '有未应用的修改',
    saved: '已保存。', merged: '已合并。', removed: '已删除。', added: '已添加岗位。',
    confirmed: '组织已确认。新建 {e} 名员工、{t} 个工具占位。',
    confirmedRetired: '组织已确认。新建 {e} 名、移除 {r} 名员工，新建 {t} 个工具占位。',
    busyKept: '以下员工还有进行中的工作，暂未移除：{names}。请先改派或完成这些工作，再确认一次。',
    planPending: '下方有一个 {n} 个岗位的人数方案还没采用。现在确认会按当前 {m} 个岗位创建员工；想要 {n} 个请先「采用这个方案」。',
    error_analysis_running: '分析仍在进行。',
    error_analysis_stale: '资料在分析期间有变化，请先重新分析。',
    error_no_employees: '草案里还没有岗位。',
    error_not_found: '该草案项已不存在，请刷新后重试。',
    error_forbidden: '需要企业负责人或管理员权限。',
    error_generic: '请求未完成，请重试。',
    sep: '、',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;
type T = (key: Key, vars?: Record<string, string | number>) => string;

class RequestError extends Error { constructor(public code: string) { super(code); } }

async function call<R>(path: string, init?: RequestInit): Promise<R> {
  const { status, body } = await api<R & { error?: string }>(`${ROOT}${path}`, init);
  if (status >= 400) throw new RequestError((body as { error?: string }).error ?? 'generic');
  return body;
}

function Sources({ evidence, t }: { evidence: Evidence[]; t: T }) {
  if (!evidence.length) return null;
  return <details className="org-sources">
    <summary>{t('evidence', { n: evidence.length })}</summary>
    <ul>{evidence.map((e, i) => <li key={i}><code>{e.locator}</code><q>{e.quote}</q></li>)}</ul>
  </details>;
}

export function RoleCard({ role, org, busy, t, onSave, onMerge, onRemove }: {
  role: Role; org: Organization; busy: boolean; t: T;
  onSave: (role: Role, patch: { name: string; duty: string; prompt: string; tools: string[]; sops: string[] }) => Promise<boolean>;
  onMerge: (role: Role, into: string) => void; onRemove: (role: Role) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'merge' | 'remove'>('view');
  const [name, setName] = useState(role.name), [duty, setDuty] = useState(role.duty), [prompt, setPrompt] = useState(role.prompt);
  const [tools, setTools] = useState(role.tools), [sops, setSops] = useState(role.sops);
  const [into, setInto] = useState('');
  const toolName = (key: string) => org.tools.find(x => x.key === key)?.name ?? key;
  const sopName = (key: string) => org.sops.find(x => x.key === key)?.name ?? key;
  const others = org.employees.filter(e => e.id !== role.id);
  const impact = [...role.tools.map(toolName), ...role.sops.map(sopName)];
  function reset() { setName(role.name); setDuty(role.duty); setPrompt(role.prompt); setTools(role.tools); setSops(role.sops); setMode('view'); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave(role, { name: name.trim(), duty: duty.trim(), prompt: prompt.trim(), tools, sops })) setMode('view');
  }
  const toggle = (list: string[], key: string, on: boolean) => on ? [...list, key] : list.filter(k => k !== key);

  return <article className="org-role" aria-labelledby={`role-${role.id}`}>
    <header className="org-role-head">
      <h3 id={`role-${role.id}`}>{role.name}</h3>
      <div className="org-badges">
        {role.employeeId ? <span className="org-badge is-green">{t('confirmedRole')}</span> : null}
        <span className="org-badge">{t(role.origin === 'manual' ? 'originManual' : 'originInferred')}</span>
        {role.privateSource ? <span className="org-badge is-gold">{t('privateSource')}</span> : null}
      </div>
    </header>
    {mode === 'edit' ? <form className="org-edit" onSubmit={submit}>
      <label className="field"><span>{t('roleName')}</span><input required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="field"><span>{t('duty')}</span><textarea required rows={3} maxLength={4000} value={duty} onChange={e => setDuty(e.target.value)} /></label>
      <label className="field"><span>{t('prompt')}</span><textarea rows={5} maxLength={8000} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      {org.tools.length ? <fieldset className="org-picks"><legend>{t('usesTools')}</legend>
        {org.tools.map(x => <label key={x.key}><input type="checkbox" checked={tools.includes(x.key)} onChange={e => setTools(toggle(tools, x.key, e.target.checked))} />{x.name}</label>)}
      </fieldset> : null}
      {org.sops.length ? <fieldset className="org-picks"><legend>{t('joinsSops')}</legend>
        {org.sops.map(x => <label key={x.key}><input type="checkbox" checked={sops.includes(x.key)} onChange={e => setSops(toggle(sops, x.key, e.target.checked))} />{x.name}</label>)}
      </fieldset> : null}
      <div className="org-row">
        <button className="btn primary" disabled={busy || !name.trim() || !duty.trim()}>{t('save')}</button>
        <button className="btn" type="button" onClick={reset}>{t('cancel')}</button>
      </div>
    </form> : <>
      <p className="org-duty">{role.duty}</p>
      <dl className="org-links">
        <dt>{t('usesTools')}</dt>
        <dd>{role.tools.length ? role.tools.map(k => {
          const tool = org.tools.find(x => x.key === k);
          return <span key={k} className={`org-chip ${tool?.match === 'existing' ? 'is-ready' : 'is-missing'}`}>{toolName(k)}</span>;
        }) : <span className="helper">{t('none')}</span>}</dd>
        <dt>{t('joinsSops')}</dt>
        <dd>{role.sops.length ? role.sops.map(k => <span key={k} className="org-chip">{sopName(k)}</span>) : <span className="helper">{t('none')}</span>}</dd>
      </dl>
      <details className="org-prompt"><summary>{t('prompt')}</summary>
        {!role.promptEdited ? <p className="helper">{t('promptDefault')}</p> : null}
        <pre>{role.prompt}</pre>
      </details>
      <Sources evidence={role.evidence} t={t} />
      {mode === 'merge' ? <div className="org-inline" role="group" aria-label={t('mergeInto', { name: role.name })}>
        <label className="field"><span>{t('mergeInto', { name: role.name })}</span>
          <select value={into} onChange={e => setInto(e.target.value)}>
            <option value="" disabled>—</option>
            {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <p className="helper">{t('mergeHint')}</p>
        <div className="org-row">
          <button className="btn primary" type="button" disabled={busy || !into} onClick={() => onMerge(role, into)}>{t('mergeConfirm')}</button>
          <button className="btn" type="button" onClick={() => setMode('view')}>{t('cancel')}</button>
        </div>
      </div> : null}
      {mode === 'remove' ? <div className="org-inline is-danger" role="alertdialog" aria-label={t('removeConfirm', { name: role.name })}>
        <strong>{t('removeConfirm', { name: role.name })}</strong>
        <p className="helper">{impact.length ? t('removeImpact', { list: impact.join(t('sep')) }) : t('removeNoImpact')}</p>
        <div className="org-row">
          <button className="btn danger" type="button" disabled={busy} onClick={() => onRemove(role)}>{t('remove')}</button>
          <button className="btn" type="button" onClick={() => setMode('view')}>{t('cancel')}</button>
        </div>
      </div> : null}
      {org.canConfirm && mode === 'view' ? <div className="org-row org-role-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => setMode('edit')}>{t('edit')}</button>
        {others.length ? <button className="btn" type="button" disabled={busy} onClick={() => setMode('merge')}>{t('merge')}</button> : null}
        <button className="btn org-quiet" type="button" disabled={busy} onClick={() => setMode('remove')}>{t('remove')}</button>
      </div> : null}
    </>}
  </article>;
}

/** #employees = card wall once the team exists; #employees?view=draft = the organization draft review. */
function employeesRoute() {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.split('?')[1]);
  return { draft: params.get('view') === 'draft', role: params.get('role') ?? '', add: params.has('add'), manage: params.get('manage') ?? '' };
}

export function EmployeesPage() {
  const t = useT(TEXT) as T;
  const [lang] = useLang();
  const [route, setRoute] = useState(employeesRoute);
  useEffect(() => {
    const update = () => setRoute(employeesRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [team, setTeam] = useState<RegistryEmployee[]>([]);
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newRole, setNewRole] = useState(''), [newDuty, setNewDuty] = useState('');
  const [removingTool, setRemovingTool] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planFallback, setPlanFallback] = useState(false);
  const planT = (key: keyof typeof PLAN_TEXT.en) => translate(PLAN_TEXT, lang, key);

  const describe = useCallback((caught: unknown) => {
    const code = caught instanceof RequestError ? caught.code : 'generic';
    const key = `error_${code}` as Key;
    return key in TEXT.en ? t(key) : t('error_generic');
  }, [t]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [organization, registry] = await Promise.all([
        call<Organization>('/organization'),
        api<RegistryEmployee[]>('/api/v1/employees/').then(r => r.status === 200 && Array.isArray(r.body) ? r.body : []).catch(() => []),
      ]);
      setOrg(organization); setTeam(registry); setLoadError(null);
    }
    catch (caught) { setLoadError(caught instanceof RequestError && caught.code === 'forbidden' ? t('noAccess') : t('loadFailed')); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  async function run(work: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); setNotice(done); await load(); return true; }
    catch (caught) { setError(describe(caught)); return false; }
    finally { setBusy(false); }
  }
  const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

  const saveRole = (role: Role, p: { name: string; duty: string; prompt: string; tools: string[]; sops: string[] }) =>
    run(() => post(`/recommendations/${encodeURIComponent(role.id)}/lock`, { name: p.name, description: p.duty, prompt: p.prompt === role.prompt && !role.promptEdited ? '' : p.prompt, assignment: { tools: p.tools, sops: p.sops } }), t('saved'));
  const mergeRole = (role: Role, into: string) => void run(() => post(`/recommendations/${encodeURIComponent(role.id)}/merge`, { into }), t('merged'));
  const removeRole = (role: Role) => void run(() => post(`/recommendations/${encodeURIComponent(role.id)}/delete`), t('removed'));
  const removeTool = (tool: ToolDraft) => void run(() => post(`/recommendations/${encodeURIComponent(tool.id)}/delete`), t('removed')).then(() => setRemovingTool(null));
  async function addRole(event: FormEvent) {
    event.preventDefault();
    if (await run(() => post('/manual-roles', { name: newRole.trim(), description: newDuty.trim() }), t('added'))) { setNewRole(''); setNewDuty(''); }
  }
  async function planTeam(count: number) {
    setBusy(true); setPlanning(true); setError(null); setNotice(null);
    try {
      const result = await post('/organization/plan', { count }) as { fallbackReason: string | null };
      setPlanFallback(!!result.fallbackReason);
      await load();
    } catch (caught) {
      const key = planErrorKey(caught instanceof RequestError ? caught.code : 'generic');
      setError(key ? planT(key) : describe(caught));
    } finally { setBusy(false); setPlanning(false); }
  }
  const adoptPlan = (planId: string) => void run(() => post('/organization/plan/adopt', { planId }), planT('afterAdopt')).then(ok => { if (ok) setPlanFallback(false); });
  const discardPlan = () => void run(() => post('/organization/plan/discard'), '').then(() => setPlanFallback(false));
  async function confirm() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await post('/organization/confirm') as { createdEmployees: number; createdTools: number; retiredEmployees?: number; busyEmployees?: string[] };
      const done = result.retiredEmployees
        ? t('confirmedRetired', { e: result.createdEmployees, r: result.retiredEmployees, t: result.createdTools })
        : t('confirmed', { e: result.createdEmployees, t: result.createdTools });
      setNotice(result.busyEmployees?.length ? `${done} ${t('busyKept', { names: result.busyEmployees.join(t('sep')) })}` : done);
      await load();
    } catch (caught) { setError(describe(caught)); }
    finally { setBusy(false); }
  }

  const usersOf = useMemo(() => (key: string, field: 'tools' | 'sops') => org?.employees.filter(e => e[field].includes(key)).map(e => e.name) ?? [], [org]);
  const newTools = org?.tools.filter(x => x.match === 'placeholder' && !x.toolId).length ?? 0;
  const newEmployees = org?.employees.filter(e => !e.employeeId).length ?? 0;
  const confirmedState = org?.confirmation && !org.changedSinceConfirmation && !org.missing;
  // The wall follows a confirmed organization; before that the page guides through the draft (or says how to start).
  const wall = !route.draft && team.length > 0 && !!org?.confirmation;
  useEffect(() => {
    if (!route.draft || !route.role || !org) return;
    document.getElementById(`role-${route.role}`)?.scrollIntoView({ block: 'start' });
  }, [route.draft, route.role, org]);

  if (wall) return <div className="org-page">
    <header className="page-head org-head">
      <div>
        <h1>{t('title')}</h1>
        <p>{t('wallSubtitle')}</p>
      </div>
    </header>
    {loadError ? <div className="org-alert" role="alert">{loadError}</div> : null}
    <EmployeeWall employees={team} hasDraft={!!org && org.blocked !== 'no_employees'}
      onManage={employee => { window.location.hash = `employees?manage=${encodeURIComponent(employee.id)}`; }} />
    <EmployeeFeedback employees={team} />
    {team.find(employee => employee.id === route.manage) ?
      <EmployeeManage employee={team.find(employee => employee.id === route.manage)!} lang={lang}
        onClose={() => { window.location.hash = 'employees'; }} onChanged={() => void load()} /> : null}
    {confirmedState ? <footer className="org-bar">
      <p>{t('summaryDone', { e: org!.confirmation!.employees, t: org!.confirmation!.tools })}</p>
      <a className="btn primary" href="#brain?org=1">{t('nextFlow')}</a>
    </footer> : null}
  </div>;

  return <div className="org-page">
    <header className="page-head org-head">
      <div>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        {team.length ? <a className="org-back" href="#employees">← {t('backToWall')}</a> : null}
      </div>
      {org ? <span className={`org-badge ${confirmedState ? 'is-green' : org.confirmation ? 'is-gold' : ''}`}>
        {org.confirmation ? (org.changedSinceConfirmation ? t('unsaved') : t('confirmedAt', { date: new Date(org.confirmation.confirmedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }), n: org.confirmation.revision })) : t('draft')}
      </span> : null}
    </header>
    <ol className="org-steps" aria-label={t('title')}>
      <li className="is-done"><a href="#knowledge">{t('stepKnowledge')}</a></li>
      <li aria-current="step">{t('stepTeam')}</li>
      <li className={confirmedState ? 'is-next' : ''}><a href="#brain?org=1">{t('stepFlow')}</a></li>
      <li><a href="#room">{t('stepRun')}</a></li>
    </ol>

    {error ? <div className="org-alert" role="alert">{error}</div> : null}
    {notice ? <div className="org-notice" role="status">{notice}</div> : null}
    {loading && !org ? <div className="panel org-empty" role="status">{t('loading')}</div> : null}
    {loadError && !org ? <div className="panel org-empty"><p>{loadError}</p><button className="btn" onClick={() => void load()}>{t('retry')}</button></div> : null}

    {org && org.blocked === 'no_employees' ? <section className="panel org-empty">
      <h2>{t('emptyTitle')}</h2>
      <p className="helper">{t('emptyBody')}</p>
      <a className="btn primary" href="#knowledge">{t('goKnowledge')}</a>
    </section> : null}

    {org && org.blocked !== 'no_employees' ? <>
      {org.blocked ? <div className="org-alert is-warning" role="status">
        <span>{t(org.blocked === 'analysis_running' ? 'blockedRunning' : 'blockedStale')}</span>
        <a className="btn" href="#knowledge">{t('goKnowledge')}</a>
      </div> : null}
      {!org.canConfirm ? <p className="helper">{t('noAccess')}</p> : null}
      {org.canConfirm ? <div className="panel team-size-panel">
        <TeamSizePlanner key={org.employees.length} current={org.employees.length} busy={busy} planning={planning} onPlan={count => void planTeam(count)} />
        {org.teamPlan ? <TeamPlanPreview plan={org.teamPlan} roles={org.employees} tools={org.tools} sops={org.sops} busy={busy} fallback={planFallback}
          onAdopt={() => adoptPlan(org.teamPlan!.id)} onDiscard={discardPlan} /> : null}
      </div> : null}

      <div className="org-layout">
        <section className="org-roles" aria-labelledby="org-roles-title">
          <h2 id="org-roles-title">{t('rolesTitle', { n: org.employees.length })}</h2>
          {org.employees.map(role => <RoleCard key={`${role.id}:${role.name}:${role.duty}:${role.prompt}:${role.tools.join()}:${role.sops.join()}`}
            role={role} org={org} busy={busy} t={t} onSave={saveRole} onMerge={mergeRole} onRemove={removeRole} />)}
          {org.canConfirm ? <details className="org-add" open={route.add || undefined}>
            <summary>{t('addRole')}</summary>
            <form className="org-edit" onSubmit={addRole}>
              <label className="field"><span>{t('roleName')}</span><input required maxLength={160} value={newRole} onChange={e => setNewRole(e.target.value)} /></label>
              <label className="field"><span>{t('duty')}</span><textarea required rows={3} maxLength={4000} value={newDuty} onChange={e => setNewDuty(e.target.value)} /></label>
              <p className="helper">{t('originManual')}</p>
              <button className="btn" disabled={busy || !newRole.trim() || !newDuty.trim()}>{t('addRoleBtn')}</button>
            </form>
          </details> : null}
        </section>

        <aside className="org-side">
          <section aria-labelledby="org-tools-title">
            <h2 id="org-tools-title">{t('toolsTitle', { n: org.tools.length })}</h2>
            {org.tools.length ? <ul className="org-list">{org.tools.map(tool => {
              const users = usersOf(tool.key, 'tools');
              const created = !!org.confirmation && !!tool.toolId;
              return <li key={tool.id}>
                <div className="org-list-head">
                  <strong>{tool.name}</strong>
                  <span className={`org-badge ${tool.match === 'existing' ? 'is-green' : created ? 'is-gold' : 'is-warning'}`}>
                    {tool.match === 'existing' ? (tool.matchName ? t('toolExisting', { name: tool.matchName }) : t('toolReused')) : created ? t('toolCreated') : t('toolPlaceholder')}
                  </span>
                </div>
                <p className="helper">{tool.description}</p>
                <p className="helper">{t('usedBy', { list: users.length ? users.join(t('sep')) : t('nobody') })}</p>
                <Sources evidence={tool.evidence} t={t} />
                {org.canConfirm ? (removingTool === tool.id ? <div className="org-inline is-danger">
                  <p className="helper">{t('removeTool', { name: tool.name, list: users.length ? users.join(t('sep')) : t('nobody') })}</p>
                  <div className="org-row">
                    <button className="btn danger" type="button" disabled={busy} onClick={() => removeTool(tool)}>{t('remove')}</button>
                    <button className="btn" type="button" onClick={() => setRemovingTool(null)}>{t('cancel')}</button>
                  </div>
                </div> : <button className="btn org-quiet org-small" type="button" disabled={busy} onClick={() => setRemovingTool(tool.id)}>{t('remove')}</button>) : null}
              </li>;
            })}</ul> : <p className="helper">{t('none')}</p>}
          </section>
          <section aria-labelledby="org-sops-title">
            <h2 id="org-sops-title">{t('sopsTitle', { n: org.sops.length })}</h2>
            {org.sops.length ? <ul className="org-list">{org.sops.map(sop => {
              const users = usersOf(sop.key, 'sops');
              return <li key={sop.id}>
                <strong>{sop.name}</strong>
                <p className="helper">{sop.description}</p>
                <p className="helper">{t('joinedBy', { list: users.length ? users.join(t('sep')) : t('nobody') })}</p>
                <Sources evidence={sop.evidence} t={t} />
              </li>;
            })}</ul> : <p className="helper">{t('none')}</p>}
          </section>
        </aside>
      </div>

      {org.canConfirm ? <footer className="org-bar">
        <p>{org.missing ? t('summaryMissing', { n: org.missing })
          : confirmedState ? t('summaryDone', { e: org.confirmation!.employees, t: org.confirmation!.tools })
          : org.confirmation ? t('summaryChanged')
          : t('summaryNew', { e: newEmployees, t: newTools })}</p>
        {org.teamPlan && org.teamPlan.target !== org.employees.length ? <p className="org-plan-pending" role="note">{t('planPending', { n: org.teamPlan.target, m: org.employees.length })}</p> : null}
        {confirmedState ? <div className="org-row">
          <a className="btn" href="#tools">{t('openTools')}</a>
          <a className="btn primary" href="#brain?org=1">{t('nextFlow')}</a>
        </div> : <button className="btn primary" type="button" disabled={busy || !!org.blocked} onClick={() => void confirm()}>
          {busy ? t('confirming') : org.confirmation ? t('applyBtn') : t('confirmBtn')}
        </button>}
      </footer> : null}
    </> : null}
  </div>;
}
