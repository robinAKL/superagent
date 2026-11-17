import type { KnowledgeSourcePlugin, SourceContent, UserContext } from '@superagent/shared';
import { confirmSource, evidenceValid, hash, hydrate, id, invalidateAnalyses, KnowledgeError, mayRead, positionedChunks, selectedItem, requireManager, signature, snapshot, stamp, type KnowledgeState, type Evidence, type Recommendation } from './domain.js';
import { managedSource, publicSourceScope, sourceScope, type SourceResource } from './sources.js';
import type { Connection, Item } from './store.js';
import type { AuditSink } from '../audit/audit.js';
import type { KnowledgeRepository, SearchHit } from './repository.js';
import { syncConnection } from './sync.js';
import { createLocalFilePlugin, textWithLineAnchors } from './plugins/local-file.js';
import type { AnalysisModel } from '../analysis/service.js';
import { decodeUpload, queueBinaryUpload, queueDocument, type BinaryDeps } from './binary.js';
import { mimeFor } from './docintel-parser.js';
import { parseMacroWorkbook } from './xlsm-parser.js';
import type { DatabaseGateway } from './database.js';
import { CATEGORIES, type Category } from './profile.js';
import { createPublicMcp, isPublicMcpScope } from './plugins/mcp-resources.js';
import { publicMcpEndpoint } from './plugins/mcp-public-http.js';
import { liveMcpSelection, type LiveMcpKnowledge } from './live-mcp.js';
import { MAX_MCP_ANALYSIS_SOURCES, mcpEvidenceValid, mcpSelectionsCurrent } from './mcp-analysis.js';
import type { AnalysisGateway } from '../analysis/gateway-model.js';
import { orgEmployeeId, type OrganizationSink } from '../employees/organization.js';
import { mergeByOverlap, TEAM_SIZE_MAX, TeamPlanError, validateTeamPlan, type PlanRole, type PlanSourceRole, type TeamPlan } from './team-plan.js';
export interface KnowledgeDeps {
  repo: KnowledgeRepository;
  plugins?: Record<string, KnowledgeSourcePlugin>;
  sourceResources?: SourceResource[];
  model?: AnalysisModel;
  enqueue?: (ctx: UserContext, runId: string) => Promise<void>;
  binary?: BinaryDeps;
  database?: DatabaseGateway;
  publicMcp?: ReturnType<typeof createPublicMcp>;
  liveMcp?: LiveMcpKnowledge;
  mcpAnswerGateway?: AnalysisGateway;
  close?: () => Promise<void>;
  audit?: AuditSink;
  /** Creates employees and tool placeholders when an owner confirms the organization draft. */
  organization?: OrganizationSink;
}
export const MANIFESTS = [
  { id: 'local-file', name: '本地文件', capabilities: ['文件导入', '版本与行定位'] },
  { id: 'database', name: '只读数据库', capabilities: ['结构知识', '受控实时查询'] },
  { id: 'email', name: '企业邮件', capabilities: ['指定邮箱', '增量同步'] },
  { id: 'mcp', name: 'MCP', capabilities: ['已授权的服务器', '只读资源'] },
  { id: 'sharepoint', name: 'SharePoint', capabilities: ['资料库范围', '源权限同步'] },
];
function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new KnowledgeError('invalid_input', `${label}无效。`); return value;
}
function strings(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !x || x.length > 200)) throw new KnowledgeError('invalid_input', '权限范围无效。'); return [...new Set(value)];
}
export class KnowledgeService {
  private readonly publicMcp: ReturnType<typeof createPublicMcp>;
  constructor(readonly deps: KnowledgeDeps) {
    this.publicMcp = deps.publicMcp ?? createPublicMcp();
  }
  private allowed(state: KnowledgeState, ctx: UserContext, item: Item, confirmed = true): boolean {
    if (!mayRead(state, ctx, item, confirmed)) return false;
    const conn = state.source.connections.find(c => c.id === item.connectionId)!;
    if (managedSource(conn.pluginId) && !isPublicMcpScope(conn.scope)) { try { sourceScope(this.deps.sourceResources ?? [], ctx, conn.pluginId, conn.scope, state.connectionMeta[conn.id]!.audience); return true; } catch { return false; } }
    if (conn.pluginId !== 'database') return true;
    try { return !!this.deps.database?.scope(ctx, conn.scope); } catch { return false; }
  }
  private valid(state: KnowledgeState, ctx: UserContext, evidence: Evidence): boolean {
    if (evidence.retrievedAt) return mcpEvidenceValid(state, ctx, evidence);
    const item = state.source.items.find(i => i.id === evidence.sourceId);
    return !!item && this.allowed(state, ctx, item) && evidenceValid(state, ctx, evidence);
  }
  private draftAllowed(state: KnowledgeState, ctx: UserContext, draft: Recommendation) {
    if (!draft.mcpScope) return true;
    const run = state.analyses.find(candidate => candidate.id === draft.mcpRunId);
    return !!run && mcpSelectionsCurrent(state, ctx, run);
  }
  private connectionAllowed(state: KnowledgeState, ctx: UserContext, connectionId: string): boolean {
    const conn = state.source.connections.find(c => c.id === connectionId), meta = state.connectionMeta[connectionId];
    if (!conn || !meta?.audience.includes(ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) return false;
    if (managedSource(conn.pluginId) && !isPublicMcpScope(conn.scope)) { try { sourceScope(this.deps.sourceResources ?? [], ctx, conn.pluginId, conn.scope, state.connectionMeta[conn.id]!.audience); return true; } catch { return false; } }
    if (conn.pluginId !== 'database') return true;
    try { return !!this.deps.database?.scope(ctx, conn.scope); } catch { return false; }
  }
  private plugin(state: KnowledgeState, pluginId: string, scope: Record<string, unknown> = {}): KnowledgeSourcePlugin {
    if (state.disabledPlugins.includes(pluginId)) throw new KnowledgeError('plugin_disabled', '知识源插件已暂停。', 409);
    if (pluginId === 'local-file') {
      const files = new Map<string, { name: string; bytes: Uint8Array; version: string; audience: string[] }[]>();
      for (const u of state.uploads) files.set(u.connectionId, [...files.get(u.connectionId) ?? [], { ...u, bytes: Buffer.from(u.text) }]);
      return createLocalFilePlugin(files);
    }
    if (pluginId === 'mcp' && isPublicMcpScope(scope)) return this.publicMcp.plugin;
    if (pluginId === 'database') { if (this.deps.database) return this.deps.database.plugin; throw new KnowledgeError('connector_not_configured', '需要由管理员配置独立只读数据库账号与授权视图。', 503); }
    const plugin = this.deps.plugins?.[pluginId];
    if (!plugin) throw new KnowledgeError('connector_not_configured', '此来源需要独立配置连接凭据与只读授权。模型 API Key 不能代替来源授权。', 503); return plugin;
  }
  private recommendationView(s: KnowledgeState, ctx: UserContext) {
    const recs = s.recommendations.filter(r => !r.deleted && this.draftAllowed(s, ctx, r)).flatMap(r => {
      const valid = r.origin === 'manual' || r.evidence.length > 0 && r.evidence.every(e => this.valid(s, ctx, e));
      const identityAllowed = r.humanLocked && r.evidence.length > 0 && r.evidence.every(e => {
        const old = s.source.items.find(i => i.id === e.sourceId);
        const current = old && s.source.items.find(i => i.current && i.connectionId === old.connectionId && i.externalId === old.externalId);
        return !!current && this.allowed(s, ctx, current, false);
      });
      if (!valid && !identityAllowed) return [];
      return [{ ...r, stale: !valid, evidence: valid ? r.evidence : [], workflow: valid ? r.workflow : undefined, proposedChange: r.proposedChange?.evidence.every(e => this.valid(s, ctx, e)) ? r.proposedChange : undefined }];
    });
    const objectKey = (scope: string | undefined, key: string) => JSON.stringify([scope, key]);
    const objectKeys = new Set(recs.filter(r => r.kind === 'object').map(r => objectKey(r.mcpScope, r.key)));
    const visibleRecs = recs.filter(r => r.kind !== 'relation' || r.relation && objectKeys.has(objectKey(r.mcpScope, r.relation.from)) && objectKeys.has(objectKey(r.mcpScope, r.relation.to)));
    return {
      recommendations: visibleRecs.filter(r => !r.mcpScope),
      mcpRecommendations: visibleRecs.filter(r => r.mcpScope).map(({ mcpScope: _, mcpRunId: _run, ...draft }) => draft),
    };
  }
  async recommendations(ctx: UserContext) {
    return this.recommendationView(await this.deps.repo.read(ctx), ctx);
  }
  async overview(ctx: UserContext) {
    const s = await this.deps.repo.read(ctx);
    const modelReadiness = await this.modelReadiness(ctx);
    const analysisReadiness = this.deps.enqueue ? modelReadiness : { ready: false as const, code: 'analysis_unavailable' };
    const refining = !!this.deps.model?.profile && modelReadiness.ready;
    const items = s.source.items.filter(i => this.allowed(s, ctx, i, false));
    return {
      spaceName: s.spaceName,
      mcpConnections: this.deps.liveMcp?.list(s, ctx),
      analysisReadiness,
      sourceResources: (this.deps.sourceResources ?? []).filter(r => r.audience.includes(ctx.userId) && r.projectIds.every(p => ctx.projectScopes.includes(p))).map(({ audience: _, ...r }) => ({ ...r, scope: publicSourceScope(r) })),
      plugins: MANIFESTS.map(m => ({ ...m, installed: true, builtIn: true, enabled: !s.disabledPlugins.includes(m.id), configured: m.id === 'local-file' || m.id === 'mcp' || (m.id === 'database' && !!this.deps.database?.list(ctx).length) || !!this.deps.plugins?.[m.id] })),
      databaseResources: this.deps.database?.list(ctx) ?? [],
      connections: s.source.connections.filter(c => this.connectionAllowed(s, ctx, c.id)).map(c => ({ id: c.id, name: s.connectionMeta[c.id]!.name, pluginId: c.pluginId, status: c.status, scope: this.connectionScopeSummary(c.scope) })),
      items: items.map(i => ({ id: hash(i.id), title: i.title, version: i.version, status: i.status, confirmed: this.allowed(s, ctx, i), confirmedAt: this.allowed(s, ctx, i) ? s.confirmations[i.id]?.confirmedAt : undefined, locator: i.locator, pluginId: s.source.connections.find(c => c.id === i.connectionId)!.pluginId, profile: this.profileView(s, ctx, i, refining) })),
      analyses: s.analyses.filter(r => r.actor.userId === ctx.userId).map(run => ({
        id: run.id, status: run.status, stage: run.stage, signature: run.signature, createdAt: run.createdAt, error: run.error,
        mcpSources: run.mcpSources?.map(source => source.name), skippedRelations: run.skippedRelations,
      })),
      ...this.recommendationView(s, ctx),
      organizationConfirmedAt: s.organization?.confirmedAt,
      canConfirm: ctx.roles.some(role => role === 'owner' || role === 'admin'),
      parseJobs: s.parseJobs.filter(j => j.actor.userId === ctx.userId && s.connectionMeta[j.connectionId]?.audience.includes(ctx.userId) && s.connectionMeta[j.connectionId]!.projectIds.every(p => ctx.projectScopes.includes(p))).map(j => ({ id: j.id, name: j.name, status: j.status, error: j.error })),
    };
  }
  async createConnection(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '连接名称'), pluginId = bounded(input.pluginId, 80, '插件');
    if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '知识源插件不存在。');
    const audience = strings(input.audience, [ctx.userId]), projectIds = strings(input.projectIds);
    if (!audience.includes(ctx.userId) || !projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('scope_denied', '连接不能扩大当前账号的权限范围。', 403);
    if (input.credentialRef != null || input.effect !== undefined && input.effect !== 'read') throw new KnowledgeError('invalid_scope', '仅允许只读范围；不能在此提交凭据引用或写入效果。');
    if (pluginId !== 'local-file' && input.readOnlyAcknowledged !== true) throw new KnowledgeError('read_only_acknowledgement_required', '请先核对范围并确认独立只读授权。');
    const scope = input.scope ?? {};
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || JSON.stringify(scope).length > 8000) throw new KnowledgeError('invalid_scope', '来源范围无效。');
    if ('selectedExternalIds' in scope || ('effect' in scope && scope.effect !== 'read')) throw new KnowledgeError('invalid_scope', '来源范围不能包含导入选择或写入效果。');
    // Credential values are never accepted here; connector secrets are provisioned separately in Key Vault.
    if (/password|secret|token|api.?key|connection.?string/i.test(JSON.stringify(scope))) throw new KnowledgeError('secret_not_allowed', '来源范围中不能保存凭据。');
    if (pluginId === 'database' && Object.keys(scope).some(key => key !== 'resourceId')) throw new KnowledgeError('scope_denied', '数据库表、列、行数及项目范围由管理员的只读资源定义。', 403);
    return this.deps.repo.transact(ctx, async s => {
      const plugin = this.plugin(s, pluginId);
      const effective: Record<string, unknown> = pluginId === 'database' ? { ...this.deps.database!.scope(ctx, { ...scope as Record<string, unknown>, audience }) } : managedSource(pluginId) ? sourceScope(this.deps.sourceResources ?? [], ctx, pluginId, scope as Record<string, unknown>, audience) : scope as Record<string, unknown>;
      if (managedSource(pluginId)) effective.selectedExternalIds = [];
      const conn: Connection = { id: id(), pluginId, scope: effective, credentialRef: null, status: 'draft', cursor: null, confirmedBy: null };
      if (input.verify === true) {
        await this.verifyConnection(plugin, conn);
        conn.status = 'confirmed';
        conn.confirmedBy = ctx.userId;
      }
      s.source.connections.push(conn); s.connectionMeta[conn.id] = { name, audience, projectIds: [...new Set([...projectIds, ...((effective.projectIds as string[] | undefined) ?? [])])] }; return { ...conn, name };
    });
  }
  private connectionScopeSummary(scope: Record<string, unknown>): Record<string, unknown> {
    if (!isPublicMcpScope(scope)) return scope;
    const { mcpResources, ...summary } = scope;
    return { ...summary, mcpResourceCount: mcpResources.length };
  }
  private async verifyConnection(plugin: KnowledgeSourcePlugin, conn: { id: string; scope: Record<string, unknown>; credentialRef: string | null }) {
    try {
      const tested = await plugin.testConnection({ connectionId: conn.id, scope: conn.scope, credentialRef: conn.credentialRef });
      if (tested.ok) return;
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      // Connector errors may contain sensitive connection details.
    }
    throw new KnowledgeError('connection_test_failed', '来源连接测试未通过。', 409);
  }
  async connectPublicMcp(ctx: UserContext, input: Record<string, unknown>, verified?: { name: string; resources: { uri: string; title: string }[] }) {
    requireManager(ctx);
    const endpoint = publicMcpEndpoint(input.endpoint).href;
    if ((await this.deps.repo.read(ctx)).disabledPlugins.includes('mcp')) throw new KnowledgeError('plugin_disabled', 'MCP 来源已暂停。', 409);
    const { name, resources } = verified ?? await this.publicMcp.discover(endpoint);
    return this.deps.repo.transact(ctx, s => {
      if (s.disabledPlugins.includes('mcp')) throw new KnowledgeError('plugin_disabled', 'MCP 来源已暂停。', 409);
      const existing = s.source.connections.find(conn => conn.pluginId === 'mcp' && conn.scope.publicMcpEndpoint === endpoint && s.connectionMeta[conn.id]?.audience[0] === ctx.userId);
      const selected = new Set(Array.isArray(existing?.scope.selectedExternalIds) ? existing.scope.selectedExternalIds : []);
      const previouslySelected = resources.filter(resource => selected.has(resource.uri)).map(resource => resource.uri);
      const scope = {
        publicMcpEndpoint: endpoint, mcpResources: resources,
        mcpScopeHash: hash(JSON.stringify([endpoint, resources.map(resource => resource.uri).sort()])),
        audience: [ctx.userId], selectedExternalIds: previouslySelected,
      };
      const conn = existing ?? { id: id(), pluginId: 'mcp', scope, credentialRef: null, status: 'confirmed' as const, cursor: null, confirmedBy: ctx.userId };
      Object.assign(conn, { scope, status: 'confirmed', confirmedBy: ctx.userId });
      if (!existing) s.source.connections.push(conn);
      s.connectionMeta[conn.id] = { name, audience: [ctx.userId], projectIds: [] };
      invalidateAnalyses(s);
      return { id: conn.id, name, status: conn.status };
    });
  }
  async confirmConnection(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      await this.verifyConnection(this.plugin(s, conn.pluginId, conn.scope), conn);
      conn.status = 'confirmed'; conn.confirmedBy = ctx.userId; invalidateAnalyses(s); return { id: conn.id, status: conn.status };
    });
  }
  private scopedPlugin(state: KnowledgeState, pluginId: string, scope: Record<string, unknown>, ctx: UserContext): KnowledgeSourcePlugin {
    const plugin = this.plugin(state, pluginId, scope);
    return { ...plugin,
      async listItems(cfg, cursor) { const batch = await plugin.listItems(cfg, cursor); return { ...batch, items: batch.items.filter(ref => selectedItem(cfg.scope, ref.externalId, pluginId !== 'mcp')) }; },
      async getAcl(cfg, ref) {
        const acl = await plugin.getAcl?.(cfg, ref);
        // Re-evaluate at the body-read boundary: a preview grant may have been revoked meanwhile.
        return acl?.status === 'known' && acl.entries.some(e => e.principal === ctx.userId && e.access === 'read') ? acl : { status: 'unknown', reason: 'sync actor lacks current source permission' };
      },
    };
  }
  private async checkLiveAcl(state: KnowledgeState, ctx: UserContext, item: Item) {
    const conn = state.source.connections.find(c => c.id === item.connectionId)!;
    if (conn.pluginId === 'local-file') return;
    const acl = await this.plugin(state, conn.pluginId, conn.scope).getAcl?.({ connectionId: conn.id, scope: conn.scope, credentialRef: conn.credentialRef }, { externalId: item.externalId, version: item.version, title: item.title, locator: item.locator, change: 'upsert' });
    if (acl?.status !== 'known' || !acl.entries.some(e => e.principal === ctx.userId && e.access === 'read')) throw new KnowledgeError('source_denied', '来源权限已变化，不能确认或读取当前资料。', 403);
  }
  private async sourcePreview(state: KnowledgeState, ctx: UserContext, connectionId: string) {
    const conn = state.source.connections.find(c => c.id === connectionId);
    if (!conn || !this.connectionAllowed(state, ctx, connectionId) || !managedSource(conn.pluginId)) throw new KnowledgeError('source_denied', '当前来源范围不可预览。', 403);
    const plugin = this.plugin(state, conn.pluginId, conn.scope), cfg = { connectionId, scope: conn.scope, credentialRef: conn.credentialRef };
    const batch = await plugin.listItems(cfg, undefined);
    const eligible: { id: string; externalId: string; title: string; version: string; locator: string; selected: boolean }[] = [];
    let blocked = 0;
    if (batch.items.length > 1000) throw new KnowledgeError('preview_limit', '资料超过预览上限，请缩小授权范围。', 409);
    for (const ref of batch.items) {
      if (ref.change === 'deleted' || ref.change === 'access_revoked') { blocked++; continue; }
      const acl = await plugin.getAcl?.(cfg, ref);
      if (acl?.status !== 'known' || !acl.entries.some(e => e.principal === ctx.userId && e.access === 'read')) { blocked++; continue; }
      eligible.push({ id: hash(JSON.stringify([connectionId, ref.externalId, ref.version])), externalId: ref.externalId, title: ref.title, version: ref.version, locator: ref.locator, selected: selectedItem(conn.scope, ref.externalId, conn.pluginId !== 'mcp') });
    }
    return { conn, eligible, blocked };
  }
  async previewConnection(ctx: UserContext, connectionId: string) {
    const state = await this.deps.repo.read(ctx), { conn, eligible, blocked } = await this.sourcePreview(state, ctx, connectionId);
    return { connectionId, name: state.connectionMeta[connectionId]!.name, pluginId: conn.pluginId, status: conn.status, scope: this.connectionScopeSummary(conn.scope), items: eligible.map(({externalId: _, ...item}) => item), blocked };
  }
  async importSelection(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    requireManager(ctx); const ids = strings(input.ids);
    if (!ids.length) throw new KnowledgeError('invalid_selection', '请选择有权限的资料。');
    await this.deps.repo.transact(ctx, async s => {
      const {conn, eligible} = await this.sourcePreview(s, ctx, connectionId);
      if (conn.status !== 'confirmed') throw new KnowledgeError('connection_unconfirmed', '先确认来源连接。', 409);
      if (ids.some(id => !eligible.some(ref => ref.id === id))) throw new KnowledgeError('source_denied', '选择包含无权读取或版本已变化的资料。', 403);
      const selection = eligible.filter(ref => ids.includes(ref.id)).map(ref => ref.externalId);
      if (JSON.stringify(selection) !== JSON.stringify(conn.scope.selectedExternalIds)) {
        conn.scope = { ...conn.scope, selectedExternalIds: selection }; conn.cursor = null;
        for (const item of s.source.items.filter(item => item.connectionId === connectionId)) delete s.confirmations[item.id];
        invalidateAnalyses(s);
      }
    });
    return this.sync(ctx, connectionId);
  }
  async renameSpace(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '知识空间名称');
    return this.deps.repo.transact(ctx, s => { s.spaceName = name; return { name }; });
  }
  async createManualRole(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '角色名称'), description = bounded(input.description, 4000, '角色说明');
    return this.deps.repo.transact(ctx, s => { const role = { id: id(), key: `manual-${id()}`, kind: 'employee' as const, origin: 'manual' as const, name, description, evidence: [], humanLocked: true, deleted: false }; s.recommendations.push(role); return role; });
  }
  async installPlugin(ctx: UserContext, pluginId: string) {
    requireManager(ctx); if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '插件不存在。');
    return { installed: true };
  }
  async sync(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      if (conn.status !== 'confirmed') throw new KnowledgeError('connection_unconfirmed', '先测试并确认连接范围。', 409);
      const store = hydrate(s.source), result = await syncConnection(store, this.scopedPlugin(s, conn.pluginId, conn.scope, ctx), connectionId);
      s.source = snapshot(store);
      if (result.error) { const current = s.source.connections.find(c => c.id === connectionId)!; if (current.status !== 'needs_reauth') current.status = 'sync_failed'; }
      invalidateAnalyses(s); return { ...result, error: result.error ? '来源同步失败；资料暂停使用，检查授权后重试。' : undefined };
    });
  }
  async upload(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const connectionId = bounded(input.connectionId, 100, '连接'), name = bounded(input.name, 180, '文件名'), text = bounded(input.text, 200_000, '文件内容');
    if (!/\.(txt|md|markdown|csv)$/i.test(name) || /[\\/\x00-\x1f]/.test(name)) throw new KnowledgeError('unsupported_file', '此入口支持 TXT、Markdown 和 CSV 文件。');
    await this.deps.repo.transact(ctx, s => {
      const conn = s.source.connections.find(c => c.id === connectionId), meta = s.connectionMeta[connectionId];
      if (!conn || conn.pluginId !== 'local-file' || !meta?.audience.includes(ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('not_found', '本地文件连接不存在。', 404);
      s.uploads = s.uploads.filter(u => u.connectionId !== connectionId || u.name !== name);
      if (s.uploads.length >= 200) throw new KnowledgeError('corpus_limit', '试点资料数已达到上限。', 409);
      s.uploads.push({ connectionId, name, text, version: hash(text), audience: meta.audience });
      // Source content changed: withdraw confirmation in the same transaction as accepting the new upload.
      for (const item of s.source.items.filter(i => i.connectionId === connectionId && i.externalId === name && i.contentHash !== hash(text))) delete s.confirmations[item.id];
      invalidateAnalyses(s);
    });
    return this.sync(ctx, connectionId);
  }
  async uploadBinary(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); if (!this.deps.binary) throw new KnowledgeError('parser_unavailable', 'Azure 文档解析和文件存储尚未配置。', 503);
    return queueBinaryUpload(this.deps.repo, this.deps.binary, ctx, input);
  }
  private automaticLocalConnection(state: KnowledgeState, ctx: UserContext): string {
    if (state.disabledPlugins.includes('local-file')) throw new KnowledgeError('plugin_disabled', '本地上传已暂停。', 409);
    const existing = state.source.connections.find(c => {
      const meta = state.connectionMeta[c.id];
      return c.pluginId === 'local-file' && meta?.localUpload && meta.audience[0] === ctx.userId;
    });
    if (existing) {
      if (existing.status !== 'confirmed') throw new KnowledgeError('source_denied', '本地上传来源暂不可用。', 403);
      return existing.id;
    }
    const connectionId = id();
    state.source.connections.push({ id: connectionId, pluginId: 'local-file', scope: {}, credentialRef: null, status: 'confirmed', cursor: null, confirmedBy: ctx.userId });
    state.connectionMeta[connectionId] = { name: '本地上传', audience: [ctx.userId], projectIds: [], localUpload: true };
    return connectionId;
  }
  async uploadLocal(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx);
    const name = bounded(input.name, 180, '文件名');
    if (/[\\/\x00-\x1f]/.test(name)) throw new KnowledgeError('invalid_file', '文件名无效。');
    if (input.text === undefined && /\.xlsm$/i.test(name)) {
      return this.publishLocalContent(ctx, name, await parseMacroWorkbook(decodeUpload(input.base64), name));
    }
    const mime = input.text === undefined ? mimeFor(name) : null;
    if (mime) {
      if (!this.deps.binary) throw new KnowledgeError('parser_unavailable', 'Azure 文档解析和文件存储尚未配置。', 503);
      const bytes = decodeUpload(input.base64);
      const connectionId = await this.deps.repo.transact(ctx, s => this.automaticLocalConnection(s, ctx));
      const job = await queueDocument(this.deps.repo, this.deps.binary, ctx, connectionId, name, bytes, mime);
      return { status: job.status === 'completed' ? 'ready' : 'processing', jobId: job.id };
    }

    let decoded = input.text;
    if (decoded === undefined) {
      const bytes = decodeUpload(input.base64);
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      try { decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { throw new KnowledgeError('unsupported_file', '无法读取此文件格式。'); }
    }
    if (typeof decoded === 'string' && decoded.length > 200_000) throw new KnowledgeError('text_too_large', '提取出的文本超过大小限制。', 413);
    const text = typeof decoded === 'string' ? decoded : '';
    if (!text.trim()) throw new KnowledgeError('unreadable_file', '未能读取资料内容。', 422);
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new KnowledgeError('unsupported_file', '无法读取此文件格式。');
    return this.publishLocalContent(ctx, name, textWithLineAnchors(text, name));
  }
  private async publishLocalContent(ctx: UserContext, name: string, content: SourceContent) {
    return this.deps.repo.transact(ctx, async s => {
      const connectionId = this.automaticLocalConnection(s, ctx);
      const store = hydrate(s.source);
      if (!store.currentItem(connectionId, name) && s.source.items.filter(item => item.current && item.connectionId === connectionId).length >= 200) {
        throw new KnowledgeError('corpus_limit', '试点资料数已达到上限。', 409);
      }
      const plugin = createLocalFilePlugin(new Map([[connectionId, [{ name, content, version: hash(content.text), audience: [ctx.userId] }]]]));
      const result = await syncConnection(store, plugin, connectionId);
      const item = store.currentItem(connectionId, name);
      if (result.error || !item || item.status !== 'parsed') throw new KnowledgeError('unreadable_file', '未能读取资料内容。', 422);
      for (const job of s.parseJobs.filter(j => j.connectionId === connectionId && j.name === name && ['queued', 'running'].includes(j.status))) {
        job.status = 'failed'; job.error = 'superseded';
      }
      s.source = snapshot(store);
      confirmSource(s, ctx, item.id, item.version);
      return { status: 'ready' as const };
    });
  }
  private async requireModelReady(ctx: UserContext) {
    const { model } = this.deps;
    if (!model) throw new KnowledgeError('analysis_unavailable', '分析模型暂时不可用。', 503);
    try { await model.check?.(ctx.tenantId); }
    catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('analysis_check_failed', '暂时无法检查分析模型，稍后重试。', 503);
    }
  }
  private async modelReadiness(ctx: UserContext) {
    try {
      await this.requireModelReady(ctx);
      return { ready: true as const };
    } catch (error) {
      return { ready: false as const, code: error instanceof KnowledgeError ? error.code : 'analysis_check_failed' };
    }
  }
  private profileView(s: KnowledgeState, ctx: UserContext, item: Item, modelReady = false) {
    const p = s.profiles?.[item.id];
    if (!p || p.version !== item.version) return null;
    const target = p.related && s.source.items.find(i => i.id === p.related!.sourceId);
    // A related pointer is shown only when this viewer may read the other material (an earlier revision of the same file is always theirs).
    const related = p.related && target && (p.related.kind === 'update' || this.allowed(s, ctx, target, false)) ? { id: hash(target.id), kind: p.related.kind, title: s.profiles[target.id]?.title ?? target.title, confirmed: p.related.kind === 'update' ? !!target.confirmedVersion : this.allowed(s, ctx, target) } : null;
    return { title: p.title, category: p.category, summary: p.summary, origin: p.origin, refining: p.refine === 'pending' && modelReady, related };
  }
  /** One reviewed list, one click: each version is still checked against its own source permission and version. */
  async confirmMany(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx);
    const entries = input.items;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100 || entries.some(e => !e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.version !== 'string')) throw new KnowledgeError('invalid_input', '请选择 1 到 100 份资料。');
    return this.deps.repo.transact(ctx, async s => {
      const failed: { id: string; error: string }[] = []; let confirmed = 0;
      for (const { id: sourceId, version } of entries as { id: string; version: string }[]) {
        try {
          const item = s.source.items.find(i => hash(i.id) === sourceId);
          if (!item || !this.allowed(s, ctx, item, false)) throw new KnowledgeError('source_denied', '当前资料权限不足。', 403);
          await this.checkLiveAcl(s, ctx, item); confirmSource(s, ctx, item.id, version); confirmed++;
        } catch (error) { failed.push({ id: sourceId, error: error instanceof KnowledgeError ? error.message : '确认失败。' }); }
      }
      return { confirmed, failed };
    });
  }
  async editProfile(ctx: UserContext, sourceId: string, input: Record<string, unknown>) {
    requireManager(ctx);
    const title = bounded(input.title, 120, '标题'), category = input.category as Category;
    if (!CATEGORIES.includes(category)) throw new KnowledgeError('invalid_input', '分类无效。');
    return this.deps.repo.transact(ctx, s => {
      const item = s.source.items.find(i => hash(i.id) === sourceId);
      const profile = item && s.profiles[item.id];
      if (!item || !profile || !this.allowed(s, ctx, item, false)) throw new KnowledgeError('not_found', '当前资料不可编辑。', 404);
      Object.assign(profile, { title: title.trim(), category, origin: 'human', refine: 'done' }); return { id: sourceId, title: profile.title, category };
    });
  }
  async confirm(ctx: UserContext, sourceId: string, version: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => { const item = s.source.items.find(i => i.id === sourceId || hash(i.id) === sourceId); if (!item || !this.allowed(s, ctx, item, false)) throw new KnowledgeError('source_denied', '当前资料权限不足。', 403); await this.checkLiveAcl(s, ctx, item); confirmSource(s, ctx, item.id, version); return { confirmed: true }; });
  }
  async preview(ctx: UserContext, sourceId: string, version: string, { confirmedOnly = false } = {}) {
    const state = await this.deps.repo.read(ctx), item = state.source.items.find(i => hash(i.id) === sourceId || i.id === sourceId);
    if (!item || !this.allowed(state, ctx, item, confirmedOnly)) throw new KnowledgeError('not_found', '当前资料不可读取。', 404);
    await this.checkLiveAcl(state, ctx, item);
    if (item.version !== version) throw new KnowledgeError('version_changed', '资料版本已变化，请刷新后核对。', 409);
    let remaining = 200_000;
    const chunks = positionedChunks(state, item).flatMap(c => { if (remaining <= 0) return []; const text = c.text.slice(0, remaining); remaining -= text.length; return [{ text, locator: c.locator, start: c.start, end: c.start + text.length }]; });
    return { id: hash(item.id), title: item.title, version: item.version, locator: item.locator, chunks, truncated: remaining === 0 };
  }
  async search(ctx: UserContext, query: string, { checkSourceAccess = false } = {}): Promise<{ answer: string; hits: SearchHit[] }> {
    bounded(query, 200, '检索词'); const hits = await this.deps.repo.search(ctx, query.trim(), 12);
    // Recheck live state before returning citations; projection and mutation commit atomically in PG.
    const state = await this.deps.repo.read(ctx);
    let valid = hits.filter(e => this.valid(state, ctx, e));
    if (checkSourceAccess && valid.length) {
      const sourceIds = new Set(valid.map(hit => hit.sourceId));
      const readable = new Set<string>();
      await Promise.all(state.source.items.filter(item => sourceIds.has(item.id)).map(async item => {
        try {
          await this.checkLiveAcl(state, ctx, item);
          readable.add(item.id);
        } catch {
          // Deny the source if access was revoked or its connector cannot verify the permission.
        }
      }));
      const current = await this.deps.repo.read(ctx);
      valid = valid.filter(hit => readable.has(hit.sourceId) && this.valid(current, ctx, hit));
    }
    return { answer: valid.length ? valid.map(e => `${e.quote}\n[${e.locator}]`).join('\n\n') : '无依据', hits: valid };
  }
  async startAnalysis(ctx: UserContext, input: Record<string, unknown> = {}) {
    requireManager(ctx);
    const { enqueue } = this.deps;
    if (!enqueue) throw new KnowledgeError('analysis_unavailable', '分析工作队列暂时不可用。', 503);
    const ids = input.mcpSourceIds ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_MCP_ANALYSIS_SOURCES || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
      throw new KnowledgeError('mcp_analysis_sources_invalid', '每次可选择最多 5 个 MCP 来源。');
    }
    const focus = input.focus === undefined ? undefined : bounded(input.focus, 1000, '分析重点').trim();
    if (ids.length && !this.deps.liveMcp) throw new KnowledgeError('mcp_unavailable', 'MCP 知识连接暂时不可用。', 503);
    await this.requireModelReady(ctx);
    const run = await this.deps.repo.transact(ctx, s => {
      const mcpSources = [...new Set<string>(ids)].map(id => {
        const source = liveMcpSelection(s, ctx, id);
        if (!source) throw new KnowledgeError('mcp_analysis_scope_changed', 'MCP 来源已变化，请重新选择。', 409);
        return source;
      });
      if (!mcpSources.length && !s.source.items.some(i => this.allowed(s, ctx, i))) throw new KnowledgeError('no_evidence', '请添加资料或连接 MCP 来源。', 409);
      if (s.analyses.some(r => r.actor.userId === ctx.userId && ['queued', 'running'].includes(r.status))) throw new KnowledgeError('analysis_active', '已有分析任务正在运行。', 409);
      const run = { id: id(), actor: ctx, status: 'queued' as const, stage: 'parse' as const, signature: signature(s, ctx), createdAt: stamp(), error: null, ...(mcpSources.length && { mcpSources }), focus };
      s.analyses.push(run); return run;
    });
    await enqueue(ctx, run.id); return { id: run.id, status: 'queued', stage: run.stage };
  }
  async editRecommendation(ctx: UserContext, recId: string, input: Record<string, unknown>, remove = false) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, s => {
      const r = s.recommendations.find(r => r.id === recId && !r.deleted && this.draftAllowed(s, ctx, r) && (remove || (r.origin === 'manual' || r.evidence.length > 0 && r.evidence.every(e => this.valid(s, ctx, e)))));
      if (!r) throw new KnowledgeError('not_found', '当前有效建议不存在。', 404);
      if (remove) {
        r.deleted = true;
        // A deleted tool or SOP draft no longer appears in any role's assignment.
        if (r.kind === 'tool' || r.kind === 'sop') for (const other of s.recommendations) if (other.assignment) other.assignment = {
          tools: other.assignment.tools.filter(k => !(r.kind === 'tool' && k === r.key)), sops: other.assignment.sops.filter(k => !(r.kind === 'sop' && k === r.key)),
        };
      } else {
        r.name = bounded(input.name, 160, '名称'); r.description = bounded(input.description, 4000, '说明'); r.humanLocked = true;
        if (r.kind === 'employee') {
          if (input.prompt !== undefined) r.prompt = typeof input.prompt === 'string' && input.prompt.trim() ? bounded(input.prompt, 8000, '提示词') : undefined;
          if (input.assignment !== undefined) r.assignment = this.assignmentInput(s, ctx, input.assignment);
        }
      }
      return { id: r.id, deleted: r.deleted, humanLocked: r.humanLocked };
    });
  }
  private assignmentInput(s: KnowledgeState, ctx: UserContext, value: unknown): { tools: string[]; sops: string[] } {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!v || !Array.isArray(v.tools) || !Array.isArray(v.sops) || v.tools.length > 30 || v.sops.length > 30) throw new KnowledgeError('invalid_input', '分工结构无效。');
    const live = (kind: 'tool' | 'sop') => new Set(s.recommendations.filter(r => r.kind === kind && !r.deleted && this.draftAllowed(s, ctx, r)).map(r => r.key));
    const pick = (list: unknown[], kind: 'tool' | 'sop') => { const known = live(kind); return [...new Set(list.filter((k): k is string => typeof k === 'string' && known.has(k)))]; };
    return { tools: pick(v.tools, 'tool'), sops: pick(v.sops, 'sop') };
  }
  /** Merge one role draft into another: the target keeps its name and duty and takes over the source's tools and SOPs. */
  async mergeRecommendation(ctx: UserContext, recId: string, input: Record<string, unknown>) {
    requireManager(ctx);
    const intoId = bounded(input.into, 100, '合并目标');
    return this.deps.repo.transact(ctx, s => {
      const live = (rid: string) => s.recommendations.find(r => r.id === rid && !r.deleted && r.kind === 'employee' && this.draftAllowed(s, ctx, r));
      const from = live(recId), into = live(intoId);
      if (!from || !into || from.id === into.id) throw new KnowledgeError('not_found', '要合并的岗位草案不存在。', 404);
      const a = from.assignment ?? { tools: [], sops: [] }, b = into.assignment ?? { tools: [], sops: [] };
      into.assignment = { tools: [...new Set([...b.tools, ...a.tools])], sops: [...new Set([...b.sops, ...a.sops])] };
      into.humanLocked = true;
      from.deleted = true; from.mergedInto = into.id;
      return { id: into.id, merged: from.id };
    });
  }
  private organizationDraft(s: KnowledgeState, ctx: UserContext) {
    const view = this.recommendationView(s, ctx);
    const all: (Recommendation & { stale: boolean; privateSource?: true })[] = [...view.recommendations, ...view.mcpRecommendations.map(r => ({ ...r, privateSource: true as const }))];
    const fresh = all.filter(r => !r.stale);
    const employees = fresh.filter(r => r.kind === 'employee'), tools = fresh.filter(r => r.kind === 'tool'), sops = fresh.filter(r => r.kind === 'sop');
    const toolKeys = new Set(tools.map(t => t.key)), sopKeys = new Set(sops.map(t => t.key));
    const org = s.organization;
    return {
      employees: employees.map(e => ({
        id: e.id, key: e.key, name: e.name, duty: e.description, prompt: e.prompt ?? defaultPrompt(e.name, e.description),
        promptEdited: !!e.prompt, origin: e.origin ?? 'inferred', humanLocked: e.humanLocked, evidence: e.evidence, privateSource: !!e.privateSource,
        tools: (e.assignment?.tools ?? []).filter(k => toolKeys.has(k)), sops: (e.assignment?.sops ?? []).filter(k => sopKeys.has(k)),
        employeeId: org?.employees[e.id]?.employeeId ?? null,
      })),
      tools: tools.map(t => {
        const confirmed = org?.tools[t.id];
        const match = confirmed ? null : this.deps.organization?.matchTool(t.name, t.description) ?? null;
        return {
          id: t.id, key: t.key, name: t.name, description: t.description, evidence: t.evidence, privateSource: !!t.privateSource,
          toolId: confirmed?.toolId ?? match?.toolId ?? null, match: confirmed?.match ?? (match ? 'existing' as const : 'placeholder' as const), matchName: match?.name ?? null,
        };
      }),
      sops: sops.map(p => ({ id: p.id, key: p.key, name: p.name, description: p.description, evidence: p.evidence, privateSource: !!p.privateSource })),
    };
  }
  private organizationBlock(s: KnowledgeState, ctx: UserContext, employees: number): 'analysis_running' | 'analysis_stale' | 'no_employees' | null {
    const latest = s.analyses.filter(r => r.actor.userId === ctx.userId).at(-1);
    if (latest && ['queued', 'running'].includes(latest.status)) return 'analysis_running';
    if (latest?.status === 'stale') return 'analysis_stale';
    return employees ? null : 'no_employees';
  }
  /**
   * Re-creates, in this process's registries, the employees and tool placeholders a confirmation recorded — after a
   * restart or on another web process sharing the tenant document. Same ids, same name/duty/prompt; no document write.
   */
  restoreOrganization(s: KnowledgeState): number {
    const sink = this.deps.organization, org = s.organization;
    if (!sink || !org) return 0;
    let restored = 0;
    for (const [recId, e] of Object.entries(org.employees)) {
      if (sink.present('employee', e.employeeId)) continue;
      sink.ensureEmployee({ recId, name: e.name, duty: e.duty, prompt: e.prompt, owner: org.confirmedBy, manual: false });
      restored++;
    }
    for (const [recId, t] of Object.entries(org.tools)) {
      if (t.match !== 'placeholder' || sink.present('tool', t.toolId)) continue;
      sink.ensureToolPlaceholder({ recId, name: t.name, purpose: t.purpose ?? t.name, consumers: t.consumers ?? [], maintainer: org.confirmedBy });
      restored++;
    }
    return restored;
  }
  /** Startup hook: restore every confirmed organization of these tenants into the registries of this process. */
  async restoreOrganizations(tenantIds: string[]): Promise<number> {
    let restored = 0;
    for (const tenantId of tenantIds) restored += this.restoreOrganization(await this.deps.repo.read({ tenantId, userId: 'system:restore', roles: [], projectScopes: [] }));
    return restored;
  }
  /** Organization draft (PRD §3.3 step 3): roles, the tools they use and the SOPs they take part in, plus confirmation state. */
  async organization(ctx: UserContext) {
    const s = await this.deps.repo.read(ctx);
    this.restoreOrganization(s);
    const draft = this.organizationDraft(s, ctx), org = s.organization;
    const missing = org ? Object.values(org.employees).filter(e => !this.deps.organization?.present('employee', e.employeeId)).length : 0;
    const changed = !!org && draft.employees.some(e => {
      const done = org.employees[e.id];
      return !done || done.name !== e.name || done.duty !== e.duty || done.prompt !== e.prompt;
    }) || draft.tools.some(t => !org?.tools[t.id]) || (!!org && Object.keys(org.employees).some(recId => !draft.employees.some(e => e.id === recId)));
    return {
      ...draft,
      teamPlan: this.teamPlanView(s, ctx),
      confirmation: org ? { confirmedAt: org.confirmedAt, confirmedBy: org.confirmedBy, revision: org.revision, employees: Object.keys(org.employees).length, tools: Object.keys(org.tools).length } : null,
      changedSinceConfirmation: changed, missing,
      blocked: this.organizationBlock(s, ctx, draft.employees.length),
      canConfirm: ctx.roles.some(role => role === 'owner' || role === 'admin') && !!this.deps.organization,
    };
  }
  /**
   * "确认组织": creates one unconnected employee per role draft and a tool placeholder per missing capability.
   * Ids derive from draft ids and are recorded in the knowledge document, so a repeat (or retried) confirmation reuses them.
   */
  async confirmOrganization(ctx: UserContext) {
    requireManager(ctx);
    const sink = this.deps.organization;
    if (!sink) throw new KnowledgeError('organization_unavailable', '数字员工服务暂不可用。', 503);
    return this.deps.repo.transact(ctx, s => {
      const draft = this.organizationDraft(s, ctx), block = this.organizationBlock(s, ctx, draft.employees.length);
      if (block === 'analysis_running') throw new KnowledgeError(block, '分析仍在进行，完成后再确认组织。', 409);
      if (block === 'analysis_stale') throw new KnowledgeError(block, '资料在分析期间发生变化，请重新分析后再确认。', 409);
      if (block === 'no_employees') throw new KnowledgeError(block, '组织草案里还没有岗位。', 409);
      const org = s.organization ?? { confirmedAt: '', confirmedBy: '', revision: 0, employees: {}, tools: {} };
      let createdEmployees = 0, createdTools = 0;
      for (const e of draft.employees) {
        const result = sink.ensureEmployee({ recId: e.id, name: e.name, duty: e.duty, prompt: e.prompt, owner: ctx.userId, manual: e.origin === 'manual' });
        if (result.created && !org.employees[e.id]) createdEmployees++;
        org.employees[e.id] = { employeeId: result.employeeId, name: e.name, duty: e.duty, prompt: e.prompt };
        (org.created ??= {})[result.employeeId] = e.name;
      }
      // Roles that left the draft (merged, deleted, replaced by a team plan) leave the confirmed team too. That also
      // covers employees an earlier confirmation created that no record points at any more (e.g. from before roles
      // were retired). Someone with work in progress cannot be removed; they are reported, not silently kept.
      let retiredEmployees = 0;
      const busyEmployees: string[] = [];
      for (const [recId, done] of Object.entries(org.employees)) {
        if (draft.employees.some(e => e.id === recId)) continue;
        if (sink.retireEmployee?.(done.employeeId) ?? true) { delete org.employees[recId]; retiredEmployees++; }
        else busyEmployees.push(done.name);
      }
      // Only this tenant's own employees are candidates: those its confirmations recorded, and the ids its own
      // role drafts map to (covers confirmations from before the record existed). The registry itself is shared.
      const current = new Set(Object.values(org.employees).map(e => e.employeeId));
      const mine = new Map<string, string>(Object.entries(org.created ?? {}));
      for (const r of s.recommendations) if (r.kind === 'employee') { const id = orgEmployeeId(r.id); if (!mine.has(id)) mine.set(id, r.name); }
      for (const [id, name] of mine) {
        if (current.has(id) || !sink.present('employee', id)) { if (!current.has(id)) delete org.created?.[id]; continue; }
        if (sink.retireEmployee?.(id) ?? false) { retiredEmployees++; delete org.created?.[id]; }
        else busyEmployees.push(name);
      }
      for (const t of draft.tools) {
        const known = org.tools[t.id];
        if (known?.match === 'existing') continue;
        const match = known ? null : sink.matchTool(t.name, t.description);
        if (match) { org.tools[t.id] = { toolId: match.toolId, name: t.name, match: 'existing' }; continue; }
        const consumers = draft.employees.filter(e => e.tools.includes(t.key)).map(e => org.employees[e.id]!.employeeId);
        const placeholder = sink.ensureToolPlaceholder({ recId: t.id, name: t.name, purpose: t.description, consumers, maintainer: ctx.userId });
        if (placeholder.created && !known) createdTools++;
        org.tools[t.id] = { toolId: placeholder.toolId, name: t.name, match: 'placeholder', purpose: t.description.slice(0, 1000), consumers };
      }
      Object.assign(org, { confirmedAt: stamp(), confirmedBy: ctx.userId, revision: org.revision + 1 });
      s.organization = org;
      return { revision: org.revision, employees: Object.values(org.employees), tools: Object.values(org.tools), createdEmployees, createdTools, retiredEmployees, busyEmployees };
    });
  }
  private planSources(s: KnowledgeState, ctx: UserContext) {
    const draft = this.organizationDraft(s, ctx);
    const roles: PlanSourceRole[] = draft.employees.map(e => ({ id: e.id, name: e.name, duty: e.duty, tools: e.tools, sops: e.sops, edited: e.humanLocked }));
    return { draft, roles, basis: roles.map(r => r.id).sort() };
  }
  private teamPlanView(s: KnowledgeState, ctx: UserContext) {
    const plan = s.teamPlan;
    if (!plan || plan.createdBy !== ctx.userId) return null;
    const { roles, basis } = this.planSources(s, ctx);
    const stale = JSON.stringify(basis) !== JSON.stringify(plan.basis);
    return { ...plan, stale, replaces: roles.length, editedReplaced: roles.filter(r => r.edited).length };
  }
  /**
   * "按人数重新规划": proposes exactly `count` roles from the current role drafts. The super agent (analysis model)
   * merges or splits; without a model, shrinking falls back to merging the roles that share the most work.
   * The proposal is stored for preview only — nothing changes until the owner adopts it.
   */
  async planTeam(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx);
    const count = input.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > TEAM_SIZE_MAX) throw new KnowledgeError('invalid_team_size', `团队规模必须是 1 到 ${TEAM_SIZE_MAX} 之间的整数。`);
    const state = await this.deps.repo.read(ctx);
    const { draft, roles, basis } = this.planSources(state, ctx);
    if (!roles.length) throw new KnowledgeError('no_employees', '组织草案里还没有岗位。', 409);
    if (count === roles.length) throw new KnowledgeError('team_size_unchanged', '团队已经是这个人数。', 409);
    const toolKeys = draft.tools.map(t => t.key), sopKeys = draft.sops.map(p => p.key);
    let planned: PlanRole[] | null = null, method: TeamPlan['method'] = 'model', modelError: string | null = null;
    const model = this.deps.model;
    if (model?.planTeam) {
      try {
        await this.requireModelReady(ctx);
        const output = await model.planTeam({
          tenantId: ctx.tenantId, taskId: id(), target: count, maxOutputTokens: 6000,
          roles: roles.map(({ edited: _, ...r }) => r),
          tools: draft.tools.map(t => ({ key: t.key, name: t.name, description: t.description })),
          sops: draft.sops.map(p => ({ key: p.key, name: p.name, description: p.description })),
        });
        planned = validateTeamPlan(output, { target: count, roles, toolKeys, sopKeys });
      } catch (error) {
        modelError = error instanceof TeamPlanError ? error.code : error instanceof KnowledgeError ? error.code : 'plan_model_failed';
      }
    } else modelError = 'analysis_unavailable';
    if (!planned) {
      if (count > roles.length) throw new KnowledgeError(modelError === 'analysis_unavailable' || modelError?.startsWith('llm_') || modelError === 'model_not_selected' ? 'split_needs_model' : 'plan_failed',
        modelError === 'analysis_unavailable' ? '增加人数需要超级智能体拆分职责，请先在设置中配置模型。' : '超级智能体没有给出可用的方案，请重试。', 503);
      planned = mergeByOverlap(roles, count, { join: '、', more: (first, n) => `${first}等 ${n} 个岗位` });
      method = 'merge';
    }
    const plan: TeamPlan = { id: id(), target: count, method, createdAt: stamp(), createdBy: ctx.userId, basis, roles: planned };
    await this.deps.repo.transact(ctx, s => {
      if (JSON.stringify(this.planSources(s, ctx).basis) !== JSON.stringify(basis)) throw new KnowledgeError('plan_stale', '岗位草案刚刚有变化，请重新规划。', 409);
      s.teamPlan = plan;
    });
    return { plan: { ...plan, stale: false, replaces: roles.length, editedReplaced: roles.filter(r => r.edited).length }, fallbackReason: method === 'merge' ? modelError : null };
  }
  async discardTeamPlan(ctx: UserContext) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, s => { if (s.teamPlan?.createdBy === ctx.userId) delete s.teamPlan; return { discarded: true }; });
  }
  /** Adopting replaces every current role draft with the planned roles; they inherit the sources' evidence and scope. */
  async adoptTeamPlan(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx);
    const planId = bounded(input.planId, 100, '方案');
    return this.deps.repo.transact(ctx, s => {
      const plan = s.teamPlan;
      if (!plan || plan.id !== planId || plan.createdBy !== ctx.userId) throw new KnowledgeError('plan_not_found', '这个方案已不存在，请重新规划。', 404);
      const { basis } = this.planSources(s, ctx);
      if (JSON.stringify(basis) !== JSON.stringify(plan.basis)) throw new KnowledgeError('plan_stale', '岗位草案在规划后有变化，请重新规划。', 409);
      const sources = new Map(s.recommendations.filter(r => basis.includes(r.id)).map(r => [r.id, r]));
      const created = plan.roles.map((role, index) => {
        const from = role.from.map(rid => sources.get(rid)!).filter(Boolean);
        const evidence = [...new Map(from.flatMap(r => r.evidence).map(e => [JSON.stringify([e.sourceId, e.version, e.start, e.end]), e])).values()].slice(0, 12);
        // A role built from a private MCP draft stays private to the same viewer.
        const privateSource = from.find(r => r.mcpScope);
        const rec: Recommendation = {
          id: id(), key: `team-${plan.id.slice(0, 8)}-${index + 1}`, kind: 'employee', origin: evidence.length ? 'inferred' : 'manual',
          name: role.name, description: role.duty, evidence, humanLocked: true, deleted: false,
          assignment: { tools: role.tools, sops: role.sops },
          ...(privateSource ? { mcpScope: privateSource.mcpScope, mcpRunId: privateSource.mcpRunId } : {}),
        };
        s.recommendations.push(rec);
        return rec;
      });
      for (const old of sources.values()) {
        old.deleted = true;
        old.mergedInto = created.find(c => plan.roles[created.indexOf(c)]!.from.includes(old.id))?.id;
      }
      delete s.teamPlan;
      return { adopted: plan.id, roles: created.map(r => ({ id: r.id, name: r.name })) };
    });
  }
  async adoptRecommendation(ctx: UserContext, recId: string) {
    requireManager(ctx); return this.deps.repo.transact(ctx, s => {
      const r = s.recommendations.find(r => r.id === recId && !r.deleted && this.draftAllowed(s, ctx, r)), proposal = r?.proposedChange;
      if (!r || !proposal?.evidence.length || !proposal.evidence.every(e => this.valid(s, ctx, e))) throw new KnowledgeError('proposal_unavailable', '修改草案的依据已变化，请重新分析并核对。', 409);
      Object.assign(r, proposal, { humanLocked: true, workflow: proposal.workflow }); delete r.proposedChange; return { id: r.id, humanLocked: true };
    });
  }
  async togglePlugin(ctx: UserContext, pluginId: string, enabled: boolean) {
    requireManager(ctx); if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '插件不存在。');
    return this.deps.repo.transact(ctx, s => { s.disabledPlugins = s.disabledPlugins.filter(p => p !== pluginId); if (!enabled) s.disabledPlugins.push(pluginId); invalidateAnalyses(s); return { enabled }; });
  }
  private databaseConnection(s: KnowledgeState, ctx: UserContext, connectionId: string) {
    const conn = s.source.connections.find(c => c.id === connectionId), meta = s.connectionMeta[connectionId];
    if (!this.deps.database || !conn || conn.pluginId !== 'database' || conn.status !== 'confirmed' || s.disabledPlugins.includes('database') || !meta || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('source_denied', '当前数据库来源不可用。', 403);
    return conn;
  }
  async templates(ctx: UserContext, connectionId: string) { const state = await this.deps.repo.read(ctx); this.databaseConnection(state, ctx, connectionId); return { templates: state.queryTemplates.filter(t => t.connectionId === connectionId) }; }
  async approveTemplate(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    requireManager(ctx); return this.deps.repo.transact(ctx, async s => {
      const conn = this.databaseConnection(s, ctx, connectionId), template = await this.deps.database!.approve(ctx, connectionId, conn.scope, input);
      if (!s.queryTemplates.some(t => t.id === template.id)) s.queryTemplates.push(template); return template;
    });
  }
  async factFreshness(ctx: UserContext, connectionId: string, templateId: string, revision: string) {
    const state = await this.deps.repo.read(ctx), conn = this.databaseConnection(state, ctx, connectionId);
    const template = state.queryTemplates.find(t => t.id === templateId && t.connectionId === connectionId);
    if (!template) throw new KnowledgeError('template_not_approved', '必须选择已经审批的查询模板。', 403);
    const result = await this.deps.database!.freshness(ctx, conn.scope, template, revision);
    const fresh = await this.deps.repo.read(ctx); this.databaseConnection(fresh, ctx, connectionId);
    if (!fresh.queryTemplates.some(t => t.id === template.id)) throw new KnowledgeError('template_stale', '查询模板已被撤回。', 409);
    return result;
  }
  async query(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    try { return await this.queryCurrent(ctx, connectionId, input); } catch (error) {
      await this.deps.audit?.append({ tenantId: ctx.tenantId, actor: ctx.userId, action: 'knowledge.current_fact_denied', objectType: 'knowledge', objectId: hash(connectionId), result: 'denied', detail: { reason: error instanceof KnowledgeError ? error.code : 'source_unavailable' } });
      throw error;
    }
  }
  private async queryCurrent(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    const state = await this.deps.repo.read(ctx), conn = this.databaseConnection(state, ctx, connectionId), template = state.queryTemplates.find(t => t.id === input.templateId && t.connectionId === connectionId);
    if (!template) throw new KnowledgeError('template_not_approved', '必须选择已经审批的查询模板。', 403);
    if (!Array.isArray(input.args)) throw new KnowledgeError('invalid_parameters', '查询参数必须为数组。');
    // Results are current facts returned to the caller; never inserted into source items or the knowledge index.
    const result = await this.deps.database!.run(ctx, conn.scope, template, input.args);
    const fresh = await this.deps.repo.read(ctx); this.databaseConnection(fresh, ctx, connectionId);
    if (!fresh.queryTemplates.some(t => t.id === template.id)) throw new KnowledgeError('template_stale', '查询模板已被撤回。', 409);
    await this.deps.audit?.append({tenantId:ctx.tenantId,actor:ctx.userId,action:'knowledge.current_fact_queried',objectType:'knowledge',objectId:template.id,versionRef:hash(result.schemaVersion),result:'ok',detail:{connectionId,rowCount:result.rowCount,queriedAt:result.queriedAt}});
    return result;
  }
}

/** Starting prompt for a role the owner has not written one for; it is shown and editable before confirmation. */
function defaultPrompt(name: string, duty: string): string {
  return `你是「${name}」。职责：${duty}\n只使用已安装并授权的工具；资料不足、缺少授权或需要审批时，停下来说明缺什么并交给负责人。每次交付都附上依据和可回读的结果。`;
}
