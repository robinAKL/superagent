import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { restoreConfirmedOrganizations } from '../src/modules/knowledge/runtime.js';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { mergeRecommendations, type Evidence, type KnowledgeState } from '../src/modules/knowledge/domain.js';
import { validateProposals } from '../src/modules/analysis/service.js';
import { EmployeeService } from '../src/modules/employees/employees.js';
import { ToolService } from '../src/modules/tools/lifecycle.js';
import { createOrganizationSink } from '../src/modules/employees/organization.js';
import { employeesState } from '../src/modules/employees/index.js';
import { buildApp } from '../src/app.js';

const owner: UserContext = { tenantId: 'tenant-a', userId: 'alice', roles: ['owner'], projectScopes: ['project-a'] };
const GUIDE = '订单审核指南\n\n1. 收到订单后核对客户信用额度。\n2. 金额超过 5 万需主管审批。\n3. 用知识库问答查找价格政策，核对后在 CRM 中登记。';

function evidence(s: KnowledgeState, needle: string): Evidence {
  const i = s.source.items.find(i => i.current)!, c = s.source.chunks.find(c => c.itemId === i.id && c.text.includes(needle))!;
  return { sourceId: i.id, version: i.version, start: c.start, end: c.end, locator: c.locator, quote: c.text };
}

async function fixture() {
  const repo = new MemoryKnowledgeRepository();
  let employees = new EmployeeService(), tools = new ToolService();
  const sink = createOrganizationSink(() => employees, () => tools);
  const service = new KnowledgeService({ repo, organization: sink });
  const conn = await service.createConnection(owner, { name: '资料', pluginId: 'local-file' });
  await service.confirmConnection(owner, conn.id);
  await service.upload(owner, { connectionId: conn.id, name: 'order-review.md', text: GUIDE });
  const item = (await repo.read(owner)).source.items[0]!;
  await service.confirm(owner, item.id, item.version);
  await repo.transact(owner, s => {
    const e = evidence(s, '信用额度'), p = evidence(s, '知识库问答');
    mergeRecommendations(s, owner, validateProposals([
      { key: 'order-reviewer', kind: 'employee', name: '订单审核员', description: '核对订单信用额度与金额', evidence: [e], uses: ['kb-qa', 'crm-entry'], sops: ['order-review'] },
      { key: 'credit-analyst', kind: 'employee', name: '信用分析员', description: '评估客户信用额度', evidence: [e], uses: ['kb-qa'], sops: [] },
      { key: 'kb-qa', kind: 'tool', name: '知识库问答', description: '查找价格政策', evidence: [p] },
      { key: 'crm-entry', kind: 'tool', name: '订单登记', description: '在内部系统中登记审核结论', evidence: [p] },
      { key: 'order-review', kind: 'sop', name: '订单审核流程', description: '收到订单 → 核对额度 → 超额审批 → 登记', evidence: [e] },
    ]));
  });
  return { repo, service, sink, employees: () => employees, tools: () => tools, restart: () => { employees = new EmployeeService(); tools = new ToolService(); } };
}

describe('organization draft → confirmed team (PRD §3.3)', () => {
  it('shows roles with the tools and SOPs they work with, and tells reusable tools from placeholders', async () => {
    const f = await fixture();
    const org = await f.service.organization(owner);
    expect(org.blocked).toBeNull();
    expect(org.confirmation).toBeNull();
    const reviewer = org.employees.find(e => e.key === 'order-reviewer')!;
    expect(reviewer).toMatchObject({ name: '订单审核员', tools: ['kb-qa', 'crm-entry'], sops: ['order-review'], employeeId: null });
    expect(reviewer.evidence[0]!.locator).toContain('order-review.md');
    expect(reviewer.prompt).toContain('订单审核员');
    expect(org.tools.find(t => t.key === 'kb-qa')).toMatchObject({ match: 'existing', toolId: 'knowledge.search' });
    expect(org.tools.find(t => t.key === 'crm-entry')).toMatchObject({ match: 'placeholder', toolId: null });
    expect(org.sops).toHaveLength(1);
  });

  it('confirming twice creates exactly one team; edits are applied on the next confirmation', async () => {
    const f = await fixture();
    const first = await f.service.confirmOrganization(owner);
    expect(first).toMatchObject({ revision: 1, createdEmployees: 2, createdTools: 1 });
    expect(f.employees().list()).toHaveLength(2);
    expect(f.employees().list().every(e => e.status === 'unconnected')).toBe(true);
    expect(f.tools().list().map(t => t.toolId)).toHaveLength(1);
    expect(f.tools().list()[0]!.contract.confirmed).toBe(false);

    const second = await f.service.confirmOrganization(owner);
    expect(second).toMatchObject({ revision: 2, createdEmployees: 0, createdTools: 0 });
    expect(f.employees().list()).toHaveLength(2);
    expect(f.tools().list()).toHaveLength(1);

    const reviewer = (await f.service.organization(owner)).employees.find(e => e.key === 'order-reviewer')!;
    await f.service.editRecommendation(owner, reviewer.id, { name: '订单审核专员', description: reviewer.duty, prompt: '只审核订单。', assignment: { tools: ['kb-qa', 'missing-key'], sops: ['order-review'] } });
    const edited = await f.service.organization(owner);
    expect(edited.changedSinceConfirmation).toBe(true);
    expect(edited.employees.find(e => e.id === reviewer.id)).toMatchObject({ tools: ['kb-qa'], prompt: '只审核订单。', promptEdited: true });
    await f.service.confirmOrganization(owner);
    const emp = f.employees().get(reviewer.employeeId!);
    expect(emp.name).toBe('订单审核专员');
    expect(f.employees().currentPrompt(emp.id)).toMatchObject({ version: 2, text: '只审核订单。' });
    expect(f.employees().list()).toHaveLength(2);
    expect((await f.service.organization(owner)).changedSinceConfirmation).toBe(false);
  });

  it('merging moves tools and SOPs to the kept role and removes the merged one', async () => {
    const f = await fixture();
    const org = await f.service.organization(owner);
    const keep = org.employees.find(e => e.key === 'credit-analyst')!, drop = org.employees.find(e => e.key === 'order-reviewer')!;
    await f.service.mergeRecommendation(owner, drop.id, { into: keep.id });
    const after = await f.service.organization(owner);
    expect(after.employees.map(e => e.key)).toEqual(['credit-analyst']);
    expect(after.employees[0]).toMatchObject({ tools: ['kb-qa', 'crm-entry'], sops: ['order-review'] });
    await expect(f.service.mergeRecommendation(owner, keep.id, { into: keep.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleting a tool draft drops it from every assignment', async () => {
    const f = await fixture();
    const crm = (await f.service.organization(owner)).tools.find(t => t.key === 'crm-entry')!;
    await f.service.editRecommendation(owner, crm.id, {}, true);
    const after = await f.service.organization(owner);
    expect(after.tools.map(t => t.key)).toEqual(['kb-qa']);
    expect(after.employees.find(e => e.key === 'order-reviewer')!.tools).toEqual(['kb-qa']);
  });

  it('after a restart, reading the organization restores the same employees and placeholders without a new confirmation', async () => {
    const f = await fixture();
    const first = await f.service.confirmOrganization(owner);
    const reviewer = first.employees.find(e => e.name === '订单审核员')!;
    f.restart();
    expect(f.employees().list()).toHaveLength(0);
    const org = await f.service.organization(owner);
    expect(org.missing).toBe(0);
    expect(org.confirmation).toMatchObject({ revision: 1 });
    expect(f.employees().list().map(e => e.id).sort()).toEqual(first.employees.map(e => e.employeeId).sort());
    expect(f.employees().get(reviewer.employeeId)).toMatchObject({ name: '订单审核员', status: 'unconnected', owner: 'alice' });
    expect(f.tools().list().map(t => t.toolId)).toEqual(first.tools.filter(t => t.match === 'placeholder').map(t => t.toolId));
    expect(f.tools().list()[0]!.contract.purpose).toBe('在内部系统中登记审核结论');
    // Confirming again afterwards still creates nothing new.
    expect(await f.service.confirmOrganization(owner)).toMatchObject({ createdEmployees: 0, createdTools: 0 });
  });

  it('a second web process on the same tenant document restores the team at start-up', async () => {
    const f = await fixture();
    const first = await f.service.confirmOrganization(owner);
    const employeesB = new EmployeeService(), toolsB = new ToolService();
    const processB = new KnowledgeService({ repo: f.repo, organization: createOrganizationSink(() => employeesB, () => toolsB) });
    expect(await processB.restoreOrganizations([owner.tenantId, 'tenant-without-organization'])).toBe(3);
    expect(employeesB.list().map(e => e.id).sort()).toEqual(first.employees.map(e => e.employeeId).sort());
    expect(toolsB.list()).toHaveLength(1);
    expect(await processB.restoreOrganizations([owner.tenantId])).toBe(0);
  });

  it('refreshes the employee list and command room on a replica that cached the former team', async () => {
    const f = await fixture();
    const first = await f.service.confirmOrganization(owner);
    const cached = new EmployeeService(), toolsB = new ToolService();
    const deps = { repo: f.repo, organization: createOrganizationSink(() => cached, () => toolsB) };
    const replica = new KnowledgeService(deps);
    await replica.refreshConfirmedTeam(owner.tenantId);
    expect(cached.list()).toHaveLength(2);
    cached.ensure({ id: 'emp-org-other-tenant', name: 'Other tenant', duty: 'Independent', prompt: 'Independent', owner: 'bob', source: 'manual' });

    const reduced = await f.service.resizeTeam(owner, { count: 1 });
    const [employee] = reduced.employees;
    expect(cached.list()).toHaveLength(3);
    const oldRegistry = employeesState.of(owner.tenantId);
    employeesState.set(owner.tenantId, cached);
    const app = await buildApp({ auth: { mode: 'dev', platformTenantId: owner.tenantId }, knowledgeDeps: deps });
    const headers = { 'x-dev-user': 'alice|owner|project-a' };
    try {
      const wall = await app.inject({ method: 'GET', url: '/api/v1/employees/', headers });
      expect(wall.statusCode).toBe(200);
      expect(wall.json()).toContainEqual(expect.objectContaining({ id: employee!.employeeId }));
      expect(wall.json()).not.toContainEqual(expect.objectContaining({ id: first.employees[0]!.employeeId }));
      expect(cached.has('emp-org-other-tenant')).toBe(true);

      // A command-room-only visit to another stale replica must also reconcile.
      const removed = first.employees[0]!;
      cached.ensure({ id: removed.employeeId, name: removed.name, duty: removed.duty, prompt: removed.prompt, owner: owner.userId, source: 'recommended' });
      const room = await app.inject({ method: 'GET', url: '/api/v1/room/roster', headers });
      expect(room.statusCode).toBe(200);
      expect(room.json().employees).toContainEqual(expect.objectContaining({ id: employee!.employeeId }));
      expect(room.json().employees).not.toContainEqual(expect.objectContaining({ id: removed.employeeId }));

      cached.ensure({ id: removed.employeeId, name: removed.name, duty: removed.duty, prompt: removed.prompt, owner: owner.userId, source: 'recommended' });
      const retry = await app.inject({ method: 'POST', url: '/api/v1/knowledge/organization/resize', headers, payload: { count: 1 } });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ revision: reduced.revision, employees: reduced.employees, createdEmployees: 0 });
      expect(cached.has(removed.employeeId)).toBe(false);
      expect(await replica.resolveWorkflowTeam(owner.tenantId)).toEqual(Object.fromEntries(first.employees.map(e => [e.employeeId, employee!.employeeId])));
    } finally {
      await app.close();
      employeesState.set(owner.tenantId, oldRegistry);
    }
  });

  it('refuses confirmation while the latest analysis is stale, and for non-managers', async () => {
    const f = await fixture();
    await f.repo.transact(owner, s => { s.analyses.push({ id: 'run-1', actor: owner, status: 'stale', stage: 'recommend', signature: 'x', createdAt: new Date().toISOString(), error: null }); });
    expect((await f.service.organization(owner)).blocked).toBe('analysis_stale');
    await expect(f.service.confirmOrganization(owner)).rejects.toMatchObject({ code: 'analysis_stale', statusCode: 409 });
    await expect(f.service.confirmOrganization({ ...owner, roles: ['employee'] })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.employees().list()).toHaveLength(0);
  });
});

const dbUrl = process.env.DATABASE_URL;
(dbUrl ? describe : describe.skip)('organization on PostgreSQL: web process switch', () => {
  it('process B, sharing the PG tenant document, restores process A\'s confirmed team at start-up and on read', async () => {
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await migrate(pool, undefined, () => undefined);
      await pool.query(await readFile(new URL('../migrations/0002_knowledge.sql', import.meta.url), 'utf8'));
      const ctx = { ...owner, tenantId: randomUUID() };
      const employeesA = new EmployeeService(), toolsA = new ToolService();
      const depsA = { repo: new PgKnowledgeRepository(pool), organization: createOrganizationSink(() => employeesA, () => toolsA) };
      const a = new KnowledgeService(depsA);
      const conn = await a.createConnection(ctx, { name: '资料', pluginId: 'local-file' });
      await a.confirmConnection(ctx, conn.id);
      await a.upload(ctx, { connectionId: conn.id, name: 'order-review.md', text: GUIDE });
      const item = (await depsA.repo.read(ctx)).source.items[0]!;
      await a.confirm(ctx, item.id, item.version);
      await depsA.repo.transact(ctx, s => { mergeRecommendations(s, ctx, validateProposals([
        { key: 'order-reviewer', kind: 'employee', name: '订单审核员', description: '核对订单', evidence: [evidence(s, '信用额度')], uses: ['crm-entry'], sops: [] },
        { key: 'crm-entry', kind: 'tool', name: '订单登记', description: '登记审核结论', evidence: [evidence(s, '知识库问答')] },
      ])); });
      const confirmed = await a.confirmOrganization(ctx);

      const employeesB = new EmployeeService(), toolsB = new ToolService();
      const depsB = { repo: new PgKnowledgeRepository(pool), organization: createOrganizationSink(() => employeesB, () => toolsB) };
      expect(await restoreConfirmedOrganizations(depsB)).toBeGreaterThanOrEqual(2);
      expect(employeesB.get(confirmed.employees[0]!.employeeId)).toMatchObject({ name: '订单审核员', status: 'unconnected' });
      expect(toolsB.list().map(t => t.toolId)).toContain(confirmed.tools[0]!.toolId);

      const employeesC = new EmployeeService(), toolsC = new ToolService();
      const c = new KnowledgeService({ repo: new PgKnowledgeRepository(pool), organization: createOrganizationSink(() => employeesC, () => toolsC) });
      expect((await c.organization(ctx)).missing).toBe(0);
      expect(employeesC.list().map(e => e.id)).toEqual([confirmed.employees[0]!.employeeId]);
      await pool.query('DELETE FROM knowledge_chunks WHERE tenant_id=$1', [ctx.tenantId]); await pool.query('DELETE FROM knowledge_tenants WHERE tenant_id=$1', [ctx.tenantId]);
    } finally { await pool.end(); }
  });
});
