import { expect, it } from 'vitest';
import { DOCUMENT_EVIDENCE_CHARS, documentEvidence } from '../src/modules/analysis/service.js';
import { MAX_READ_CHARS, readMcpForAnalysis } from '../src/modules/knowledge/mcp-analysis.js';
import type { LiveMcpKnowledge } from '../src/modules/knowledge/live-mcp.js';
import type { AnalysisGateway } from '../src/modules/analysis/gateway-model.js';
import type { AnalysisRun } from '../src/modules/knowledge/domain.js';

const chunks = (itemId: string, count: number) => Array.from({ length: count }, (_, index) => ({
  id: `${itemId}-${index}`, itemId, locator: `${itemId}:${index}`, text: String(index % 10).repeat(1200), start: index * 1200, end: (index + 1) * 1200,
}));

it('gives every document excerpts before a long document uses up the budget', () => {
  const long = { item: { id: 'catalogue', version: 'v1' }, chunks: chunks('catalogue', 200) };
  const guide = { item: { id: 'guide', version: 'v1' }, chunks: chunks('guide', 3) };
  const pricing = { item: { id: 'pricing', version: 'v1' }, chunks: chunks('pricing', 1) };
  const evidence = documentEvidence([long, guide, pricing] as Parameters<typeof documentEvidence>[0]);
  const bySource = (id: string) => evidence.filter(excerpt => excerpt.sourceId === id).length;
  expect([bySource('guide'), bySource('pricing')]).toEqual([3, 1]);
  expect(bySource('catalogue')).toBe(DOCUMENT_EVIDENCE_CHARS / 1200 - 4);
  expect(evidence.reduce((total, excerpt) => total + excerpt.quote.length, 0)).toBe(DOCUMENT_EVIDENCE_CHARS);
  expect(evidence.slice(0, 3).map(excerpt => excerpt.sourceId)).toEqual(['catalogue', 'guide', 'pricing']);
});

it('reads a whole operating guide from an MCP tool instead of its first 2,400 characters', async () => {
  const guide = '第一步：核对客户订单。'.repeat(500);
  const catalog = { name: 'VERA CRM', source: 'https://crm.example.com/api/mcp', allowTools: true, resources: [], resourceTemplates: [],
    tools: [{ name: 'get_crm_guide', inputSchema: { type: 'object' } }] };
  const mcp = {
    catalog: async () => catalog,
    call: async () => ({ source: catalog.source, tool: 'get_crm_guide', retrievedAt: new Date().toISOString(), result: [{ type: 'text', text: guide }] }),
  } as unknown as LiveMcpKnowledge;
  const gateway: AnalysisGateway = {
    check: async () => ({ ok: true, model: 'test' }),
    chat: async () => ({ text: JSON.stringify([{ source: 0, name: 'get_crm_guide', arguments: {} }]), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  };
  const ctx = { tenantId: 't', userId: 'alice', roles: ['owner' as const], projectScopes: [] };
  const run = { id: 'run', actor: ctx, mcpSources: [{ id: 'vera', name: 'VERA CRM', revision: 'r1' }] } as unknown as AnalysisRun;
  const evidence = await readMcpForAnalysis(ctx, run, mcp, gateway);
  expect(guide.length).toBeLessThan(MAX_READ_CHARS);
  expect(evidence.map(excerpt => excerpt.quote).join('')).toBe(guide);
  expect(Math.max(...evidence.map(excerpt => excerpt.quote.length))).toBeLessThanOrEqual(1200);
});
