import { SOP_NODE_KINDS, type SopNodeKind, type UserContext } from '@superagent/shared';
import { evidenceValid, hash, id, KnowledgeError, mayRead, mergeRecommendations, positionedChunks, signature, type AnalysisRun, type Evidence, type KnowledgeState, type OntologyAttribute, type Recommendation, type RecommendedWorkflow } from '../knowledge/domain.js';
import type { KnowledgeRepository } from '../knowledge/repository.js';
import { matchesExcerpt, mcpEvidenceValid, mcpSelectionsCurrent } from '../knowledge/mcp-analysis.js';
export interface AnalysisModel {
  check?(tenantId: string): Promise<void>;
  /** Implementation MUST reserve budget before the call and freeze uncertain outcomes. No direct-provider fallback. */
  recommend(input: { tenantId: string; runId: string; evidence: Evidence[]; maxOutputTokens: number; focus?: string }): Promise<unknown>;
  /** Optional: title/category/summary labels for one uploaded material. Output is validated and only ever a review aid. */
  profile?(input: { tenantId: string; taskId: string; name: string; excerpt: string; categories: readonly string[]; maxOutputTokens: number }): Promise<unknown>;
  /** Optional: re-plan the role drafts into exactly `target` roles. Output is validated by the caller (team-plan.ts). */
  planTeam?(input: { tenantId: string; taskId: string; target: number; maxOutputTokens: number;
    roles: { id: string; name: string; duty: string; tools: string[]; sops: string[] }[];
    tools: { key: string; name: string; description: string }[]; sops: { key: string; name: string; description: string }[] }): Promise<unknown>;
}
function boundedText(input: unknown, max: number): string | undefined {
  return typeof input === 'string' && input.length <= max && input.trim() ? input.trim() : undefined;
}

/** Optional workflow detail is kept only when every step has a direct citation and connects to the trigger. */
function recommendedWorkflow(input: unknown, evidenceCount: number): RecommendedWorkflow | undefined {
  if (!input || typeof input !== 'object') return;
  const { steps, completion } = input as Record<string, unknown>;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 12) return;

  const seen = new Set<string>();
  const workflow: RecommendedWorkflow = { steps: [], completion: boundedText(completion, 500) };
  for (const [index, value] of steps.entries()) {
    if (!value || typeof value !== 'object') return;
    const key = boundedText(value.key, 80);
    const label = boundedText(value.label, 160);
    const kind = value.kind as SopNodeKind;
    const after = value.after as unknown;
    const citations = value.citations as unknown;
    if (!key || !label || seen.has(key) || !SOP_NODE_KINDS.includes(kind) || (index === 0) !== (kind === 'trigger')) return;
    if (!Array.isArray(after) || after.length > 6 || (index === 0) !== (after.length === 0) ||
        after.some(parent => typeof parent !== 'string' || !seen.has(parent))) return;
    if (!Array.isArray(citations) || !citations.length || citations.length > 3 ||
        citations.some(citation => !Number.isInteger(citation) || citation < 1 || citation > evidenceCount)) return;
    seen.add(key);
    workflow.steps.push({
      key, kind, label, detail: boundedText(value.detail, 500),
      after: [...new Set<string>(after)], citations: [...new Set<number>(citations)],
      employeeKey: boundedText(value.employeeKey, 120), toolKey: boundedText(value.toolKey, 120),
    });
  }
  return workflow;
}

/** Keeps well-formed entity properties; a malformed property is dropped instead of failing the whole draft. */
export function ontologyAttributes(value: unknown, evidenceCount: number): OntologyAttribute[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: OntologyAttribute[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || out.length >= 12) continue;
    const a = entry as Record<string, unknown>;
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const raw = typeof a.value === 'number' || typeof a.value === 'boolean' ? String(a.value) : a.value;
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!name || !v || name.length > 80 || v.length > 300 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const citation = Number.isInteger(a.citation) && (a.citation as number) >= 1 && (a.citation as number) <= evidenceCount ? a.citation as number : undefined;
    out.push({ name, value: v, ...(citation ? { citation } : {}) });
  }
  return out;
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
    const keys = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((k): k is string => typeof k === 'string' && !!k.trim() && k.length <= 120).map(k => k.trim()))].slice(0, 12) : [];
    const assignment = p.kind === 'employee' && (p.uses !== undefined || p.sops !== undefined) ? { assignment: { tools: keys(p.uses), sops: keys(p.sops) } } : {};
    const workflow = p.kind === 'sop' ? recommendedWorkflow(p.workflow, evidence.length) : undefined;
    const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    const validity = { ...(day(p.effectiveFrom) ? { effectiveFrom: day(p.effectiveFrom) } : {}), ...(day(p.effectiveTo) ? { effectiveTo: day(p.effectiveTo) } : {}) };
    const attributes = p.kind === 'object' ? ontologyAttributes(p.attributes, evidence.length) : [];
    const ruleLike = p.kind === 'object' && (p.ruleLike === true || p.rule === true);
    return { workflow, key: p.key as string, name: p.name as string, description: p.description as string, kind: p.kind as Recommendation['kind'], evidence, ...assignment, ...validity, ...(attributes.length ? { attributes } : {}), ...(ruleLike ? { ruleLike: true } : {}), ...(p.kind==='relation'?{relation:{from:relation!.from as string,to:relation!.to as string,label:relation!.label as string}}:{}) };
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

const EXCERPT_LENGTH = 1200;
export const DOCUMENT_EVIDENCE_CHARS = 60_000;

/** Takes excerpts from every readable document in turn, so early documents cannot use up the budget alone. */
export function documentEvidence(documents: { item: { id: string; version: string }; chunks: ReturnType<typeof positionedChunks> }[]): Evidence[] {
  const queues = documents.map(({ item, chunks }) => chunks.filter(c => c.text.length).map(c => ({
    sourceId: item.id, version: item.version, start: c.start, end: Math.min(c.end, c.start + EXCERPT_LENGTH),
    locator: c.locator, quote: c.text.slice(0, EXCERPT_LENGTH),
  })));
  const evidence: Evidence[] = [];
  let remaining = DOCUMENT_EVIDENCE_CHARS;
  for (let round = 0; queues.some(queue => round < queue.length); round++) {
    for (const queue of queues) {
      const excerpt = queue[round];
      if (!excerpt) continue;
      if (excerpt.quote.length > remaining) return evidence;
      remaining -= excerpt.quote.length;
      evidence.push(excerpt);
    }
  }
  return evidence;
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
    return { run, evidence: documentEvidence(s.source.items.filter(i => mayRead(s, ctx, i)).map(i => ({ item: i, chunks: positionedChunks(s, i) }))) };
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
    const result = validateProposals(await model.recommend({ tenantId: ctx.tenantId, runId, evidence, maxOutputTokens: 16384, focus: input.run.focus }));
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
      const { accepted, skippedRelations } = mergeRecommendations(s, ctx, result, scope);
      run.skippedRelations = skippedRelations;
      const store = s.source;
      if (scope) {
        const citations = accepted.flatMap(proposal => proposal.evidence).filter(citation => citation.retrievedAt);
        run.mcpEvidence = [...new Map(citations.map(citation => [JSON.stringify(citation), citation])).values()];
      } else for (const proposal of accepted) for (const e of proposal.evidence) {
        const citer = s.recommendations.find(r => !r.mcpScope && !r.deleted && r.key === proposal.key && r.kind === proposal.kind)?.id;
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
