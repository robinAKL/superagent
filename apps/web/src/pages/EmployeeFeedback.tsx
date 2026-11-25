import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLang, useT } from '../i18n';
import { useLinkDevices, type LinkDevice } from './link-devices';
import type { WallEmployee } from './EmployeeWall';
import { mentionsEmployee } from './EmployeeManage';

interface WorkItem { id: string; kind: string; status: string; payload: Record<string, unknown> }
interface ToolRow { toolId: string; name: string; stage: string; state: string }

const TEXT = {
  en: {
    title: 'Employee feedback and capability requests ({n})',
    empty: 'No employee feedback or missing-capability requests yet. This list is the inbox items that name a digital employee, plus tool placeholders that still need a capability.',
    feedback: 'Feedback', capability: 'Capability request', placeholder: 'Placeholder: {name}',
    openInbox: 'Open My work',
    waiting: '{n} capabilities are waiting to be connected ({m} requests, duplicates merged)',
    requests: '{n} requests',
    provided: '{n} capabilities are already provided by MCP on the employee’s computer (no action needed)',
    providedBy: 'Provided by {server} on {device}',
  },
  zh: {
    title: '员工反馈与能力申请（{n}）',
    empty: '还没有员工反馈或能力申请。这里只列出点名了数字员工的待办，以及仍缺能力的工具占位，不会编造。',
    feedback: '反馈', capability: '能力申请', placeholder: '占位：{name}',
    openInbox: '打开待我处理',
    waiting: '还有 {n} 项能力等待接入（共 {m} 条申请，已合并重复）',
    requests: '{n} 条申请',
    provided: '{n} 项能力已由员工电脑上的 MCP 提供（不用处理）',
    providedBy: '已由 {device} 上的 {server} 提供',
  },
};

export function EmployeeFeedback({ employees }: { employees: WallEmployee[] }) {
  const t = useT(TEXT);
  const [lang] = useLang();
  const { devices } = useLinkDevices();
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

  const all = groupCapabilities(placeholders);
  const sources = mcpSources(devices ?? [], ids);
  const withProvider = all.map(group => ({ ...group, provider: providerOf(group, sources) }));
  const groups = withProvider.filter(group => !group.provider);
  const provided = withProvider.filter(group => group.provider);
  // What still needs someone: feedback, and capabilities nothing provides (each counted once).
  const n = (items?.length ?? 0) + groups.length;
  const waitingRequests = groups.reduce((sum, group) => sum + group.count, 0);
  const nameCell = (group: { name: string; systems: string[] }) => {
    const zh = lang === 'zh' ? capabilityLabel(group.name) : null;
    return <td>{zh ? <><span className="name">{zh}</span><span className="clip">{group.name}{group.systems.length ? ` · ${group.systems.join('，')}` : ''}</span></>
      : <><span className="name">{group.name}</span>{group.systems.length ? <span className="clip">{group.systems.join('，')}</span> : null}</>}</td>;
  };
  return <section className="emp-feedback" aria-labelledby="emp-feedback-title">
    <h2 id="emp-feedback-title">{t('title', { n })}</h2>
    {items === null ? <p className="helper">…</p> : n === 0 && !provided.length ? <p className="helper" role="status">{t('empty')}</p> : <>
      {items?.length ? <ul className="emp-feedback-list">
        {items.map(item => <li key={item.id}><span>{t('feedback')}</span> {String(item.payload.title ?? item.kind)}</li>)}
      </ul> : null}
      {groups.length ? <details className="disclosure">
        <summary>{t('waiting', { n: groups.length, m: waitingRequests })}</summary>
        <div className="data-table-wrap">
          <table className="data-table">
            <tbody>{groups.map(group => <tr key={group.name}>
              {nameCell(group)}
              <td className="num">{t('requests', { n: group.count })}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details> : null}
      {provided.length ? <details className="disclosure" data-provided>
        <summary>{t('provided', { n: provided.length })}</summary>
        <div className="data-table-wrap">
          <table className="data-table">
            <tbody>{provided.map(group => <tr key={group.name}>
              {nameCell(group)}
              <td className="num">{t('providedBy', { server: group.provider!.server, device: group.provider!.device })}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details> : null}
      {items?.length ? <a href="#work">{t('openInbox')}</a> : null}
    </>}
  </section>;
}

/**
 * Analysis names the same missing capability several ways ("approve_order (CRM)", "approve_order (CRM action)").
 * Group by the name before the bracket; the bracketed systems become a note. Most-requested first.
 */
export function groupCapabilities(tools: readonly { name: string }[]): { name: string; count: number; systems: string[] }[] {
  const groups = new Map<string, { name: string; count: number; systems: Set<string> }>();
  for (const tool of tools) {
    const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(tool.name.trim());
    const name = (match ? match[1]! : tool.name).trim() || tool.name;
    const system = match?.[2]?.replace(/\s+(action|actions)$/i, '').trim();
    const group = groups.get(name) ?? { name, count: 0, systems: new Set<string>() };
    group.count++;
    if (system) group.systems.add(system);
    groups.set(name, group);
  }
  return [...groups.values()].map(group => ({ name: group.name, count: group.count, systems: [...group.systems] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The MCP servers connected on these employees' computers, with the tools their tasks have already used there. */
export interface McpSource { server: string; device: string; used: Set<string>; tools: string[] | null }

export function mcpSources(devices: readonly LinkDevice[], employees: ReadonlySet<string>): McpSource[] {
  const result: McpSource[] = [];
  for (const device of devices) {
    if (!(device.capabilities.roomAssignments ?? []).some(assignment => employees.has(assignment.employeeId))) continue;
    const used = new Set(Object.entries(device.capabilities.permissions ?? {}).filter(([id]) => employees.has(id)).flatMap(([, policy]) => policy.seen ?? []));
    for (const server of device.capabilities.mcpServers ?? []) {
      if (server.status === 'connected') result.push({ server: server.name, device: device.name, used, tools: server.tools ?? null });
    }
  }
  return result;
}

/**
 * Which connected MCP server provides a requested capability. A server whose tool list the computer reported is
 * matched by tool name only. Without a list: a tool of that name a task already used there, or else a server named
 * for the capability's system ("CRM" -> "vera-crm").
 */
export function providerOf(group: { name: string; systems: string[] }, sources: readonly McpSource[]): { server: string; device: string } | null {
  const tool = group.name.trim().toLowerCase();
  const listed = sources.find(source => source.tools?.some(name => name.toLowerCase() === tool));
  if (listed) return { server: listed.server, device: listed.device };
  const used = sources.find(source => [...source.used].some(name => name.toLowerCase() === `mcp__${source.server.toLowerCase()}__${tool}`));
  if (used) return { server: used.server, device: used.device };
  const named = sources.find(source => !source.tools && group.systems.some(system => system.trim().length >= 2 && source.server.toLowerCase().includes(system.trim().toLowerCase())));
  return named ? { server: named.server, device: named.device } : null;
}

const WORDS: Record<string, string> = {
  approve: '审批', mark: '标记', record: '登记', assign: '指定', create: '创建', update: '更新', get: '查询', list: '列出', search: '搜索',
  export: '导出', send: '发送', cancel: '取消', close: '关闭', confirm: '确认', check: '核对', calculate: '计算', delete: '删除', add: '添加',
  order: '订单', orders: '订单', deposit: '订金', shipment: '货运', shipments: '货运', arrival: '到货', supplier: '供应商', suppliers: '供应商',
  invoice: '发票', invoices: '发票', balance: '尾款', customer: '客户', customers: '客户', payment: '付款', fulfilment: '交付', fulfillment: '交付',
  eta: '预计到达', lead: '交期', time: '时间', pricing: '定价', price: '价格', quote: '报价', template: '模板', rebate: '返利', status: '状态',
  in: '', transit: '在途', knowledge: '知识', guide: '指南', crm: 'CRM', draft: '草稿', drafts: '草稿', receipt: '收款', receipts: '收款',
};
const VERBS = new Set(['approve', 'mark', 'record', 'assign', 'create', 'update', 'get', 'list', 'search', 'export', 'send', 'cancel', 'close', 'confirm', 'check', 'calculate', 'delete', 'add']);

/** "approve_order" -> "审批订单", "mark_orders_in_transit" -> "标记订单在途". Null when a word is not known. */
export function capabilityLabel(name: string): string | null {
  const words = name.trim().toLowerCase().split(/[_\s-]+/).filter(Boolean);
  if (!words.length || words.some(word => !(word in WORDS))) return null;
  const [first, ...rest] = words;
  if (VERBS.has(first!)) return WORDS[first!] + rest.map(word => WORDS[word]).join('');
  return words.map(word => WORDS[word]).join('');
}
