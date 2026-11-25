import { useEffect, useRef, useState } from 'react';
import { LocalClients } from './LocalClients';
import { api } from '../api';
import { useT, type Dict } from '../i18n';
import { agentLabel, allowsBinding, LINK_INSTALLER_URL, useLinkDevices, type LinkBinding, type LinkDevice } from './link-devices';

const TEXT = {
  en: {
    title: 'Linked computers',
    lead: 'Bind a local project to a digital employee to run tasks from the Command room.',
    empty: 'No computer is paired yet. Install Link and allow it on Connect this computer.',
    loadError: 'Could not load linked computers.',
    revoke: 'Revoke',
    revoked: 'Revoked',
    employees: 'Allowed employees (blank = all)',
    projects: 'Allowed projects (blank = all)',
    save: 'Save limits',
    saved: 'Limits saved.',
    saveError: 'Could not save limits.',
    agents: 'Detected agents',
    registered: 'Online', live: 'Running a task', offline: 'Offline', waiting_auth: 'Sign in on computer',
    loading: 'Checking connected computers…', noProjects: 'On this computer, open the Link tray and choose Set up local agent. If Codex or Claude Code is missing, Link installs it and opens sign-in.',
    project: 'Local project', employee: 'Digital employee', choose: 'Select…', bind: 'Bind employee', unbind: 'Remove binding',
    bound: 'Bound', unbound: 'No employee bound', advanced: 'Device permissions', projectUnavailable: 'Project unavailable',
    employeeUnavailable: 'Employee removed', alreadyBound: 'This employee already has a binding. Remove it before choosing another project.',
    bindingError: 'Could not save the binding. Check project availability and device permissions.',
    bindSaved: 'Employee bound.',
    loadingName: 'Loading…',
    download: 'Download Link for Windows',
    downloadLatest: 'Download the latest Link (Windows)',
    downloadHint: 'This link always gets the newest version. A computer that already has Link offers the upgrade in its tray menu.',
    allBound: 'Every digital employee is already bound. To put this computer to work, add people in Team or remove a binding elsewhere.', allBoundMore: 'Every digital employee is already bound to a computer. To add another one here, add people in Team first.', bindRemoved: 'Binding removed.',
  },
  zh: {
    title: '已连接的电脑',
    lead: '将本地项目绑定到数字员工，就能在指挥室交办任务。',
    empty: '还没有配对电脑。安装 Link 后在「连接此电脑」页点允许。',
    loadError: '无法加载已连接电脑。',
    revoke: '吊销',
    revoked: '已吊销',
    employees: '允许的员工（留空=全部）',
    projects: '允许的项目（留空=全部）',
    save: '保存限制',
    saved: '限制已保存。',
    saveError: '无法保存限制。',
    agents: '已识别的 agent',
    registered: '在线', live: '正在执行任务', offline: '离线', waiting_auth: '等待本地登录',
    loading: '正在检查已连接的电脑…', noProjects: '在这台电脑上打开 Link 托盘，选择「配置本地 Agent」。如果没有命令行，Link 会安装并打开登录。',
    project: '本地项目', employee: '数字员工', choose: '请选择…', bind: '绑定员工', unbind: '移除绑定',
    bound: '已绑定', unbound: '未绑定员工', advanced: '设备权限', projectUnavailable: '项目不可用',
    employeeUnavailable: '员工已移除', alreadyBound: '这名员工已有绑定。请先移除旧绑定，再选择其他项目。',
    bindingError: '保存绑定失败，请检查项目是否可用及设备权限。',
    bindSaved: '已绑定员工。', bindRemoved: '已移除绑定。',
    loadingName: '正在读取…',
    download: '下载 Link（Windows）',
    downloadLatest: '下载最新版 Link（Windows）',
    downloadHint: '这个链接始终下载最新版本。已经装了 Link 的电脑，会在托盘菜单里提示升级。',
    allBound: '所有数字员工都已绑定。要让这台电脑干活，请在「数字员工」里增加人数，或先移除其他电脑上的绑定。',
    allBoundMore: '所有数字员工都已绑定电脑。要在这台电脑上再加一位，请先在「数字员工」里增加人数。',
  },
} satisfies Dict<string>;

type EmployeeChoice = { id: string; name: string };
type T = (key: keyof typeof TEXT.en) => string;

export function WorkerConnectPanel() {
  const t = useT(TEXT);
  const { devices: workers, unavailable, load } = useLinkDevices();
  // null until the list arrives: a binding is never called "employee removed" before we know.
  const [employees, setEmployees] = useState<EmployeeChoice[] | null>(null);
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.hash.split('?')[1]);
  const requestedEmployee = query.get('employee') ?? '';
  const focused = query.has('link');
  useEffect(() => {
    const controller = new AbortController();
    void api<EmployeeChoice[]>('/api/v1/employees/', { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setEmployees(response.status === 200 && Array.isArray(response.body) ? response.body : []);
    }).catch(() => { if (!controller.signal.aborted) setEmployees([]); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (focused) panel.current?.scrollIntoView({ block: 'start' });
  }, [focused, requestedEmployee]);

  async function saveBinding(id: string, binding: LinkBinding, remove = false) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await api<{ error?: string }>(`/api/v1/workers/${id}/room-binding`, {
        method: 'POST',
        body: JSON.stringify({ ...binding, remove }),
      });
      setNoticeIsError(response.status !== 200);
      setNotice(t(response.status === 200 ? (remove ? 'bindRemoved' : 'bindSaved')
        : response.body.error === 'employee_already_bound' ? 'alreadyBound' : 'bindingError'));
      await load();
    } catch {
      setNoticeIsError(true);
      setNotice(t('bindingError'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setNotice(null);
    try {
      const res = await api(`/api/v1/workers/${id}/revoke`, { method: 'POST', body: '{}' });
      if (res.status === 200) { await load(); return; }
    } catch { /* shown below */ }
    setNoticeIsError(true);
    setNotice(t('saveError'));
  }

  async function saveLimits(id: string, employees: string, projects: string) {
    setNotice(null);
    try {
      const res = await api(`/api/v1/workers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ allowEmployees: splitIds(employees), allowProjects: splitIds(projects) }),
      });
      if (res.status === 200) {
        setNoticeIsError(false);
        setNotice(t('saved'));
        await load();
        return;
      }
    } catch { /* shown below */ }
    setNoticeIsError(true);
    setNotice(t('saveError'));
  }

  const boundEmployees = new Set(workers?.filter(device => device.status !== 'revoked').flatMap(device =>
    (device.capabilities.roomAssignments ?? []).map(binding => binding.employeeId),
  ));

  return (
    <section ref={panel} className="panel setup-card" aria-labelledby="linked-computers">
      <header className="setup-card-head">
        <h2 id="linked-computers" className="h2">{t('title')}</h2>
        <p className="helper">{t('lead')}</p>
        <p className="link-download">
          <a className="btn" href={LINK_INSTALLER_URL} data-link-download>{t('downloadLatest')}</a>
          <span className="helper">{t('downloadHint')}</span>
        </p>
      </header>
      {unavailable ? <p role="alert">{t('loadError')}</p>
        : !workers ? <p className="helper" role="status">{t('loading')}</p>
          : workers.length === 0 ? <div className="state-empty"><p>{t('empty')}</p></div> : workers.map((w) => (
        <article key={w.id} data-worker={w.id} className="link-device">
          <div className="link-device-head">
            <h3>{w.name}</h3>
            <span className={`link-device-status is-${w.status}`}>{t(w.status)}</span>
          </div>
          {w.capabilities.agents?.length ? <p className="helper">{t('agents')} · {w.capabilities.agents.map(agentLabel).join(' · ')}</p> : null}
          {w.kind === 'link' && w.status !== 'revoked' ? <LocalClients device={w} onChanged={() => void load()} /> : null}
          {w.status !== 'revoked' ? <>
            <DeviceBindings key={requestedEmployee} worker={w} employees={employees ?? []} employeesLoaded={employees !== null} boundEmployees={boundEmployees}
              defaultEmployee={requestedEmployee} busy={busy} t={t} onSave={saveBinding} />
            <details className="link-device-permissions">
              <summary>{t('advanced')}</summary>
              <LimitForm worker={w} t={t} onSave={saveLimits} onRevoke={revoke} />
            </details>
          </> : null}
        </article>
      ))}
      {notice ? <p className={noticeIsError ? 'warn' : 'helper'} role={noticeIsError ? 'alert' : 'status'}>{notice}</p> : null}
    </section>
  );
}

/** One computer's bindings with the panel's own copy; exported for tests. */
export function DeviceBindingsForTest(props: Omit<Parameters<typeof DeviceBindings>[0], 't'>) {
  const t = useT(TEXT);
  return <DeviceBindings {...props} t={t} />;
}

function DeviceBindings({ worker, employees, employeesLoaded, boundEmployees, defaultEmployee, busy, t, onSave }: {
  worker: LinkDevice; employees: EmployeeChoice[]; employeesLoaded: boolean; boundEmployees: Set<string>; defaultEmployee: string; busy: boolean; t: T;
  onSave: (id: string, binding: LinkBinding, remove?: boolean) => Promise<void>;
}) {
  const [chosenProject, setProject] = useState('');
  const [chosenEmployee, setEmployee] = useState(defaultEmployee);
  const { projects = [], roomAssignments = [] } = worker.capabilities;
  const projectId = projects.some(project => project.id === chosenProject)
    ? chosenProject : (projects.length === 1 ? projects[0]!.id : '');
  const choices = employees.filter(employee => !boundEmployees.has(employee.id)
    && (!projectId || allowsBinding(worker, employee.id, projectId)));
  const employeeId = choices.some(choice => choice.id === chosenEmployee)
    ? chosenEmployee : (choices.length === 1 ? choices[0]!.id : '');
  return <>
    {roomAssignments.length ? <ul className="link-device-bindings">{roomAssignments.map(binding => {
      const project = projects.find(project => project.id === binding.projectId);
      const employee = employees.find(employee => employee.id === binding.employeeId);
      return <li key={JSON.stringify([binding.employeeId, binding.projectId])}>
        <div><strong>{employee?.name ?? (employeesLoaded ? t('employeeUnavailable') : t('loadingName'))}</strong> · {project?.name ?? t('projectUnavailable')}
          {project ? ` · ${agentLabel(project.agent)}` : ''}<small>{t('bound')}</small></div>
        <button className="btn" type="button" disabled={busy} onClick={() => void onSave(worker.id, binding, true)}>{t('unbind')}</button>
      </li>;
    })}</ul> : <p className="helper">{t('unbound')}</p>}
    {/* A computer already working is told how to add another employee; an idle one, why it has nobody. */}
    {projects.length && employeesLoaded && choices.length === 0 ? <p className="helper">{t(roomAssignments.length ? 'allBoundMore' : 'allBound')}</p> : null}
    {projects.length && !(employeesLoaded && choices.length === 0) ? <form className="link-device-form" onSubmit={event => {
      event.preventDefault();
      if (projectId && employeeId) void onSave(worker.id, { projectId, employeeId });
    }}>
      <label className="field"><span>{t('project')}</span><select value={projectId} onChange={e => setProject(e.target.value)} disabled={busy}>
        <option value="">{t('choose')}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {agentLabel(project.agent)}</option>)}
      </select></label>
      <label className="field"><span>{t('employee')}</span><select value={employeeId} onChange={e => setEmployee(e.target.value)} disabled={busy}>
        <option value="">{t('choose')}</option>
        {choices.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
      </select></label>
      <button className="btn primary" disabled={busy || !employeeId || !projectId}>{t('bind')}</button>
    </form> : projects.length ? null : <p className="helper">{t('noProjects')}</p>}
  </>;
}

function splitIds(value: string): string[] {
  return value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function LimitForm({ worker, t, onSave, onRevoke }: {
  worker: LinkDevice;
  t: (key: keyof typeof TEXT.en) => string;
  onSave: (id: string, employees: string, projects: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [employees, setEmployees] = useState((worker.capabilities.allowEmployees ?? []).join(', '));
  const [projects, setProjects] = useState((worker.capabilities.allowProjects ?? []).join(', '));
  return (
    <>
      <label className="field"><span>{t('employees')}</span>
        <input value={employees} onChange={(e) => setEmployees(e.target.value)} />
      </label>
      <label className="field"><span>{t('projects')}</span>
        <input value={projects} onChange={(e) => setProjects(e.target.value)} />
      </label>
      <div className="setup-actions">
        <button className="btn" type="button" onClick={() => void onSave(worker.id, employees, projects)}>{t('save')}</button>
        <button className="btn setup-danger-btn" type="button" onClick={() => void onRevoke(worker.id)}>{t('revoke')}</button>
      </div>
    </>
  );
}
