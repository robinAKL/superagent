import { expect, it } from 'vitest';
import { mcpNeeds } from './McpSignIn';
import type { LinkDevice } from './link-devices';

it('lists only connections needing sign-in on computers bound to the employees in view', () => {
  const devices = [
    { id: 'w1', name: 'WIN-RLDG3T479VI', kind: 'link', capabilities: { roomAssignments: [{ projectId: 'p', employeeId: 'emp-wo' }],
      mcpServers: [{ name: 'vera-crm', status: 'needs_auth' }, { name: 'gmail', status: 'connected' }, { name: 'drive', status: 'failed' }] } },
    { id: 'w2', name: 'BOSSCLAW', kind: 'link', capabilities: { mcpServers: [{ name: 'notion', status: 'needs_auth' }] } },
  ] as unknown as LinkDevice[];
  expect(mcpNeeds(devices)).toEqual([{ deviceId: 'w1', device: 'WIN-RLDG3T479VI', server: 'vera-crm' }]);
  expect(mcpNeeds(devices, new Set(['emp-other']))).toEqual([]);
});
