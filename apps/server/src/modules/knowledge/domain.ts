import { createHash, randomUUID } from 'node:crypto';
import type { SopNodeKind, UserContext } from '@superagent/shared';
import { KnowledgeStore, type Connection, type Item, type Chunk } from './store.js';
import type { StoredQueryTemplate } from './database.js';
import { ruleProfile, shingles, similarity, SIMILAR_THRESHOLD, type ItemProfile } from './profile.js';
import type { LiveMcpUser } from './live-mcp.js';
import type { SecretVersion } from '../setup/secrets.js';
export class KnowledgeError extends Error { constructor(public code: string, message: string, public statusCode = 400) { super(message); } }
export interface Snapshot { connections: Connection[]; items: Item[]; chunks: Chunk[]; citations: [string, string[]][]; flagged: [string, string][] }
export interface Evidence { sourceId: string; version: string; start: number; end: number; locator: string; quote: string; retrievedAt?: string }
export interface McpAnalysisSource { id: string; name: string; revision: string }
export interface RecommendedWorkflow {
  completion?: string;
  /** When the sources say the workflow runs on a calendar cadence; citation is the 1-based index into evidence. */
  schedule?: import('../schedules/rule.js').ScheduleRule & { citation?: number };
  steps: {
    key: string; kind: SopNodeKind; label: string; detail?: string; after: string[];
    employeeKey?: string; toolKey?: string; citations: number[];
  }[];
}
/** One property of an ontology entity, e.g. "Deposit share = 60%". citation is the 1-based index into the draft's evidence. */
export interface OntologyAttribute { name: string; value: string; citation?: number }
export interface Recommendation {
  id: string; key: string; kind: 'employee' | 'tool' | 'sop' | 'object' | 'relation'; name: string; description: string;
  origin?: 'manual' | 'inferred';
  relation?: { from: string; to: string; label: string };
  /** Object drafts: source-backed properties shown as the entity's attributes in the ontology. */
  attributes?: OntologyAttribute[];
  workflow?: RecommendedWorkflow;
  evidence: Evidence[]; humanLocked: boolean; deleted: boolean;
  proposedChange?: { name: string; description: string; evidence: Evidence[]; relation?: { from:string;to:string;label:string }; workflow?: RecommendedWorkflow };
  mcpScope?: string;
  mcpRunId?: string;
  /** Employee drafts only: the system prompt the owner reviewed, and which tool / SOP drafts (by key) the role works with. */
  prompt?: string;
  assignment?: { tools: string[]; sops: string[] };
  /** Set when an owner merged this employee draft into another one; the draft is then deleted. */
  mergedInto?: string;
  /** When the platform recorded this draft. Independent of business effective dates. */
  recordedAt?: string;
  /** Object drafts demoted from a fragment SOP: they are business rules for the knowledge lenses. */
  ruleLike?: boolean;
  /** Business effective window copied from source quotes (YYYY-MM-DD); omitted when the source does not state it. */
  effectiveFrom?: string;
  effectiveTo?: string;
}
/** What "Confirm organization" created, keyed by recommendation id so a repeat confirmation creates nothing new. */
export interface OrganizationRecord {
  confirmedAt: string; confirmedBy: string; revision: number;
  employees: Record<string, { employeeId: string; name: string; duty: string; prompt: string }>;
  /** Every employee this tenant's confirmations created, so cleanup only ever touches this tenant's employees. */
  created?: Record<string, string>;
  tools: Record<string, { toolId: string; name: string; match: 'existing' | 'placeholder'; purpose?: string; consumers?: string[] }>;
}
export interface AnalysisRun {
  id: string; actor: UserContext; status: 'queued' | 'running' | 'completed' | 'failed' | 'stale' | 'outcome_unknown';
  stage: 'parse' | 'extract' | 'read_mcp' | 'recommend' | 'complete'; signature: string; createdAt: string; error: string | null;
  skippedRelations?: number;
  mcpSources?: McpAnalysisSource[]; mcpEvidence?: Evidence[]; focus?: string;
  leaseUntil?: number; leaseToken?: string;
}
export interface ConnectionMeta { name: string; audience: string[]; projectIds: string[]; localUpload?: boolean }
export interface Confirmation { version: string; signature: string; confirmedBy: string; confirmedAt: string }
export interface Upload { connectionId: string; name: string; text: string; version: string; audience: string[] }
export interface ParseJob {
  id: string; actor: UserContext; connectionId: string; name: string; mimeType: string; blobRef: string; version: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'outcome_unknown'; operationLocation: string | null;
  notBefore: number; leaseToken: string | null; leaseUntil: number; attempts: number; error: string | null;
}
export interface KnowledgeState {
  spaceName: string; installedPlugins: string[];
  revision: number; source: Snapshot; connectionMeta: Record<string, ConnectionMeta>; confirmations: Record<string, Confirmation>;
  analyses: AnalysisRun[]; recommendations: Recommendation[]; uploads: Upload[]; disabledPlugins: string[]; parseJobs: ParseJob[]; queryTemplates: StoredQueryTemplate[];
  profiles: Record<string, ItemProfile>;
  liveMcp: Record<string, LiveMcpUser>;
  /** Existing grants from the previous release, migrated on the user's next write. */
  veraMcp: Record<string, { grant?: { clientId: string; deadline: number; secret: SecretVersion } }>;
  organization?: OrganizationRecord;
  /** A pending "team size" proposal (preview only until adopted). */
  teamPlan?: import('./team-plan.js').TeamPlan;
}
export const emptyState = (): KnowledgeState => ({ spaceName: '企业知识', installedPlugins: ['local-file'], revision: 0, source: { connections: [], items: [], chunks: [], citations: [], flagged: [] }, connectionMeta: {}, confirmations: {}, analyses: [], recommendations: [], uploads: [], disabledPlugins: [], parseJobs: [], queryTemplates: [], profiles: {}, liveMcp: {}, veraMcp: {} });
export const stamp = () => new Date().toISOString();
export const id = () => randomUUID();
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function hydrate(s: Snapshot): KnowledgeStore {
  const store = new KnowledgeStore(); store.connections = new Map(s.connections.map(c => [c.id, c])); store.items = new Map(s.items.map(i => [i.id, i])); store.chunks = s.chunks;
  store.citations = new Map(s.citations.map(([k, v]) => [k, new Set(v)])); store.flagged = new Map(s.flagged); return store;
}
export function snapshot(store: KnowledgeStore): Snapshot { return { connections: [...store.connections.values()], items: [...store.items.values()], chunks: store.chunks, citations: [...store.citations].map(([k, v]) => [k, [...v]]), flagged: [...store.flagged] }; }
export function requireManager(ctx: UserContext) { if (!ctx.roles.some(r => r === 'owner' || r === 'admin')) throw new KnowledgeError('forbidden', '需要企业负责人或管理员权限。', 403); }
export function sourceOf(state: KnowledgeState, sourceId: string): Item { const item = state.source.items.find(i => i.id === sourceId); if (!item) throw new KnowledgeError('not_found', '来源条目不存在。', 404); return item; }
export function itemSignature(state: KnowledgeState, item: Item): string {
  const conn = state.source.connections.find(c => c.id === item.connectionId);
  return hash(JSON.stringify([item.version, item.contentHash, item.acl, conn?.scope, state.connectionMeta[item.connectionId]?.projectIds]));
}
/** Role never bypasses source ACL or project intersection. Repository enforces tenant isolation. */
export function selectedItem(scope: Record<string, unknown>, externalId: string, includeAttachments = true): boolean {
  const selected = scope.selectedExternalIds;
  return !Array.isArray(selected) || selected.some(id => typeof id === 'string' && (id === externalId || (includeAttachments && externalId.startsWith(`${id}/att/`))));
}
export function mayRead(state: KnowledgeState, ctx: UserContext, item: Item, confirmed = true): boolean {
  const conn = state.source.connections.find(c => c.id === item.connectionId), meta = state.connectionMeta[item.connectionId];
  if (!conn || !meta || !meta.audience.includes(ctx.userId) || conn.status !== 'confirmed' || !selectedItem(conn.scope, item.externalId, conn.pluginId !== 'mcp') || state.disabledPlugins.includes(conn.pluginId) || !item.current || item.status !== 'parsed' || !item.acl?.some(a => a.access === 'read' && a.principal === ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) return false;
  return !confirmed || state.confirmations[item.id]?.signature === itemSignature(state, item);
}
export function signature(state: KnowledgeState, ctx: UserContext): string { return hash(JSON.stringify(state.source.items.filter(i => mayRead(state, ctx, i)).map(i => [i.id, itemSignature(state, i)]).sort())); }
/** Gives every current parsed version a rule profile and a likely duplicate/earlier-revision pointer. */
export function refreshProfiles(state: KnowledgeState): void {
  const profiles = state.profiles ??= {};
  const current = state.source.items.filter(i => i.current && i.status === 'parsed');
  const live = new Set(current.map(i => i.id));
  for (const key of Object.keys(profiles)) if (!live.has(key)) delete profiles[key];
  for (const item of current) {
    if (profiles[item.id]?.version === item.version) continue;
    const text = positionedChunks(state, item).map(c => c.text).join('\n'), sketch = shingles(text);
    const others = current.filter(o => o.id !== item.id && profiles[o.id]?.version === o.version);
    const previous = state.source.items.find(o => o.connectionId === item.connectionId && o.externalId === item.externalId && o.id !== item.id && !o.current && o.status !== 'deleted');
    const duplicate = others.find(o => o.contentHash === item.contentHash);
    let similar: { id: string; score: number } | null = null;
    for (const o of others) { const score = similarity(sketch, profiles[o.id]!.shingles); if (score >= SIMILAR_THRESHOLD && (!similar || score > similar.score)) similar = { id: o.id, score }; }
    const related = duplicate ? { sourceId: duplicate.id, kind: 'duplicate' as const } : previous ? { sourceId: previous.id, kind: 'update' as const } : similar ? { sourceId: similar.id, kind: 'similar' as const } : null;
    profiles[item.id] = { version: item.version, ...ruleProfile(item.externalId.split('/').pop() ?? item.title, text), origin: 'rules', refine: 'pending', related, shingles: sketch };
  }
}
export function invalidateAnalyses(state: KnowledgeState): void {
  state.revision++;
  refreshProfiles(state);
  for (const [key, c] of Object.entries(state.confirmations)) { const item = state.source.items.find(i => i.id === key); if (!item || !item.current || item.status !== 'parsed' || c.signature !== itemSignature(state, item)) delete state.confirmations[key]; }
  for (const run of state.analyses) if (run.signature !== signature(state, run.actor) && ['queued', 'running', 'completed'].includes(run.status)) run.status = 'stale';
}
export function confirmSource(state: KnowledgeState, ctx: UserContext, sourceId: string, version: string): void {
  requireManager(ctx); const item = sourceOf(state, sourceId);
  if (!mayRead(state, ctx, item, false)) throw new KnowledgeError('source_denied', '源权限未知、范围不足或连接不可读，确认不能覆盖源权限。', 403);
  if (item.version !== version) throw new KnowledgeError('version_changed', '来源版本已变化，请重新核对。', 409);
  state.confirmations[item.id] = { version, signature: itemSignature(state, item), confirmedBy: ctx.userId, confirmedAt: stamp() };
  Object.assign(item, { confirmedVersion: version }); invalidateAnalyses(state);
}
export function positionedChunks(state: KnowledgeState, item: Item): (Chunk & { start: number; end: number })[] {
  // Never invent offsets from adjacent chunks: blank lines and paragraph gaps must retain their source positions.
  return state.source.chunks.filter(c => c.itemId === item.id).flatMap(c => { const explicit = c as Chunk & { start?: number; end?: number }; const { start, end } = explicit; return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start! >= 0 && end! - start! === c.text.length ? [{ ...c, start: start!, end: end! }] : []; });
}
export function evidenceValid(state: KnowledgeState, ctx: UserContext, e: Evidence): boolean {
  const item = state.source.items.find(i => i.id === e.sourceId);
  if (!item || !mayRead(state, ctx, item) || item.version !== e.version || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start) return false;
  return positionedChunks(state, item).some(c => e.start >= c.start && e.end <= c.end && c.text.slice(e.start - c.start, e.end - c.start) === e.quote && c.locator === e.locator);
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function calendarDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export function datesInText(text: string): string[] {
  return [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(match => match[0]).filter(calendarDay);
}
/** Effective dates only when the quote states them as start/end — a meeting date in the quote is not enough. */
export function validityOf(p: { effectiveFrom?: unknown; effectiveTo?: unknown; evidence: Evidence[] }): { effectiveFrom?: string; effectiveTo?: string } {
  const quotes = p.evidence.map(e => e.quote).join('\n');
  const allowed = new Set(datesInText(quotes));
  const fromCited = new Set([...quotes.matchAll(/(?:takes effect(?:\s+on)?|valid from|effective(?:\s+(?:from|on))?|自|生效于?)\s*(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})\s*(?:起(?:生效)?|生效)/gi)]
    .map(match => match[1] ?? match[2]).filter((day): day is string => !!day && allowed.has(day)));
  const toCited = new Set([...quotes.matchAll(/(?:valid until|effective until|止于|失效|截止)\s*(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})\s*(?:止|失效|截止)/gi)]
    .map(match => match[1] ?? match[2]).filter((day): day is string => !!day && allowed.has(day)));
  const pick = (value: unknown, cited: Set<string>) => typeof value === 'string' && cited.has(value) ? value : [...cited][0];
  const effectiveFrom = pick(p.effectiveFrom, fromCited);
  const effectiveTo = pick(p.effectiveTo, toCited);
  const out: { effectiveFrom?: string; effectiveTo?: string } = {};
  if (effectiveFrom) out.effectiveFrom = effectiveFrom;
  if (effectiveTo && (!effectiveFrom || effectiveTo >= effectiveFrom)) out.effectiveTo = effectiveTo;
  return out;
}

export function mergeRecommendations(
  state: KnowledgeState, ctx: UserContext, proposals: Omit<Recommendation, 'id' | 'humanLocked' | 'deleted'>[],
  mcp?: { mcpScope: string; mcpRunId: string; validEvidence: (e: Evidence) => boolean },
) {
  const scoped = state.recommendations.filter(r => r.mcpScope === mcp?.mcpScope);
  const valid = mcp?.validEvidence ?? ((e: Evidence) => evidenceValid(state, ctx, e));
  const evidenceOk = (e: Evidence) => evidenceValid(state, ctx, e) || valid(e);
  for (const p of proposals) {
    if (!p.key || !p.name || !p.evidence.length || !p.evidence.every(valid)) throw new KnowledgeError('unsupported_recommendation', '模型建议缺少当前可定位依据，不能生成草案。', 422);
  }
  const objects = new Set(
    state.recommendations
      .filter(r => r.kind === 'object' && !r.deleted && r.evidence.length && r.evidence.every(evidenceOk))
      .map(r => r.key),
  );
  for (const p of proposals) {
    if (p.kind !== 'object') continue;
    const existing = scoped.find(r => r.kind === 'object' && r.key === p.key);
    if (!existing?.deleted && !existing?.humanLocked) objects.add(p.key);
  }
  let skippedRelations = 0;
  const accepted: typeof proposals = [];
  for (const p of proposals) {
    const existing = scoped.find(r => r.key === p.key && r.kind === p.kind);
    if (existing?.deleted) continue;
    if (p.kind === 'relation' && (!p.relation || !objects.has(p.relation.from) || !objects.has(p.relation.to))) {
      skippedRelations++;
      continue;
    }
    accepted.push(p);
    if (existing?.humanLocked) { existing.proposedChange = { name: p.name, description: p.description, evidence: p.evidence, workflow: p.workflow, ...(p.relation?{relation:p.relation}:{}) }; continue; }
    const { effectiveFrom: _from, effectiveTo: _to, recordedAt: _recorded, ...rest } = p;
    const recordedAt = existing?.recordedAt ?? stamp();
    const draft = { ...rest, workflow: p.workflow, origin: 'inferred' as const, recordedAt, ...validityOf(p), ...(mcp && { mcpScope: mcp.mcpScope, mcpRunId: mcp.mcpRunId }) };
    if (existing) {
      delete existing.effectiveFrom;
      delete existing.effectiveTo;
      delete existing.attributes;
      Object.assign(existing, draft, { recordedAt: existing.recordedAt ?? recordedAt });
    }
    else {
      const recommendation = { ...draft, id: id(), humanLocked: false, deleted: false };
      state.recommendations.push(recommendation);
      scoped.push(recommendation);
    }
  }
  if (skippedRelations && !accepted.length) {
    throw new KnowledgeError('unsupported_relation', '关系必须引用当前有依据且未删除的业务对象草案。', 422);
  }
  const liveSops = new Set(accepted.filter(p => p.kind === 'sop').map(p => p.key));
  const dropped = scoped.filter(r => r.kind === 'sop' && r.origin === 'inferred' && !r.humanLocked && !r.deleted && !liveSops.has(r.key));
  for (const r of dropped) {
    const i = state.recommendations.indexOf(r);
    if (i >= 0) state.recommendations.splice(i, 1);
  }
  return { accepted, skippedRelations };
}
