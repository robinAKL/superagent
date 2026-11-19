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
    localLink: 'Local agent', manageLink: 'Manage Link', unbound: 'Not bound', ambiguous: 'Multiple bindings',
    restricted: 'Blocked by device permissions', offline: 'Bound · device offline', waitingAuth: 'Bound · sign in on device',
    missingProject: 'Bound · project unverified', busy: 'Bound · running a task', ready: 'Bound · ready for tasks',
    status_offline: 'Offline',
  },
  zh: {
    addRole: '新增岗位', suggestRoles: '生成岗位建议', reviewDraft: '审阅组织草案',
    owner: '负责人', tools: '可用工具', toolsValue: '{n} 个工具', connection: '连接', manage: '管理', manageTools: '工具',
    status_online: '在线', status_busy: '忙碌', status_unconnected: '未连接', status_waiting_auth: '等待授权', status_paused: '已暂停', status_fault: '故障',
    conn_online: '受管 worker 已连接', conn_busy: '受管 worker 已连接', conn_unconnected: '还没有连接 worker', conn_waiting_auth: 'worker 等待授权',
    conn_paused: 'worker 已暂停', conn_fault: 'worker 报告故障', ownerUnknown: '未设置', fromAnalysis: '来自知识分析', manual: '手动添加',
    wallAria: '数字员工', count: '{n} 名员工', nextFlow: '下一步：发布流程',
    localLink: '本地 Agent', manageLink: '管理 Link', unbound: '未绑定', ambiguous: '绑定了多个项目',
    restricted: '受设备权限限制', offline: '已绑定 · 设备离线', waitingAuth: '已绑定 · 等待本地登录',
    missingProject: '已绑定 · 项目待验证', busy: '已绑定 · 正在执行', ready: '已绑定 · 可接任务',
    status_offline: '离线',
  },
};
type Key = keyof typeof TEXT.en;

export function EmployeeWall({ employees, viewerId, hasDraft, onManage }: { employees: WallEmployee[]; viewerId?: string; hasDraft: boolean; onManage?: (employee: WallEmployee) => void }) {
  const t = useT(TEXT);
  const { devices, unavailable } = useLinkDevices();
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(employees.map(async employee => {
      const response = await api<unknown[]>(`/api/v1/tools/?employeeId=${encodeURIComponent(employee.id)}`).catch(() => null);
      return [employee.id, response?.status === 200 && Array.isArray(response.body) ? response.body.length : -1] as const;
    })).then(entries => { if (!cancelled) setToolCounts(Object.fromEntries(entries.filter(([, n]) => n >= 0))); });
    return () => { cancelled = true; };
  }, [employees]);
  const label = (key: string, fallback: string) => (key in TEXT.en ? t(key as Key) : fallback);
  return <section className="emp-wall-section" aria-label={t('wallAria')}>
    <div className="emp-wall-bar">
      <span className="helper">{t('count', { n: employees.length })}</span>
      <div className="emp-wall-actions">
        <a className="btn" href="#employees?view=draft&add=1">{t('addRole')}</a>
        <a className="btn" href={hasDraft ? '#employees?view=draft' : '#knowledge?view=analysis'}>{t(hasDraft ? 'reviewDraft' : 'suggestRoles')}</a>
      </div>
    </div>
    <ul className="emp-wall">
      {employees.map(employee => {
        const owner = !employee.owner ? t('ownerUnknown') : employee.owner === viewerId ? `${employee.owner}` : employee.owner;
        const tools = toolCounts[employee.id];
        const link = devices && !unavailable ? getEmployeeLink(devices, employee.id) : null;
        const status = employee.status === 'paused' || employee.status === 'fault' ? employee.status
          : link?.status === 'ready' ? 'online'
          : link?.status === 'busy' ? 'busy'
          : link?.status === 'offline' ? 'offline'
          : link?.status === 'waitingAuth' ? 'waiting_auth' : employee.status;
        return <li key={employee.id} className="emp-card" data-employee={employee.id}>
          <div className="emp-card-head">
            <span className="emp-avatar" aria-hidden="true">{Array.from(employee.name)[0] ?? '?'}</span>
            <span className={`emp-status is-${status}`}>{label(`status_${status}`, status)}</span>
          </div>
          <h3>{employee.name}</h3>
          <p className="emp-duty">{employee.duty}</p>
          <dl className="emp-facts">
            <div><dt>{t('owner')}</dt><dd>{owner}</dd></div>
            <div><dt>{t('tools')}</dt><dd>{tools === undefined ? '…' : t('toolsValue', { n: tools })}</dd></div>
            {link ? <div><dt>{t('localLink')}</dt><dd>
              {t(link.status)}
              {link.device ? <small className="emp-link-device">{link.device.name}{link.project ? ` · ${agentLabel(link.project.agent)}` : ''}</small> : null}
            </dd></div> : <div><dt>{t('connection')}</dt><dd>{label(`conn_${employee.status}`, employee.status)}</dd></div>}
          </dl>
          <div className="emp-card-foot">
            <small>{t(employee.source === 'manual' ? 'manual' : 'fromAnalysis')}</small>
            <span className="emp-card-links">
              {link ? <a href={`#settings?link=1&employee=${encodeURIComponent(employee.id)}`}>{t('manageLink')}</a> : null}
              <a href={`#tools?employee=${encodeURIComponent(employee.id)}`}>{t('manageTools')}</a>
              {onManage
                ? <button type="button" className="btn" onClick={() => onManage(employee)}>{t('manage')}</button>
                : <a className="btn" href={`#employees?manage=${encodeURIComponent(employee.id)}`}>{t('manage')}</a>}
            </span>
          </div>
        </li>;
      })}
    </ul>
  </section>;
}
