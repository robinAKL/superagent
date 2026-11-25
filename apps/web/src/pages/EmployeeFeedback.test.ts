import { describe, expect, it } from 'vitest';
import { capabilityLabel, groupCapabilities, mcpSources, providerOf } from './EmployeeFeedback';
import type { LinkDevice } from './link-devices';
import { mcpToolCount } from './EmployeeWall';

const device = (over: Partial<LinkDevice['capabilities']> = {}): LinkDevice => ({
  id: 'w1', name: 'WIN-RLDG3T479VI', kind: 'link',
  capabilities: { roomAssignments: [{ projectId: 'p', employeeId: 'emp-wo' }], mcpServers: [{ name: 'vera-crm', status: 'connected' }, { name: 'gmail', status: 'needs_auth' }], ...over },
} as unknown as LinkDevice);

describe('employee capability requests', () => {
  it('names CRM tools in Chinese and keeps unknown names as they are', () => {
    expect(capabilityLabel('approve_order')).toBe('审批订单');
    expect(capabilityLabel('mark_orders_in_transit')).toBe('标记订单在途');
    expect(capabilityLabel('record_order_deposit')).toBe('登记订单订金');
    expect(capabilityLabel('record_shipment_arrival')).toBe('登记货运到货');
    expect(capabilityLabel('assign_order_supplier')).toBe('指定订单供应商');
    expect(capabilityLabel('frobnicate_widget')).toBeNull();
  });

  it('a capability is provided by a connected MCP server on the employee’s computer: a tool it used, or the system it names', () => {
    const groups = groupCapabilities([{ name: 'approve_order (CRM)' }, { name: 'approve_order (CRM action)' }, { name: 'send_newsletter (Mailchimp)' }]);
    const sources = mcpSources([device()], new Set(['emp-wo']));
    expect(sources.map((source) => source.server)).toEqual(['vera-crm']); // gmail is not signed in
    expect(providerOf(groups.find((g) => g.name === 'approve_order')!, sources)).toEqual({ server: 'vera-crm', device: 'WIN-RLDG3T479VI' });
    expect(providerOf(groups.find((g) => g.name === 'send_newsletter')!, sources)).toBeNull();

    const used = mcpSources([device({ mcpServers: [{ name: 'orders', status: 'connected' }], permissions: { 'emp-wo': { mode: 'standard', seen: ['mcp__orders__approve_order'] } } })], new Set(['emp-wo']));
    expect(providerOf({ name: 'approve_order', systems: [] }, used)).toEqual({ server: 'orders', device: 'WIN-RLDG3T479VI' });
    // Another employee's computer provides nothing here.
    expect(mcpSources([device()], new Set(['emp-other']))).toEqual([]);
  });

  it('with the tool list the computer reported, only listed tools count as provided; no guessing from the system name', () => {
    const sources = mcpSources([device({ mcpServers: [{ name: 'vera-crm', status: 'connected', tools: ['list_invoices', 'approve_order'] }] })], new Set(['emp-wo']));
    expect(providerOf({ name: 'list_invoices', systems: ['CRM/finance'] }, sources)).toEqual({ server: 'vera-crm', device: 'WIN-RLDG3T479VI' });
    expect(providerOf({ name: 'create_balance_draft', systems: ['CRM finance'] }, sources)).toBeNull();
    expect(mcpToolCount(device({ mcpServers: [{ name: 'vera-crm', status: 'connected', tools: ['a', 'b'] }, { name: 'gmail', status: 'needs_auth', tools: ['c'] }] }))).toBe(2);
  });
});

describe('a provider that is not signed in', () => {
  it('a capability its server would provide, while that server needs signing in on the computer, is named as such', () => {
    const d = { id: 'w1', name: 'WIN-RLDG3T479VI', kind: 'link', capabilities: { roomAssignments: [{ projectId: 'p', employeeId: 'emp-wo' }], mcpServers: [{ name: 'vera-crm', status: 'needs_auth' }] } } as unknown as LinkDevice;
    const connected = mcpSources([d], new Set(['emp-wo']));
    const any = mcpSources([d], new Set(['emp-wo']), true).filter((s) => s.status !== 'connected');
    const group = { name: 'approve_order', systems: ['CRM'] };
    expect(providerOf(group, connected)).toBeNull();
    expect(providerOf(group, any)).toEqual({ server: 'vera-crm', device: 'WIN-RLDG3T479VI' });
  });
});
