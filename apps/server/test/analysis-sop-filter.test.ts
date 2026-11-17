import { describe, it, expect } from 'vitest';
import { keepEndToEndSops, recommendDraftSystemPrompt } from '../src/modules/analysis/gateway-model.js';

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `s${i}`, kind: i ? 'employee' : 'trigger', label: `step ${i}` }));

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
  });
});
