import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { emptyState, mergeRecommendations, type Evidence } from '../src/modules/knowledge/domain.js';
import { keepEndToEndSops, recommendDraftSystemPrompt } from '../src/modules/analysis/gateway-model.js';

const steps = (n: number, cites: number[] = [1, 2]) => Array.from({ length: n }, (_, i) => ({
  key: `s${i}`, kind: i ? 'employee' : 'trigger', label: `step ${i}`, citations: [cites[i % cites.length]!],
}));

describe('end-to-end SOP drafts vs knowledge rules', () => {
  it('asks the model for few company-wide workflows and objects for rules', () => {
    const prompt = recommendDraftSystemPrompt(15);
    expect(prompt).toContain('at most 3 end-to-end workflows');
    expect(prompt).toContain('Do not emit a sop for a rule');
    expect(prompt).toContain('object drafts');
    expect(prompt).toContain('Propose employees after the workflows exist');
  });

  it('turns fragment SOPs into objects and keeps at most three long workflows', () => {
    const drafts = [
      { key: 'rule', kind: 'sop', name: '超额需审批', description: '规则', evidence: [1], workflow: { steps: steps(1) } },
      { key: 'doc', kind: 'sop', name: 'CRM操作指南', description: '单文档', evidence: [1], workflow: { steps: steps(2) } },
      { key: 'e2e', kind: 'sop', name: '订单到结算', description: '端到端', evidence: [1, 2], workflow: { steps: steps(6) } },
      { key: 'e2e-b', kind: 'sop', name: '退货全流程', description: '端到端', evidence: [1], workflow: { steps: steps(4) } },
      { key: 'e2e-c', kind: 'sop', name: '开票到回款', description: '端到端', evidence: [1], workflow: { steps: steps(5) } },
      { key: 'e2e-d', kind: 'sop', name: '另一条长流程', description: '第四条', evidence: [1], workflow: { steps: steps(3) } },
      { key: 'role', kind: 'employee', name: '订单专员', description: '跟单', evidence: [1], sops: ['e2e', 'rule', 'e2e-d'] },
    ];
    const out = keepEndToEndSops(drafts) as Record<string, unknown>[];
    const sops = out.filter(d => d.kind === 'sop');
    const objects = out.filter(d => d.kind === 'object');
    expect(sops.map(d => d.key).sort()).toEqual(['e2e', 'e2e-b', 'e2e-c']);
    expect(objects.map(d => d.key).sort()).toEqual(['doc', 'e2e-d', 'rule']);
    expect(objects.every(d => d.workflow === undefined)).toBe(true);
    expect(out.find(d => d.key === 'role')).toMatchObject({ sops: ['e2e'] });
    expect(objects.every(d => d.ruleLike === true)).toBe(true);
  });

  it('does not keep a long SOP whose steps all cite one excerpt', () => {
    const drafts = [{
      key: 'one-doc', kind: 'sop', name: '同一份资料里的长步骤', description: '单文档', evidence: [1],
      workflow: { steps: steps(5, [1]) },
    }];
    const out = keepEndToEndSops(drafts) as Record<string, unknown>[];
    expect(out).toEqual([expect.objectContaining({ key: 'one-doc', kind: 'object', ruleLike: true })]);
  });

  it('does not keep a long SOP whose first step is not a trigger', () => {
    const drafts = [{
      key: 'no-trigger', kind: 'sop', name: '很长但没有触发', description: '规则堆砌', evidence: [1],
      workflow: { steps: Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, kind: 'employee', label: `step ${i}` })) },
    }];
    const out = keepEndToEndSops(drafts) as Record<string, unknown>[];
    expect(out).toEqual([expect.objectContaining({ key: 'no-trigger', kind: 'object', ruleLike: true })]);
  });

  it('drops inferred fragment SOPs when a later analysis no longer proposes them, without a delete tombstone', () => {
    const owner: UserContext = { tenantId: 't', userId: 'alice', roles: ['owner'], projectScopes: ['p'] };
    const e: Evidence = { sourceId: 's', version: 'v1', start: 0, end: 4, locator: 'a.md#L1', quote: 'quote' };
    const pass = { mcpScope: 'test', mcpRunId: 'run', validEvidence: () => true };
    const s = emptyState();
    mergeRecommendations(s, owner, [{ key: 'frag', kind: 'sop', name: 'CRM操作指南', description: '单文档', evidence: [e] }], pass);
    expect(s.recommendations.filter(r => r.kind === 'sop' && !r.deleted)).toHaveLength(1);
    mergeRecommendations(s, owner, [{ key: 'e2e', kind: 'sop', name: '订单到结算', description: '跨文档', evidence: [e] }], pass);
    expect(s.recommendations.find(r => r.key === 'frag')).toBeUndefined();
    expect(s.recommendations.find(r => r.key === 'e2e' && r.kind === 'sop' && !r.deleted)).toBeTruthy();
    mergeRecommendations(s, owner, [{ key: 'frag', kind: 'sop', name: 'CRM操作指南', description: '再次抽出', evidence: [e] }], pass);
    expect(s.recommendations.find(r => r.key === 'frag' && r.kind === 'sop' && !r.deleted)?.name).toBe('CRM操作指南');
  });

  it('still skips a key the user deleted', () => {
    const owner: UserContext = { tenantId: 't', userId: 'alice', roles: ['owner'], projectScopes: ['p'] };
    const e: Evidence = { sourceId: 's', version: 'v1', start: 0, end: 4, locator: 'a.md#L1', quote: 'quote' };
    const pass = { mcpScope: 'test', mcpRunId: 'run', validEvidence: () => true };
    const s = emptyState();
    mergeRecommendations(s, owner, [{ key: 'frag', kind: 'sop', name: 'CRM操作指南', description: '单文档', evidence: [e] }], pass);
    s.recommendations[0]!.deleted = true;
    mergeRecommendations(s, owner, [{ key: 'frag', kind: 'sop', name: 'CRM操作指南', description: '再次抽出', evidence: [e] }], pass);
    expect(s.recommendations.filter(r => r.key === 'frag')).toHaveLength(1);
    expect(s.recommendations[0]).toMatchObject({ deleted: true, name: 'CRM操作指南' });
  });
});
