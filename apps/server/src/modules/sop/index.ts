import { validateSopGraph } from '@superagent/shared';
import type { FastifyPluginAsync } from 'fastify';
import { toolsState } from '../tools/index.js';
import { countRunningSopInstances, loadActiveWorkflows, loadSopSnapshot, saveSopSnapshot, type Queryable } from './pg-sop.js';
import { OriginalRequests } from './original-request.js';
import { CompanyContextStore, contextInput } from './company-context.js';
import { setSopGraphCheck, SopRuntime, type SopDefinition, type SopGraphContext } from './sop.js';

setSopGraphCheck((graph, context) => validateSopGraph(graph, context as Parameters<typeof validateSopGraph>[1]));

export const sopState = { current: new SopRuntime() };
export const originalRequestState = { current: new OriginalRequests() };

let sopStore: Queryable | null = null;
export const companyContext = { current: new CompanyContextStore(null) };

export function bindSopStore(db: Queryable | null): void {
  sopStore = db;
  companyContext.current = new CompanyContextStore(db);
}

/** Writes the process cache. A worker reads the tables; it does not trust this process's memory. */
export async function flushSop(): Promise<void> {
  if (sopStore) await saveSopSnapshot(sopStore, sopState.current.snapshot());
}

/**
 * Applies a change and then writes it. If the write fails, or the change throws after mutating the runtime,
 * the process cache returns to the snapshot from before the call. A failed database write must not look published.
 */
export async function commitSop<T>(change: () => T): Promise<T> {
  const before = sopStore ? sopState.current.snapshot() : null;
  let result: T;
  try {
    result = change();
  } catch (error) {
    if (before) sopState.current = SopRuntime.restore(before);
    throw error;
  }
  try {
    await flushSop();
  } catch (error) {
    if (before) sopState.current = SopRuntime.restore(before);
    throw error;
  }
  return result;
}

/** Replaces the process cache when Postgres already has versions, instances, or claimed events. */
export async function hydrateSop(): Promise<void> {
  if (!sopStore) return;
  const saved = await loadSopSnapshot(sopStore);
  if (saved.versions.length === 0 && saved.instances.length === 0 && saved.eventKeys.length === 0) return;
  sopState.current = SopRuntime.restore(saved);
}

/** Latest version must itself be published. A newer draft means the flow is no longer the confirmed one. */
function resumeFacts(toolId: string, target: string): { sopConfirmed: boolean; toolUsable: boolean } {
  const sopConfirmed = sopState.current.list().some((row) => row.latest.status === 'published');
  const toolUsable = toolsState.current.callable(target).some((row) => row.toolId === toolId);
  return { sopConfirmed, toolUsable };
}

export const sopModule: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({ sops: sopState.current.list() }));
  app.get('/company-context', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { context: await companyContext.current.read(req.user!.tenantId) };
  });
  app.put('/company-context', async (req, reply) => {
    const input = contextInput(req.body);
    if (!input) return reply.code(400).send({ error: 'invalid_company_context' });
    const { expectedVersion, ...fields } = input;
    const context = await companyContext.current.save(req.user!.tenantId, req.user!.userId, fields, expectedVersion);
    return context ? { context } : reply.code(409).send({ error: 'company_context_changed' });
  });
  app.get('/published', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const now = Date.now();
    const versions = sopStore ? await loadActiveWorkflows(sopStore) : sopState.current.list().flatMap(({ sopId }) => {
      const active = sopState.current.activePublished(sopId, now);
      return active ? [active] : [];
    });
    return { workflows: versions.filter(version => version.definition.graph?.nodes.length).map(active => {
      const { sopId } = active;
      const { definition } = active;
      return { id: active.id, sopId, version: active.number, title: definition.workflow?.title || sopId,
        completion: definition.workflow?.completion ?? '', requiredFields: definition.requiredFields ?? [],
        numericField: definition.threshold?.field ?? null };
    }) };
  });

  app.get('/original-requests', async () => ({ requests: originalRequestState.current.list() }));

  app.post('/original-requests', async (req, reply) => {
    const body = (req.body ?? {}) as { toolId?: string; target?: string; title?: string };
    if (!body.toolId || !body.target || !body.title) return reply.code(400).send({ error: 'missing_fields' });
    return originalRequestState.current.create({ toolId: body.toolId, target: body.target, title: body.title });
  });

  app.post('/original-requests/:id/resume', async (req, reply) => {
    const params = req.params as { id: string };
    const existing = originalRequestState.current.list().find((item) => item.id === params.id);
    if (!existing) return reply.code(404).send({ error: 'request_not_found' });
    // Gates come from the published SOP and that employee's callable tools. A request body cannot set them.
    const item = originalRequestState.current.resume(params.id, resumeFacts(existing.toolId, existing.target));
    if (!item) return reply.code(404).send({ error: 'request_not_found' });
    return item;
  });

  app.post('/original-requests/:id/pause', async (req, reply) => {
    const params = req.params as { id: string };
    const item = originalRequestState.current.pause(params.id);
    if (!item) return reply.code(404).send({ error: 'request_not_found' });
    return item;
  });

  app.post('/drafts', async (req, reply) => {
    const body = (req.body ?? {}) as { sopId?: string; definition?: SopDefinition };
    const sopId = body.sopId;
    const definition = body.definition;
    if (!sopId || !definition) return reply.code(400).send({ error: 'missing_fields' });
    return commitSop(() => sopState.current.draft(sopId, definition));
  });

  app.put('/drafts/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { definition?: SopDefinition };
    const definition = body.definition;
    if (!definition) return reply.code(400).send({ error: 'missing_fields' });
    try {
      return await commitSop(() => sopState.current.revise(params.id, definition));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'version_not_found';
      if (message !== 'version_not_found') throw error;
      return reply.code(404).send({ error: message });
    }
  });

  app.get('/versions/:id', async (req, reply) => {
    const params = req.params as { id: string };
    let version;
    try {
      version = sopState.current.get(params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'version_not_found' });
    }
    const runningInstances = sopStore
      ? (await countRunningSopInstances(sopStore, version.sopId, req.user?.tenantId)).get(version.id) ?? 0
      : sopState.current.runningInstances(version.id);
    return { ...version, runningInstances };
  });

  app.get('/:sopId/versions', async (req) => {
    const { sopId } = req.params as { sopId: string };
    const versions = sopState.current.listVersions(sopId);
    if (!sopStore) return { versions };
    const counts = await countRunningSopInstances(sopStore, sopId, req.user?.tenantId);
    return { versions: versions.map(version => ({ ...version, runningInstances: counts.get(version.id) ?? 0 })) };
  });

  app.post('/:id/validate', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as {
      employees?: SopGraphContext['employees'];
      tools?: SopGraphContext['tools'];
    };
    try {
      return await commitSop(() => sopState.current.validate(params.id, { employees: body.employees ?? {}, tools: body.tools ?? {} }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'validation_failed';
      if (message !== 'version_not_found' && message !== 'already_published' && message !== 'graph_context_missing') throw error;
      return reply.code(message === 'version_not_found' ? 404 : 409).send({ error: message });
    }
  });

  app.post('/:id/publish', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as {
      effectiveAt?: string;
      employees?: SopGraphContext['employees'];
      tools?: SopGraphContext['tools'];
    };
    try {
      return await commitSop(() => sopState.current.publish(params.id, body.effectiveAt, { employees: body.employees ?? {}, tools: body.tools ?? {} }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'validation_failed';
      if (!['version_not_found', 'validation_stale', 'bad_effective_at', 'graph_invalid', 'graph_context_missing'].includes(message)) throw error;
      const issues = (error as { issues?: unknown }).issues;
      return reply.code(message === 'version_not_found' ? 404 : 409).send(issues ? { error: message, issues } : { error: message });
    }
  });
};
