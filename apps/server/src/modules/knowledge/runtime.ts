import type { Runtime } from '../../bootstrap.js';
import { KnowledgeService, type KnowledgeDeps } from './service.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from './repository.js';
import { AzureBinaryStore } from './binary.js';
import { DocumentIntelligenceAdapter } from '../../plugins/document-intelligence.js';
import { GatewayAnalysisModel, type AnalysisGateway } from '../analysis/gateway-model.js';
import { configuredDatabases } from './database-config.js';
import { managedSourcePlugins } from './sources.js';
import { PgKnowledgeAudit } from './audit.js';
import { LiveMcpKnowledge } from './live-mcp.js';
/** All identity/endpoints/pools originate from the fail-closed platform bootstrap. */
import { employeesState } from '../employees/index.js';
import { toolsState } from '../tools/index.js';
import { createOrganizationSink } from '../employees/organization.js';
import { roomState } from '../room/index.js';

export function createKnowledgeDeps(runtime: Runtime & { llm?: AnalysisGateway }): KnowledgeDeps {
  const sourceResources = runtime.config.sourceResources ?? [], plugins = managedSourcePlugins(sourceResources, runtime.app.setupDeps.secrets);
  const model = runtime.llm ? new GatewayAnalysisModel(runtime.llm, async tenantId =>
    (await runtime.app.setupDeps.repo.get(tenantId)).monthlyCapMicroUsd !== null) : undefined;
  const database = configuredDatabases(runtime.config.sourceDatabases ?? [], runtime.app.setupDeps.secrets);
  const { config, pool } = runtime;
  const repo = config.mode === 'dev' ? new MemoryKnowledgeRepository() : pool && new PgKnowledgeRepository(pool);
  if (!repo) throw Error('Knowledge requires persistent runtime dependencies');
  const liveMcp = new LiveMcpKnowledge(repo, runtime.app.setupDeps.secrets);
  const organization = createOrganizationSink(() => employeesState.current, () => toolsState.current, id => roomState.current.hasOpenWork(id));
  if (config.mode === 'dev') return { repo, organization, liveMcp, mcpAnswerGateway: runtime.llm, sourceResources, plugins, model, database: database.gateway, close: database.close, enqueue: async () => undefined };
  if (!pool || !config.blobUrl || !config.docIntelEndpoint) throw Error('Knowledge requires persistent runtime dependencies');
  return {
    repo, organization, liveMcp, mcpAnswerGateway: runtime.llm, sourceResources, plugins,
    audit: new PgKnowledgeAudit(pool),
    model,
    database: database.gateway, close: database.close,
    binary: { blobs: new AzureBinaryStore(config.blobUrl), parser: new DocumentIntelligenceAdapter({ endpoint: config.docIntelEndpoint }) },
    // The same PG document contains the durable analysis job; enqueue is an optional wake-up notification.
    enqueue: async () => undefined,
  };
}
export async function knowledgeReady(deps: KnowledgeDeps): Promise<boolean> {
  if (!(deps.repo instanceof PgKnowledgeRepository)) return true;
  const result = await deps.repo.pool.query("SELECT to_regclass('public.knowledge_tenants') IS NOT NULL AND to_regclass('public.knowledge_chunks') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS ok");
  return result.rows[0]?.ok === true;
}
/** Web start-up: put every tenant's confirmed digital employees and tool placeholders back into this process's registries. */
export async function restoreConfirmedOrganizations(deps: KnowledgeDeps): Promise<number> {
  if (!(deps.repo instanceof PgKnowledgeRepository) || !deps.organization) return 0;
  const tenants = await deps.repo.pool.query<{ tenant_id: string }>("SELECT tenant_id FROM knowledge_tenants WHERE doc ? 'organization'");
  return new KnowledgeService(deps).restoreOrganizations(tenants.rows.map(row => row.tenant_id));
}
