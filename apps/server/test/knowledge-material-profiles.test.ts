import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { refineOneProfile } from '../src/modules/knowledge/worker.js';
import { ruleProfile, shingles, similarity, validateProfile } from '../src/modules/knowledge/profile.js';
import type { AnalysisModel } from '../src/modules/analysis/service.js';

const owner: UserContext = { tenantId: 'tenant-a', userId: 'alice', roles: ['owner'], projectScopes: [] };
const employee: UserContext = { ...owner, userId: 'erin', roles: ['employee'] };
const policy = '# 差旅报销管理办法\n\n第一条 员工出差前须在系统提交申请。\n第二条 报销须附发票，超过五千元需部门负责人审批。';

describe('rule profiles', () => {
  it('derives title, category and a short summary without a model', () => {
    expect(ruleProfile('travel.md', policy)).toEqual({ title: '差旅报销管理办法', category: 'finance', summary: '第一条 员工出差前须在系统提交申请。第二条 报销须附发票，超过五千元需部门负责人审批。' });
    expect(ruleProfile('q3_sales.csv', 'region,amount\nnorth,10\nsouth,8')).toEqual({ title: 'q3 sales', category: 'data', summary: '数据表，2 行；列：region、amount。' });
    expect(ruleProfile('notes.txt', 'Meeting minutes\nAttendees: A, B').category).toBe('meeting');
    expect(ruleProfile('x.txt', 'hello').category).toBe('other');
    expect(ruleProfile('onboarding.md', '# 新员工入职培训\n\n第二周跟岗学习客服流程。').category).toBe('training');
  });
  it('estimates similarity from bounded sketches', () => {
    const a = shingles(policy.repeat(3)), b = shingles(`${policy.repeat(3)}\n第三条 新增住宿标准。`), c = shingles('完全不同的产品规格说明书，包含尺寸和重量参数。'.repeat(5));
    expect(a.length).toBeLessThanOrEqual(256);
    expect(similarity(a, b)).toBeGreaterThan(0.5);
    expect(similarity(a, c)).toBeLessThan(0.2);
  });
  it('rejects model labels outside the contract', () => {
    expect(validateProfile({ title: 'T', category: 'policy', summary: 'S' })).toEqual({ title: 'T', category: 'policy', summary: 'S' });
    for (const bad of [null, [], { title: '', category: 'policy', summary: 'S' }, { title: 'T', category: 'secret', summary: 'S' }, { title: 'T', category: 'policy', summary: 'x'.repeat(401) }]) expect(validateProfile(bad)).toBeNull();
  });
});

async function put(service: KnowledgeService, ctx: UserContext, files: { name: string; text: string }[]) { for (const f of files) await service.uploadLocal(ctx, f); }

describe('material profiles on local uploads', () => {
  it('profiles each upload and flags exact duplicates', async () => {
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository() });
    await put(service, owner, [{ name: 'travel.md', text: policy }, { name: 'copy.md', text: policy }, { name: 'sales.csv', text: 'region,amount\nnorth,10' }]);
    const byName = Object.fromEntries((await service.overview(owner)).items.map(i => [i.title, i]));
    expect(byName['travel.md']!.profile).toMatchObject({ title: '差旅报销管理办法', category: 'finance', origin: 'rules', refining: false, related: null });
    expect(byName['copy.md']!.profile!.related).toMatchObject({ kind: 'duplicate', id: byName['travel.md']!.id, title: '差旅报销管理办法', confirmed: true });
    expect(byName['sales.csv']!.profile).toMatchObject({ category: 'data' });
  });
  it('flags a re-uploaded file as an update of its earlier version', async () => {
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository() });
    await put(service, owner, [{ name: 'travel.md', text: policy }]);
    await put(service, owner, [{ name: 'travel.md', text: `${policy}
第三条 住宿标准另行规定。` }]);
    const items = (await service.overview(owner)).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.profile!.related).toMatchObject({ kind: 'update', confirmed: true });
  });
  it('flags a near-identical file under another name as similar', async () => {
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository() });
    await put(service, owner, [{ name: 'v1.md', text: policy.repeat(3) }, { name: 'v2.md', text: `${policy.repeat(3)}
第三条 住宿标准另行规定。` }]);
    const v2 = (await service.overview(owner)).items.find(i => i.title === 'v2.md')!;
    expect(v2.profile!.related).toMatchObject({ kind: 'similar', title: '差旅报销管理办法' });
  });
  it('does not reveal a duplicate the viewer cannot read', async () => {
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository() });
    await put(service, owner, [{ name: 'secret.md', text: policy }]);
    await put(service, { ...owner, userId: 'bob' }, [{ name: 'mine.md', text: policy }]);
    const view = await service.overview({ ...owner, userId: 'bob' });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.profile!.related).toBeNull();
  });
  it('lets a manager correct the title and category', async () => {
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository() });
    await put(service, owner, [{ name: 'a.md', text: '付款前核对金额。' }]);
    const item = (await service.overview(owner)).items[0]!;
    await service.editProfile(owner, item.id, { title: '付款核对规则', category: 'policy' });
    expect((await service.overview(owner)).items[0]!.profile).toMatchObject({ title: '付款核对规则', category: 'policy', origin: 'human' });
    await expect(service.editProfile(owner, item.id, { title: 'x', category: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.editProfile(employee, item.id, { title: 'x', category: 'policy' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('batch confirm', () => {
  it('confirms several pending versions and reports failures without blocking the rest', async () => {
    const repo = new MemoryKnowledgeRepository(), service = new KnowledgeService({ repo });
    const conn = await service.createConnection(owner, { name: '资料', pluginId: 'local-file' });
    await service.confirmConnection(owner, conn.id);
    await service.upload(owner, { connectionId: conn.id, name: 'a.md', text: '付款前核对金额。' });
    await service.upload(owner, { connectionId: conn.id, name: 'b.md', text: '采购须比价三家。' });
    const [a, b] = (await service.overview(owner)).items;
    expect([a!.confirmed, b!.confirmed]).toEqual([false, false]);
    const result = await service.confirmMany(owner, { items: [{ id: a!.id, version: a!.version }, { id: b!.id, version: 'stale' }, { id: 'missing', version: 'x' }] });
    expect(result.confirmed).toBe(1);
    expect(result.failed.map(f => f.id)).toEqual([b!.id, 'missing']);
    expect((await service.search(owner, '付款')).hits).toHaveLength(1);
    expect((await service.search(owner, '采购')).hits).toEqual([]);
    await expect(service.confirmMany(employee, { items: [{ id: a!.id, version: a!.version }] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.confirmMany(owner, { items: [] })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('model refinement', () => {
  const model = (reply: unknown): AnalysisModel & { calls: number } => ({ calls: 0, async recommend() { return []; }, async profile() { this.calls++; if (reply instanceof Error) throw reply; return reply; } });
  it('replaces rule labels with validated model labels once per version', async () => {
    const repo = new MemoryKnowledgeRepository(), m = model({ title: '差旅报销制度', category: 'policy', summary: '规定出差申请与报销审批。' }), service = new KnowledgeService({ repo, model: m });
    await service.uploadLocal(owner, { name: 'travel.md', text: policy });
    expect((await service.overview(owner)).items[0]!.profile!.refining).toBe(true);
    expect(await refineOneProfile({ repo, model: m }, owner.tenantId)).toBe(true);
    expect(await refineOneProfile({ repo, model: m }, owner.tenantId)).toBe(false);
    expect(m.calls).toBe(1);
    expect((await service.overview(owner)).items[0]!.profile).toMatchObject({ title: '差旅报销制度', category: 'policy', summary: '规定出差申请与报销审批。', origin: 'model', refining: false });
  });
  it('does not show "organizing" when the model is not ready', async () => {
    const m = { ...model({ title: 'T', category: 'policy', summary: 'S' }), async check() { throw new Error('no model configured'); } };
    const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), model: m });
    await service.uploadLocal(owner, { name: 'travel.md', text: policy });
    expect((await service.overview(owner)).items[0]!.profile!.refining).toBe(false);
  });
  it('keeps rule labels when the model fails or returns invalid output, and never overwrites human edits', async () => {
    for (const reply of [new Error('budget'), { title: 'x', category: 'bogus', summary: 'y' }]) {
      const repo = new MemoryKnowledgeRepository(), m = model(reply), service = new KnowledgeService({ repo, model: m });
      await service.uploadLocal(owner, { name: 'travel.md', text: policy });
      await refineOneProfile({ repo, model: m }, owner.tenantId);
      expect((await service.overview(owner)).items[0]!.profile).toMatchObject({ title: '差旅报销管理办法', origin: 'rules', refining: false });
    }
    const repo = new MemoryKnowledgeRepository(), m = model({ title: 'AI', category: 'other', summary: 'AI' }), service = new KnowledgeService({ repo, model: m });
    await service.uploadLocal(owner, { name: 'travel.md', text: policy });
    const item = (await service.overview(owner)).items[0]!;
    await service.editProfile(owner, item.id, { title: '人工标题', category: 'policy' });
    expect(await refineOneProfile({ repo, model: m }, owner.tenantId)).toBe(false);
    expect((await service.overview(owner)).items[0]!.profile).toMatchObject({ title: '人工标题', origin: 'human' });
  });
});
