import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { agentLabel, getEmployeeLink, useLinkDevices } from './link-devices';

/**
 * The digital employee card wall (prototype v12): one card per employee in the registry with status, duty, owner,
 * the tools it can use and how it is connected. Role design (duties, prompts, team size) stays in the draft review.
 */
export interface WallEmployee { id: string; name: string; duty: string; status: string; owner?: string; source?: string }

const TEXT = {
  en: {
    addRole: 'Add role', suggestRoles: 'Suggest roles', reviewDraft: 'Review the organization draft',
    owner: 'Owner', tools: 'Tools', toolsValue: '{n} tools', connection: 'Connection', manage: 'Manage', manageTools: 'Tools',
    status_online: 'Online', status_busy: 'Busy', status_unconnected: 'Not connected', status_waiting_auth: 'Waiting for authorization', status_paused: 'Paused', status_fault: 'Fault',
    conn_online: 'Managed worker connected', conn_busy: 'Managed worker connected', conn_unconnected: 'No worker connected yet', conn_waiting_auth: 'Worker waiting for authorization',
    conn_paused: 'Worker paused', conn_fault: 'Worker reported a fault', ownerUnknown: 'Not set', fromAnalysis: 'From knowledge analysis', manual: 'Added by hand',
    wallAria: 'Digital employees', count: '{n} employees', nextFlow: 'Next: publish workflows',
    localLink: 'Local agent', manageLink: 'Manage Link', bindLink: 'Bind a computer', unbound: 'Not bound', ambiguous: 'Multiple bindings',
    restricted: 'Blocked by device permissions', offline: 'Device offline', waitingAuth: 'Sign in on the device',
    missingProject: 'Project not found on the device', busy: 'Running a task', ready: 'Ready for tasks',
    status_offline: 'Offline',
    employee: 'Employee', state: 'Status', bindComputer: 'Bind a computer', toolsPage: 'Employee tools', workflowsPage: 'Workflows',
    all: 'All', filterAria: 'Filter by status', noneMatch: 'No employee has this status.',
  },
  zh: {
    addRole: '新增岗位', suggestRoles: '生成岗位建议', reviewDraft: '审阅组织草案',
    owner: '负责人', tools: '可用工具', toolsValue: '{n} 个工具', connection: '连接', manage: '管理', manageTools: '工具',
    status_online: '在线', status_busy: '忙碌', status_unconnected: '未连接', status_waiting_auth: '等待授权', status_paused: '已暂停', status_fault: '故障',
    conn_online: '受管 worker 已连接', conn_busy: '受管 worker 已连接', conn_unconnected: '还没有连接 worker', conn_waiting_auth: 'worker 等待授权',
    conn_paused: 'worker 已暂停', conn_fault: 'worker 报告故障', ownerUnknown: '未设置', fromAnalysis: '来自知识分析', manual: '手动添加',
    wallAria: '数字员工', count: '{n} 名员工', nextFlow: '下一步：发布流程',
    localLink: '本地 Agent', manageLink: '管理 Link', bindLink: '绑定电脑', unbound: '未绑定', ambiguous: '绑定了多个项目',
    restricted: '受设备权限限制', offline: '设备离线', waitingAuth: '等待本地登录',
    missingProject: '设备上找不到项目', busy: '正在执行任务', ready: '可接任务',
    status_offline: '离线',
    employee: '员工', state: '状态', bindComputer: '绑定电脑', toolsPage: '员工工具', workflowsPage: '业务流程',
    all: '全部', filterAria: '按状态筛选', noneMatch: '没有这个状态的员工。',
  },
};
type Key = keyof typeof TEXT.en;

export function EmployeeWall({ employees, hasDraft, onManage }: { employees: WallEmployee[]; viewerId?: string; hasDraft: boolean; onManage?: (employee: WallEmployee) => void }) {
  const t = useT(TEXT);
  const { devices, unavailable } = useLinkDevices();
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(employees.map(async employee => {
      const response = await api<{ stage?: string; state?: string }[]>(`/api/v1/tools/?employeeId=${encodeURIComponent(employee.id)}`).catch(() => null);
      // A placeholder is a capability still missing, not a tool the employee can use.
      return [employee.id, response?.status === 200 && Array.isArray(response.body) ? response.body.filter(tool => tool.stage !== 'placeholder' && tool.state !== 'placeholder').length : -1] as const;
    })).then(entries => { if (!cancelled) setToolCounts(Object.fromEntries(entries.filter(([, n]) => n >= 0))); });
    return () => { cancelled = true; };
  }, [employees]);
  const label = (key: string, fallback: string) => (key in TEXT.en ? t(key as Key) : fallback);
  const tone = (status: string) => status === 'online' ? 'is-good' : status === 'busy' ? 'is-busy'
    : status === 'fault' ? 'is-bad' : status === 'paused' || status === 'waiting_auth' || status === 'offline' ? 'is-warn' : '';
  // Each employee's state as the wall shows it: its own status, refined by its bound computer.
  const rows = employees.map(employee => {
    const link = devices && !unavailable ? getEmployeeLink(devices, employee.id) : null;
    const status = employee.status === 'paused' || employee.status === 'fault' ? employee.status
      : link?.status === 'ready' ? 'online'
      : link?.status === 'busy' ? 'busy'
      : link?.status === 'offline' ? 'offline'
      : link?.status === 'waitingAuth' ? 'waiting_auth' : employee.status;
    return { employee, link, status };
  });
  const counts = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {});
  const shown = only ? rows.filter(row => row.status === only) : rows;
  const initial = (name: string) => {
    const words = name.trim().split(/\s+/);
    return (/^[A-Za-z]/.test(name) && words.length > 1 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, /^[A-Za-z]/.test(name) ? 2 : 1)).toUpperCase();
  };
  return <section className="emp-wall-section" aria-label={t('wallAria')}>
    <div className="emp-wall-bar">
      {/* Status chips with counts, like the command room's filters; one chip is just the count. */}
      {Object.keys(counts).length > 1 ? (
        <div className="chip-row" role="group" aria-label={t('filterAria')}>
          <button type="button" className="chip" aria-pressed={only === null} onClick={() => setOnly(null)}>{t('all')}<span className="chip-n">{employees.length}</span></button>
          {Object.entries(counts).map(([status, n]) => (
            <button key={status} type="button" className="chip" aria-pressed={only === status} onClick={() => setOnly(only === status ? null : status)}>
              {label(`status_${status}`, status)}<span className="chip-n">{n}</span>
            </button>
          ))}
        </div>
      ) : <span className="helper">{t('count', { n: employees.length })}</span>}
      <div className="emp-wall-actions">
        <a className="btn quiet" href="#tools">{t('toolsPage')}</a>
        <a className="btn quiet" href="#brain?tab=sop">{t('workflowsPage')}</a>
        <a className="btn quiet" href="#employees?view=draft&add=1">{t('addRole')}</a>
        <a className="btn quiet" href={hasDraft ? '#employees?view=draft' : '#knowledge?view=analysis'}>{t(hasDraft ? 'reviewDraft' : 'suggestRoles')}</a>
      </div>
    </div>
    {/* A table, not a card wall: one row per employee, the facts in columns, the duty on one line. */}
    <div className="data-table-wrap">
      <table className="data-table emp-table">
        <thead><tr>
          <th scope="col">{t('employee')}</th>
          <th scope="col">{t('state')}</th>
          <th scope="col">{t('localLink')}</th>
          <th scope="col" className="num">{t('tools')}</th>
          <th scope="col"><span className="sr-only">{t('manage')}</span></th>
        </tr></thead>
        <tbody>
          {shown.length === 0 ? <tr><td colSpan={5} className="helper">{t('noneMatch')}</td></tr> : null}
          {shown.map(({ employee, link, status }) => {
            const tools = toolCounts[employee.id];
            return <tr key={employee.id} className="emp-card" data-employee={employee.id}>
              <td>
                <span className="emp-who">
                  <span className={`avatar${status === 'paused' || status === 'unconnected' || status === 'offline' ? ' is-dim' : ''}`} aria-hidden="true">{initial(employee.name)}</span>
                  <span className="emp-who-text">
                    <span className="name">{employee.name}</span>
                    <span className="clip" title={employee.duty}>{employee.duty}</span>
                  </span>
                </span>
              </td>
              <td><span className={`state ${tone(status)}`}>{label(`status_${status}`, status)}</span></td>
              <td>
                {devices === null && !unavailable ? <span className="clip">…</span>
                  : link && link.status !== 'unbound'
                    ? <><span>{link.device?.name ?? t(link.status)}</span><span className="clip">{t(link.status)}{link.project ? `，${agentLabel(link.project.agent)}` : ''}</span></>
                    : <span className="status">{t('unbound')}</span>}
              </td>
              <td className="num" data-label={t('tools')}>{tools === undefined ? '…' : tools + mcpToolCount(link?.device ?? null)}</td>
              <td className="actions">
                {/* Bind or change this employee's computer; shown whenever the device list has loaded. */}
                {link ? <a className="btn quiet" href={`#settings?link=1&employee=${encodeURIComponent(employee.id)}`}>{t(link.status === 'unbound' ? 'bindLink' : 'manageLink')}</a> : null}
                {onManage
                  ? <button type="button" className="btn" onClick={() => onManage(employee)}>{t('manage')}</button>
                  : <a className="btn" href={`#employees?manage=${encodeURIComponent(employee.id)}`}>{t('manage')}</a>}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

/** MCP tools a computer reported for its connected servers (its own permission tool excluded). */
export function mcpToolCount(device: { capabilities: { mcpServers?: { status: string; tools?: string[] }[] } } | null): number {
  return (device?.capabilities.mcpServers ?? []).filter(server => server.status === 'connected').reduce((sum, server) => sum + (server.tools?.length ?? 0), 0);
}
