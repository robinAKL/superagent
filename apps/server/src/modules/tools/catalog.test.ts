import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { EmployeeService } from '../employees/employees.js';
import { employeesState } from '../employees/index.js';
import { ToolService } from './lifecycle.js';
import { toolsState } from './index.js';

const DEV_OWNER = { 'x-dev-user': 'dev-owner|owner|' };

describe('preset tool catalog', () => {
  beforeEach(() => {
    toolsState.current = new ToolService();
    employeesState.current = new EmployeeService();
  });

  it('lists preset tools in a fresh environment with accurate installable vs coming_soon status', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/tools/catalog', headers: DEV_OWNER });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tools: { toolId: string; installable: boolean; status: string; capability: string | null }[] };
    expect(body.tools.length).toBeGreaterThanOrEqual(5);

    const search = body.tools.find((t) => t.toolId === 'knowledge.search');
    expect(search).toBeDefined();
    expect(search?.installable).toBe(true);
    expect(search?.status).toBe('available');
    expect(search?.capability).toBeTruthy();

    const sendMail = body.tools.find((t) => t.toolId === 'mail.send');
    expect(sendMail).toBeDefined();
    expect(sendMail?.installable).toBe(false);
    expect(sendMail?.status).toBe('coming_soon');
    expect(sendMail?.capability).toBeNull();
  });

  it('rejects installing coming_soon tools, missing employeeId, or unknown employeeId', async () => {
    const app = await buildApp();

    const soonRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tools/catalog/mail.send/install',
      headers: DEV_OWNER,
      payload: { employeeId: 'emp-1' },
    });
    expect(soonRes.statusCode).toBe(409);

    const missingEmp = await app.inject({
      method: 'POST',
      url: '/api/v1/tools/catalog/knowledge.search/install',
      headers: DEV_OWNER,
      payload: {},
    });
    expect(missingEmp.statusCode).toBe(400);

    const unknownEmp = await app.inject({
      method: 'POST',
      url: '/api/v1/tools/catalog/knowledge.search/install',
      headers: DEV_OWNER,
      payload: { employeeId: 'does-not-exist' },
    });
    expect(unknownEmp.statusCode).toBe(404);
  });

  it('installs a preset tool onto an employee and makes it callable and visible under that employee', async () => {
    const app = await buildApp();
    const emp = employeesState.current.create({
      name: 'Support Agent',
      duty: 'Answer customer questions',
      prompt: 'Use knowledge base',
      owner: 'dev-owner',
    });

    const installRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tools/catalog/knowledge.search/install',
      headers: DEV_OWNER,
      payload: { employeeId: emp.id },
    });
    expect(installRes.statusCode).toBe(200);
    const installedBody = installRes.json() as { installed: boolean; tool: { status: string; installedEmployees: string[] } };
    expect(installedBody.installed).toBe(true);
    expect(installedBody.tool.status).toBe('installed');
    expect(installedBody.tool.installedEmployees).toContain(emp.id);

    const catalogForEmp = await app.inject({
      method: 'GET',
      url: `/api/v1/tools/catalog?employeeId=${encodeURIComponent(emp.id)}`,
      headers: DEV_OWNER,
    });
    const tools = (catalogForEmp.json() as { tools: { toolId: string; status: string }[] }).tools;
    expect(tools.find((t) => t.toolId === 'knowledge.search')?.status).toBe('installed');

    const toolsList = await app.inject({
      method: 'GET',
      url: `/api/v1/tools/?employeeId=${encodeURIComponent(emp.id)}`,
      headers: DEV_OWNER,
    });
    expect(toolsList.statusCode).toBe(200);
    const listBody = toolsList.json() as { toolId: string; stage: string }[];
    expect(listBody.find((t) => t.toolId === 'knowledge.search')?.stage).toBe('available');
    expect(toolsState.current.callable(emp.id).some((c) => c.toolId === 'knowledge.search')).toBe(true);
  });

  it('lists tenant-scoped owner display names and counts each employee’s assigned tools once', async () => {
    const app = await buildApp({
      async employeeOwnerNames(tenantId, ownerIds) {
        expect(tenantId).toBe('default');
        expect(ownerIds).toEqual(['known-owner', 'unknown-owner']);
        return new Map([['known-owner', 'Actual Owner']]);
      },
    });
    const self = employeesState.current.create({ name: 'Me', duty: 'Audit', prompt: 'Audit', owner: 'dev-owner' });
    const other = employeesState.current.create({ name: 'Other', duty: 'Review', prompt: 'Review', owner: 'known-owner' });
    const unknown = employeesState.current.create({ name: 'Unknown', duty: 'Help', prompt: 'Help', owner: 'unknown-owner' });
    const created = await app.inject({
      method: 'POST', url: '/api/v1/tools/', headers: DEV_OWNER,
      payload: {
        name: 'Assigned to other only', consumers: [other.id, other.id], acceptanceCases: [],
        contract: { toolId: 'custom.assignment', action: 'Review', purpose: 'Review', effect: 'read' },
      },
    });
    expect(created.statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/api/v1/tools/catalog/knowledge.search/install', headers: DEV_OWNER,
      payload: { employeeId: self.id },
    })).statusCode).toBe(200);
    const response = await app.inject({ url: '/api/v1/employees/', headers: DEV_OWNER });
    expect(response.json()).toMatchObject([
      { id: self.id, ownerIsViewer: true, ownerDisplayName: null, toolCount: 1 },
      { id: other.id, ownerIsViewer: false, ownerDisplayName: 'Actual Owner', toolCount: 1 },
      { id: unknown.id, ownerIsViewer: false, ownerDisplayName: null, toolCount: 0 },
    ]);
  });
});
