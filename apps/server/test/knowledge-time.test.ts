import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { emptyState, mergeRecommendations, validityOf, type Evidence } from '../src/modules/knowledge/domain.js';

const owner: UserContext = { tenantId: 't', userId: 'alice', roles: ['owner'], projectScopes: ['p'] };
const quote = '审批阈值自 2026-08-01 起生效，2026-10-31 截止。';
const evidence = (text = quote): Evidence => ({ sourceId: 's', version: 'v1', start: 0, end: text.length, locator: 'policy.md#L1', quote: text });

describe('dual time on analysis drafts', () => {
  it('copies effective dates only when they appear in cited quotes', () => {
    expect(validityOf({ evidence: [evidence()], effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' }))
      .toEqual({ effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' });
    expect(validityOf({ evidence: [evidence()], effectiveFrom: '2099-01-01' })).toEqual({ effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' });
    expect(validityOf({ evidence: [evidence('没有日期的规则')] })).toEqual({});
    expect(validityOf({ evidence: [evidence('无效日 2026-99-99')], effectiveFrom: '2026-99-99' })).toEqual({});
  });

  it('stamps recordedAt on merge and keeps it on a later update', () => {
    const s = emptyState();
    const e = evidence();
    const pass = { mcpScope: 'test', mcpRunId: 'run', validEvidence: () => true };
    mergeRecommendations(s, owner, [{ key: 'threshold', kind: 'object', name: '审批阈值', description: '阈值', evidence: [e], effectiveFrom: '2026-08-01' }], pass);
    const first = s.recommendations[0]!;
    expect(first.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.effectiveFrom).toBe('2026-08-01');
    const recordedAt = first.recordedAt;
    mergeRecommendations(s, owner, [{ key: 'threshold', kind: 'object', name: '审批阈值', description: '新描述', evidence: [e] }], pass);
    expect(s.recommendations[0]!.recordedAt).toBe(recordedAt);
    mergeRecommendations(s, owner, [{ key: 'threshold', kind: 'object', name: '审批阈值', description: '无日期', evidence: [evidence('No date stated')] }], pass);
    expect(s.recommendations[0]!.effectiveFrom).toBeUndefined();
    expect(s.recommendations[0]!.effectiveTo).toBeUndefined();
  });
});
