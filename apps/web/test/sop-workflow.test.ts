import { describe, it, expect } from 'vitest';
import { graphFromWorkflow, legacyWorkflow, knowledgeImpact, missingRegressionCases, packFromRecommendation, REGRESSION_CASES, unconfirmedItems, validationState, type GateReport } from '../src/pages/sop-workflow';

const full: GateReport = { ok: true, gates: Object.fromEntries(REGRESSION_CASES.map((c) => [c, { ok: true, detail: '' }])) };
const ev = (sourceId: string, version: string, quote: string) => ({ sourceId, version, locator: `${sourceId}#L1`, quote });

describe('validation state', () => {
  it('valid only when passed on the current revision with all regression cases and nothing unsaved', () => {
    expect(validationState({ status: 'passed', revision: 3, validatedRevision: 3, report: full }, false)).toEqual({ kind: 'valid' });
    expect(validationState({ status: 'passed', revision: 3, validatedRevision: 3, report: full }, true)).toEqual({ kind: 'dirty' });
    expect(validationState({ status: 'draft', revision: 4, validatedRevision: 3, report: full }, false)).toEqual({ kind: 'stale', validatedRevision: 3, revision: 4 });
    expect(validationState({ status: 'failed', revision: 1, validatedRevision: 1, report: full }, false)).toEqual({ kind: 'failed' });
    expect(validationState({ status: 'draft', revision: 1, validatedRevision: null, report: null }, false)).toEqual({ kind: 'none' });
    expect(validationState({ status: 'published', revision: 1, validatedRevision: 1, report: full }, false)).toEqual({ kind: 'none' });
  });

  it('a report without the baseline regression cases cannot count as valid', () => {
    const partial: GateReport = { ok: true, gates: { read_ok: { ok: true, detail: '' } } };
    expect(missingRegressionCases(partial)).toHaveLength(9);
    expect(validationState({ status: 'passed', revision: 1, validatedRevision: 1, report: partial }, false)).toMatchObject({ kind: 'incomplete' });
    expect(missingRegressionCases(full)).toEqual([]);
  });
});

describe('SOP packs from the knowledge analysis', () => {
  const rec = { key: 'invoice-intake', kind: 'sop', name: '发票受理', description: '', evidence: [ev('s1', 'v1', '收到发票后核对采购单'), ev('s2', 'v4', '金额超过 5000 需经理审批')] };

  it('every rule and the trigger start unconfirmed and carry their evidence; nothing beyond the cited text', () => {
    const p = packFromRecommendation(rec);
    expect(p.items.map((i) => [i.kind, i.text, i.confirmed])).toEqual([
      ['trigger', '发票受理', false],
      ['rule', '收到发票后核对采购单', false],
      ['rule', '金额超过 5000 需经理审批', false],
    ]);
    expect(unconfirmedItems(p)).toHaveLength(3);
    expect(p.items[2]!.evidence).toEqual([rec.evidence[1]]);
    expect(p.workflow).toBeUndefined();
  });

  it('copies concrete nodes with their exact edges and citations, and binds only existing resources', () => {
    const workflow = {
      steps: [
        { key: 'opened', kind: 'trigger' as const, label: '发票送达', after: [], citations: [1] },
        { key: 'checks', kind: 'employee' as const, label: '核对采购单', after: ['opened'], citations: [1], employeeKey: 'ap' },
        { key: 'review', kind: 'human_review' as const, label: '经理审批', after: ['checks'], citations: [2] },
        { key: 'record', kind: 'tool' as const, label: '登记账务', after: ['review'], citations: [2], toolKey: 'unavailable-tool' },
      ],
    };
    const pack = packFromRecommendation({ ...rec, workflow });
    expect(pack.items[2]?.evidence).toEqual([rec.evidence[1]]);
    const graph = graphFromWorkflow(workflow, { employees: new Map([['ap', 'emp-1']]) });
    expect(graph.nodes[1]).toMatchObject({ id: 'checks', label: '核对采购单', ref: 'emp-1' });
    expect(graph.nodes[3]?.ref).toBeUndefined();
    expect(graph.edges).toEqual([{ from: 'opened', to: 'checks' }, { from: 'checks', to: 'review' }, { from: 'review', to: 'record' }]);
    const legacy = legacyWorkflow('收到发票 → 核对金额 → 登记');
    expect(legacy?.steps.map(step => step.label)).toEqual(['收到发票', '核对金额', '登记']);
    expect(legacyWorkflow('一个通用概述。')).toBeUndefined();
  });

  it('knowledge changes are reported against the evidence the draft was built on', () => {
    const p = packFromRecommendation(rec);
    expect(knowledgeImpact(p, [{ evidence: [ev('s1', 'v1', 'x'), ev('s2', 'v4', 'y')] }])).toEqual([]);
    const changed = knowledgeImpact(p, [{ evidence: [ev('s1', 'v2', 'x')] }]);
    expect(changed.map((c) => [c.itemId, c.from, c.to])).toEqual([
      ['invoice-intake:trigger', 'v1', 'v2'],
      ['invoice-intake:rule:1', 'v1', 'v2'],
      ['invoice-intake:rule:2', 'v4', null], // s2 no longer available
    ]);
  });
});
