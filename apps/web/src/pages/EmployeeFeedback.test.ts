import { describe, expect, it } from 'vitest';
import { capabilityLabel, groupCapabilities, mcpSources, providerOf } from './EmployeeFeedback';
import type { LinkDevice } from './link-devices';

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
});
