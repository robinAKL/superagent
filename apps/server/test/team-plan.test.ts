import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { mergeRecommendations, type Evidence, type KnowledgeState } from '../src/modules/knowledge/domain.js';
import { mergeByOverlap, validateTeamPlan, TeamPlanError, type PlanSourceRole } from '../src/modules/knowledge/team-plan.js';
import { validateProposals, type AnalysisModel } from '../src/modules/analysis/service.js';
import { EmployeeService } from '../src/modules/employees/employees.js';
import { ToolService } from '../src/modules/tools/lifecycle.js';
import { createOrganizationSink } from '../src/modules/employees/organization.js';

const owner: UserContext = { tenantId: 'tenant-a', userId: 'alice', roles: ['owner'], projectScopes: ['project-a'] };
const ownerA = owner;
const GUIDE = '订单审核指南\n\n1. 收到订单后核对客户信用额度。\n2. 金额超过 5 万需主管审批。\n3. 用知识库问答查找价格政策。\n4. 审核结论登记到订单系统。\n5. 每月复盘坏账。';

const roles: PlanSourceRole[] = [
  { id: 'a', name: '订单审核员', duty: '核对订单', tools: ['kb', 'crm'], sops: ['review'], edited: false },
  { id: 'b', name: '信用分析员', duty: '评估信用', tools: ['kb'], sops: ['review'], edited: false },
  { id: 'c', name: '坏账专员', duty: '月度复盘', tools: ['report'], sops: ['monthly'], edited: true },
];
const keys = { toolKeys: ['kb', 'crm', 'report'], sopKeys: ['review', 'monthly'] };

describe('team plan rules', () => {
  it('merges the two roles that share the most work first and keeps all of it', () => {
    const plan = mergeByOverlap(roles, 2, { join: '、', more: (f, n) => `${f}等${n}` });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ name: '订单审核员、信用分析员', from: ['a', 'b'], tools: ['kb', 'crm'], sops: ['review'] });
    expect(plan[1]).toMatchObject({ name: '坏账专员', from: ['c'] });
    expect(mergeByOverlap(roles, 1, { join: '、', more: (f, n) => `${f}等${n}` })[0]).toMatchObject({ from: ['a', 'b', 'c'], tools: ['kb', 'crm', 'report'] });
    expect(() => mergeByOverlap(roles, 3, { join: '', more: f => f })).toThrow(TeamPlanError);
  });

  it('accepts a model plan only with the exact count, every role used and every duty kept', () => {
    const good = [
      { name: '订单与信用专员', duty: '核对订单和信用', tools: ['kb', 'crm'], sops: ['review'], from: ['a', 'b'] },
      { name: '坏账专员', duty: '月度复盘', tools: ['report'], sops: ['monthly'], from: ['c'] },
    ];
    expect(validateTeamPlan(good, { target: 2, roles, ...keys })).toHaveLength(2);
    const code = (value: unknown, target = 2) => { try { validateTeamPlan(value, { target, roles, ...keys }); return 'ok'; } catch (e) { return (e as TeamPlanError).code; } };
    expect(code(good, 3)).toBe('plan_wrong_size');
    expect(code([good[0], { ...good[1], from: ['a'] }])).toBe('plan_drops_role');
    expect(code([{ ...good[0], tools: ['kb'] }, good[1]])).toBe('plan_drops_work');
    expect(code([good[0], { ...good[1], from: ['zzz'] }])).toBe('plan_invalid_role');
    expect(code([good[0], { ...good[1], name: good[0]!.name }])).toBe('plan_duplicate_names');
    expect(validateTeamPlan([{ ...good[0], tools: ['kb', 'crm', 'invented'] }, good[1]], { target: 2, roles, ...keys })[0]!.tools).toEqual(['kb', 'crm']);
  });
});

function evidence(s: KnowledgeState, needle: string): Evidence {
  const i = s.source.items.find(i => i.current)!, c = s.source.chunks.find(c => c.itemId === i.id && c.text.includes(needle))!;
  return { sourceId: i.id, version: i.version, start: c.start, end: c.end, locator: c.locator, quote: c.text };
}
async function fixture(model?: AnalysisModel, busy: Set<string> = new Set(), shared?: { employees: EmployeeService; tools: ToolService; ctx?: UserContext }) {
  const owner = shared?.ctx ?? ownerA;
  const repo = new MemoryKnowledgeRepository(), employees = shared?.employees ?? new EmployeeService(id => (busy.has(id) ? 1 : 0)), tools = shared?.tools ?? new ToolService();
  const service = new KnowledgeService({ repo, model, organization: createOrganizationSink(() => employees, () => tools) });
  const conn = await service.createConnection(owner, { name: '资料', pluginId: 'local-file' });
  await service.confirmConnection(owner, conn.id);
  await service.upload(owner, { connectionId: conn.id, name: 'guide.md', text: GUIDE });
  const item = (await repo.read(owner)).source.items[0]!;
  await service.confirm(owner, item.id, item.version);
  await repo.transact(owner, s => {
    mergeRecommendations(s, owner, validateProposals([
      { key: 'reviewer', kind: 'employee', name: '订单审核员', description: '核对订单', evidence: [evidence(s, '信用额度')], uses: ['kb', 'crm'], sops: ['review'] },
      { key: 'credit', kind: 'employee', name: '信用分析员', description: '评估信用', evidence: [evidence(s, '审批')], uses: ['kb'], sops: ['review'] },
      { key: 'debt', kind: 'employee', name: '坏账专员', description: '月度复盘', evidence: [evidence(s, '坏账')], uses: [], sops: ['monthly'] },
      { key: 'kb', kind: 'tool', name: '知识库问答', description: '查价格政策', evidence: [evidence(s, '价格政策')] },
      { key: 'crm', kind: 'tool', name: '订单登记', description: '登记结论', evidence: [evidence(s, '登记')] },
      { key: 'review', kind: 'sop', name: '订单审核流程', description: '审核订单', evidence: [evidence(s, '审批')] },
      { key: 'monthly', kind: 'sop', name: '坏账复盘', description: '月度复盘', evidence: [evidence(s, '坏账')] },
    ]));
  });
  return { repo, service, employees };
}

describe('team plan flow (按人数重新规划)', () => {
  it('without a model, shrinking merges by shared work; preview changes nothing until adopted', async () => {
    const f = await fixture();
    const { plan, fallbackReason } = await f.service.planTeam(owner, { count: 2 });
    expect(plan).toMatchObject({ target: 2, method: 'merge', replaces: 3, stale: false });
    expect(fallbackReason).toBe('analysis_unavailable');
    expect((await f.service.organization(owner)).employees).toHaveLength(3);
    expect((await f.service.organization(owner)).teamPlan).toMatchObject({ id: plan.id, target: 2 });

    await f.service.adoptTeamPlan(owner, { planId: plan.id });
    const org = await f.service.organization(owner);
    expect(org.employees.map(e => e.name).sort()).toEqual(['坏账专员', '订单审核员、信用分析员'].sort());
    const merged = org.employees.find(e => e.name === '订单审核员、信用分析员')!;
    expect(merged).toMatchObject({ tools: ['kb', 'crm'], sops: ['review'] });
    expect(merged.evidence.length).toBe(2);
    expect(org.teamPlan).toBeNull();
  });

  it('growing needs the model; the model plan is validated and adopted', async () => {
    await expect((await fixture()).service.planTeam(owner, { count: 4 })).rejects.toMatchObject({ code: 'split_needs_model', statusCode: 503 });
    const model: AnalysisModel = {
      async check() {}, async recommend() { return []; },
      async planTeam({ roles, target }) {
        expect(target).toBe(4);
        const [a, b, c] = roles;
        return [
          { name: '订单录入员', duty: '登记订单', tools: ['crm'], sops: ['review'], from: [a!.id] },
          { name: '价格核对员', duty: '查价格政策', tools: ['kb'], sops: ['review'], from: [a!.id] },
          { name: '信用分析员', duty: '评估信用', tools: ['kb'], sops: ['review'], from: [b!.id] },
          { name: '坏账专员', duty: '月度复盘', tools: [], sops: ['monthly'], from: [c!.id] },
        ];
      },
    };
    const f = await fixture(model);
    const { plan } = await f.service.planTeam(owner, { count: 4 });
    expect(plan.method).toBe('model');
    await f.service.adoptTeamPlan(owner, { planId: plan.id });
    expect((await f.service.organization(owner)).employees).toHaveLength(4);
  });

  it('a bad model answer falls back to merging when shrinking, and errors when growing', async () => {
    const model: AnalysisModel = { async check() {}, async recommend() { return []; }, async planTeam() { return [{ name: 'x' }]; } };
    const f = await fixture(model);
    expect(await f.service.planTeam(owner, { count: 1 })).toMatchObject({ plan: { method: 'merge' }, fallbackReason: 'plan_invalid_role' });
    await expect(f.service.planTeam(owner, { count: 5 })).rejects.toMatchObject({ code: 'plan_failed' });
  });

  it('refuses stale plans, bad sizes and non-managers; confirming afterwards retires replaced employees', async () => {
    const f = await fixture();
    await f.service.confirmOrganization(owner);
    expect(f.employees.list()).toHaveLength(3);
    await expect(f.service.planTeam(owner, { count: 3 })).rejects.toMatchObject({ code: 'team_size_unchanged' });
    await expect(f.service.planTeam(owner, { count: 0 })).rejects.toMatchObject({ code: 'invalid_team_size' });
    await expect(f.service.planTeam({ ...owner, roles: ['employee'] }, { count: 2 })).rejects.toMatchObject({ statusCode: 403 });

    const { plan } = await f.service.planTeam(owner, { count: 2 });
    const someRole = (await f.service.organization(owner)).employees[0]!;
    await f.service.editRecommendation(owner, someRole.id, {}, true);
    expect((await f.service.organization(owner)).teamPlan).toMatchObject({ stale: true });
    await expect(f.service.adoptTeamPlan(owner, { planId: plan.id })).rejects.toMatchObject({ code: 'plan_stale' });

    const fresh = await f.service.planTeam(owner, { count: 1 });
    expect(await f.service.adoptTeamPlan(owner, { planId: fresh.plan.id })).toMatchObject({ createdEmployees: 1, retiredEmployees: 3 });
    expect((await f.service.organization(owner)).changedSinceConfirmation).toBe(false);
    expect(f.employees.list()).toHaveLength(1);
  });

  it("confirming removes this tenant's own leftover team employees only, and names the ones it cannot remove", async () => {
    const busy = new Set<string>();
    const f = await fixture(undefined, busy);
    await f.service.confirmOrganization(owner);
    const [legacy, busyRole] = (await f.service.organization(owner)).employees;
    // Simulate a confirmation from before the record existed: the employees exist, nothing in org points at them.
    await f.repo.transact(owner, s => {
      for (const role of [legacy!, busyRole!]) { delete s.organization!.employees[role.id]; delete s.organization!.created?.[role.employeeId!]; }
    });
    busy.add(busyRole!.employeeId!);
    // Another tenant's team employee and a hand-made employee share the registry and must never be touched.
    f.employees.ensure({ id: 'emp-org-other-tenant', name: '别家员工', duty: 'x', prompt: 'p', owner: 'bob', source: 'recommended' });
    f.employees.ensure({ id: 'emp-manual', name: '手工员工', duty: 'x', prompt: 'p', owner: 'alice', source: 'manual' });

    const { plan } = await f.service.planTeam(owner, { count: 2 });
    const confirmed = await f.service.adoptTeamPlan(owner, { planId: plan.id });
    expect(confirmed).toMatchObject({ createdEmployees: 2, retiredEmployees: 2, busyEmployees: [busyRole!.name] });
    const ids = f.employees.list().map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(['emp-org-other-tenant', 'emp-manual', busyRole!.employeeId!]));
    expect(ids).not.toContain(legacy!.employeeId);

    busy.clear();
    expect(await f.service.confirmOrganization(owner)).toMatchObject({ retiredEmployees: 1, busyEmployees: [] });
    expect(f.employees.list().map(e => e.id).sort()).toEqual([...confirmed.employees.map(e => e.employeeId), 'emp-manual', 'emp-org-other-tenant'].sort());
  });

  it("two tenants share the registry; confirming a smaller team in one never removes the other's employees", async () => {
    const employees = new EmployeeService(), tools = new ToolService();
    const a = await fixture(undefined, new Set(), { employees, tools });
    const tenantB: UserContext = { ...owner, tenantId: 'tenant-b', userId: 'bob' };
    const b = await fixture(undefined, new Set(), { employees, tools, ctx: tenantB });
    await a.service.confirmOrganization(owner);
    await b.service.confirmOrganization(tenantB);
    expect(employees.list()).toHaveLength(6);
    const { plan } = await a.service.planTeam(owner, { count: 1 });
    expect(await a.service.adoptTeamPlan(owner, { planId: plan.id })).toMatchObject({ createdEmployees: 1, retiredEmployees: 3, busyEmployees: [] });
    const bIds = (await b.service.organization(tenantB)).employees.map(e => e.employeeId);
    expect(bIds).toHaveLength(3);
    expect(employees.list().map(e => e.id)).toEqual(expect.arrayContaining(bIds as string[]));
    expect(employees.list()).toHaveLength(4);
  });

  it('discarding removes the preview', async () => {
    const f = await fixture();
    await f.service.planTeam(owner, { count: 2 });
    await f.service.discardTeamPlan(owner);
    expect((await f.service.organization(owner)).teamPlan).toBeNull();
  });
});
