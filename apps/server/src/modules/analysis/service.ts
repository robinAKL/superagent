import type { UserContext } from '@superagent/shared';
import { evidenceValid, hash, id, KnowledgeError, mayRead, mergeRecommendations, positionedChunks, signature, type AnalysisRun, type Evidence, type KnowledgeState, type Recommendation } from '../knowledge/domain.js';
import type { KnowledgeRepository } from '../knowledge/repository.js';
import { matchesExcerpt, mcpEvidenceValid, mcpSelectionsCurrent } from '../knowledge/mcp-analysis.js';
export interface AnalysisModel {
  check?(tenantId: string): Promise<void>;
  /** Implementation MUST reserve budget before the call and freeze uncertain outcomes. No direct-provider fallback. */
  recommend(input: { tenantId: string; runId: string; evidence: Evidence[]; maxOutputTokens: number; focus?: string }): Promise<unknown>;
  /** Optional: title/category/summary labels for one uploaded material. Output is validated and only ever a review aid. */
  profile?(input: { tenantId: string; taskId: string; name: string; excerpt: string; categories: readonly string[]; maxOutputTokens: number }): Promise<unknown>;
}
export function validateProposals(value: unknown): Omit<Recommendation, 'id' | 'humanLocked' | 'deleted'>[] {
  if (!Array.isArray(value) || value.length > 30) throw new KnowledgeError('invalid_model_output', '分析返回的草案结构无效。', 422);
  return value.map(v => {
    if (!v || typeof v !== 'object') throw new KnowledgeError('invalid_model_output', '分析草案无效。', 422);
    const p = v as Record<string, unknown>;
    for (const [key, max] of [['key', 120], ['name', 160], ['description', 4000]] as const) if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > max) throw new KnowledgeError('invalid_model_output', '分析草案字段无效。', 422);
    if (!['employee', 'tool', 'sop', 'object','relation'].includes(String(p.kind)) || !Array.isArray(p.evidence) || !p.evidence.length || p.evidence.length > 12) throw new KnowledgeError('invalid_model_output', '草案类型或依据无效。', 422);
    const relation=p.relation as Record<string,unknown>|undefined;
    if(p.kind==='relation'&&(!relation||typeof relation!=='object'||Array.isArray(relation)||['from','to','label'].some(k=>typeof relation[k]!=='string'||!(relation[k] as string).trim()||(relation[k] as string).length>(k==='label'?160:120))))throw new KnowledgeError('invalid_model_output','关系端点与说明无效。',422);
    for (const e of p.evidence) if (!e || typeof e !== 'object' || typeof e.sourceId !== 'string' || typeof e.version !== 'string' || typeof e.locator !== 'string' || typeof e.quote !== 'string' || e.quote.length > 1200 || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end)) throw new KnowledgeError('invalid_model_output', '草案引用无效。', 422);
    const evidence = (p.evidence as Evidence[]).map(({ sourceId, version, locator, start, end, quote }) => ({ sourceId, version, locator, start, end, quote }));
    return { key: p.key as string, name: p.name as string, description: p.description as string, kind: p.kind as Recommendation['kind'], evidence, ...(p.kind==='relation'?{relation:{from:relation!.from as string,to:relation!.to as string,label:relation!.label as string}}:{}) };
  });
}

function snapshotCurrent(state: KnowledgeState, ctx: UserContext, run: AnalysisRun) {
  if (!mcpSelectionsCurrent(state, ctx, run)) {
    run.status = 'stale';
    run.error = 'mcp_analysis_scope_changed';
    return false;
  }
  if (run.signature === signature(state, ctx)) return true;
  run.status = 'stale';
  return false;
}

/** Reference-only durable queue handler. Worker retries are safe; source changes during model calls discard results. */
export async function runAnalysis(
  repo: KnowledgeRepository, model: AnalysisModel, ctx: UserContext, runId: string,
  readMcp?: (run: AnalysisRun) => Promise<Evidence[]>,
): Promise<void> {
  const leaseToken = id();
  const input = await repo.transact(ctx, s => {
    const run = s.analyses.find(r => r.id === runId && r.actor.userId === ctx.userId);
    if (!run || !['queued', 'running'].includes(run.status)) return null;
    if (run.status === 'running' && (run.leaseUntil ?? 0) > Date.now()) return null;
    if (run.status === 'running' && ['read_mcp', 'recommend'].includes(run.stage)) { run.status = 'outcome_unknown'; run.error = 'model_outcome_unknown'; return null; }
    if (!snapshotCurrent(s, ctx, run)) return null;
    Object.assign(run, { status: 'running', stage: run.mcpSources?.length ? 'read_mcp' : 'extract', leaseToken, leaseUntil: Date.now() + 300_000 });
    const evidence: Evidence[] = [];
    for (const i of s.source.items.filter(i => mayRead(s, ctx, i))) for (const c of positionedChunks(s, i)) {
      if (evidence.length >= 40) break;
      if (c.text.length) evidence.push({ sourceId: i.id, version: i.version, start: c.start, end: Math.min(c.end, c.start + 1200), locator: c.locator, quote: c.text.slice(0, 1200) });
    }
    return { run, evidence };
  });
  if (!input) return;
  try {
    const selected = input.run.mcpSources ?? [];
    if (selected.length && !readMcp) throw new KnowledgeError('mcp_unavailable', 'MCP 知识连接暂时不可用。', 503);
    const liveEvidence = selected.length ? await readMcp!(input.run) : [];
    const evidence = [...liveEvidence, ...input.evidence];
    const active = await repo.transact(ctx, s => {
      const run = s.analyses.find(r => r.id === runId)!;
      if (run.status !== 'running' || run.leaseToken !== leaseToken || !snapshotCurrent(s, ctx, run)) return false;
      run.stage = 'recommend';
      run.leaseUntil = Date.now() + 300_000;
      return true;
    });
    if (!active) return;
    const result = validateProposals(await model.recommend({ tenantId: ctx.tenantId, runId, evidence, maxOutputTokens: 8192, focus: input.run.focus }));
    await repo.transact(ctx, s => {
      const run = s.analyses.find(r => r.id === runId)!;
      if (run.status !== 'running' || run.leaseToken !== leaseToken || !snapshotCurrent(s, ctx, run)) return;
      const citedMcp = new Map<string, Evidence>();
      for (const proposal of result) for (const citation of proposal.evidence) {
        const excerpt = evidence.find(item => matchesExcerpt(item, citation));
        if (!excerpt || (!excerpt.retrievedAt && !evidenceValid(s, ctx, citation))) {
          throw new KnowledgeError('unsupported_recommendation', '建议缺少当前分析的有效依据。', 422);
        }
        if (excerpt.retrievedAt) {
          citation.retrievedAt = excerpt.retrievedAt;
          citedMcp.set(JSON.stringify(citation), citation);
        }
      }
      if (selected.length) run.mcpEvidence = [...citedMcp.values()];
      const scope = selected.length ? {
        mcpScope: hash(JSON.stringify([ctx.userId, selected.map(source => [source.id, source.revision]).sort()])), mcpRunId: runId,
        validEvidence: (e: Evidence) => e.retrievedAt ? mcpEvidenceValid(s, ctx, e) : evidenceValid(s, ctx, e),
      } : undefined;
      mergeRecommendations(s, ctx, result, scope);
      const store = s.source;
      if (!scope) for (const proposal of result) for (const e of proposal.evidence) {
        const citer = s.recommendations.find(r => r.key === proposal.key && r.kind === proposal.kind)?.id;
        if (!citer) continue;
        const entry = store.citations.find(([key]) => key === e.sourceId);
        if (entry) { if (!entry[1].includes(citer)) entry[1].push(citer); } else store.citations.push([e.sourceId, [citer]]);
      }
      run.status = 'completed'; run.stage = 'complete'; run.error = null;
    });
  } catch (error) {
    await repo.transact(ctx, s => {
      const run = s.analyses.find(r => r.id === runId);
      if (run?.status !== 'running' || run.leaseToken !== leaseToken) return;
      run.error = error instanceof KnowledgeError ? error.code : 'analysis_failed';
      run.status = run.error === 'model_outcome_unknown' ? 'outcome_unknown' : run.error === 'mcp_analysis_scope_changed' ? 'stale' : 'failed';
    });
  }
}
