import { useT } from '../i18n';

/**
 * The digital employee card wall (prototype v12): one card per employee in the registry with status, duty, owner,
 * the tools it can use and how it is connected. Role design (duties, prompts, team size) stays in the draft review.
 */
export interface WallEmployee {
  id: string; name: string; duty: string; status: string; owner?: string; source?: string;
  ownerIsViewer?: boolean; ownerDisplayName?: string | null; toolCount?: number;
}

const TEXT = {
  en: {
    addRole: 'Add role', suggestRoles: 'Suggest roles', reviewDraft: 'Review the organization draft',
    owner: 'Owner', tools: 'Tools', toolsValue: '{n} tools', oneTool: '1 tool', connection: 'Connection', manage: 'Manage', manageTools: 'Tools',
    status_online: 'Online', status_busy: 'Busy', status_unconnected: 'Not connected', status_waiting_auth: 'Waiting for authorization', status_paused: 'Paused', status_fault: 'Fault',
    conn_online: 'Managed worker connected', conn_busy: 'Managed worker connected', conn_unconnected: 'No worker connected yet', conn_waiting_auth: 'Worker waiting for authorization',
    conn_paused: 'Worker paused', conn_fault: 'Worker reported a fault', ownerUnknown: 'Not set', ownerYou: 'You', fromAnalysis: 'From knowledge analysis', manual: 'Added by hand',
    wallAria: 'Digital employees', count: '{n} employees', nextFlow: 'Next: publish workflows',
  },
  zh: {
    addRole: '新增岗位', suggestRoles: '生成岗位建议', reviewDraft: '审阅组织草案',
    owner: '负责人', tools: '可用工具', toolsValue: '{n} 个工具', oneTool: '1 个工具', connection: '连接', manage: '管理', manageTools: '工具',
    status_online: '在线', status_busy: '忙碌', status_unconnected: '未连接', status_waiting_auth: '等待授权', status_paused: '已暂停', status_fault: '故障',
    conn_online: '受管 worker 已连接', conn_busy: '受管 worker 已连接', conn_unconnected: '还没有连接 worker', conn_waiting_auth: 'worker 等待授权',
    conn_paused: 'worker 已暂停', conn_fault: 'worker 报告故障', ownerUnknown: '未设置', ownerYou: '你', fromAnalysis: '来自知识分析', manual: '手动添加',
    wallAria: '数字员工', count: '{n} 名员工', nextFlow: '下一步：发布流程',
  },
};
type Key = keyof typeof TEXT.en;

export function EmployeeWall({ employees, hasDraft, onManage }: { employees: WallEmployee[]; hasDraft: boolean; onManage?: (employee: WallEmployee) => void }) {
  const t = useT(TEXT);
  const label = (key: string, fallback: string) => (key in TEXT.en ? t(key as Key) : fallback);
  return <section className="emp-wall-section" aria-label={t('wallAria')}>
    <div className="emp-wall-bar">
      <span className="helper">{t('count', { n: employees.length })}</span>
      <div className="emp-wall-actions">
        <a className="btn" href="#employees?view=draft&add=1">{t('addRole')}</a>
        <a className="btn primary" href={hasDraft ? '#employees?view=draft' : '#knowledge?view=analysis'}>{t('suggestRoles')}</a>
      </div>
    </div>
    <ul className="emp-wall">
      {employees.map(employee => {
        const owner = employee.ownerIsViewer ? t('ownerYou') : employee.ownerDisplayName || t('ownerUnknown');
        return <li key={employee.id} className="emp-card" data-employee={employee.id}>
          <div className="emp-card-head">
            <span className="emp-avatar" aria-hidden="true">{Array.from(employee.name)[0] ?? '?'}</span>
            <span className={`emp-status is-${employee.status}`}>{label(`status_${employee.status}`, employee.status)}</span>
          </div>
          <h3>{employee.name}</h3>
          <p className="emp-duty">{employee.duty}</p>
          <dl className="emp-facts">
            <div><dt>{t('owner')}</dt><dd>{owner}</dd></div>
            <div><dt>{t('tools')}</dt><dd>{t(employee.toolCount === 1 ? 'oneTool' : 'toolsValue', { n: employee.toolCount ?? 0 })}</dd></div>
            <div><dt>{t('connection')}</dt><dd>{label(`conn_${employee.status}`, employee.status)}</dd></div>
          </dl>
          <div className="emp-card-foot">
            <small>{t(employee.source === 'manual' ? 'manual' : 'fromAnalysis')}</small>
            <span className="emp-card-links">
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
