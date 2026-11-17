import type { FastifyPluginAsync } from 'fastify';
import { EmployeeService } from './employees.js';
import { toolsState } from '../tools/index.js';

/** One employee registry per process, shared with the executor's call-time authorisation. */
export const employeesState = { current: new EmployeeService() };

/** Digital employee routes (T-42). */
export type EmployeeOwnerNames = (tenantId: string, ownerIds: string[]) => Promise<Map<string, string>>;

export const employeesModule: FastifyPluginAsync<{ service?: EmployeeService; ownerNames?: EmployeeOwnerNames }> = async (app, opts) => {
  const svc = opts.service ?? employeesState.current;
  const view = (id: string) => {
    const e = svc.get(id);
    return { id: e.id, name: e.name, duty: e.duty, status: e.status, source: e.source, owner: e.owner, promptVersion: svc.currentPrompt(id).version, modelTier: e.modelTier };
  };
  app.get('/', async (req) => {
    const employees = svc.list().map(employee => view(employee.id));
    const viewer = req.user!;
    const ownerIds = [...new Set(employees.map(e => e.owner).filter(owner => owner && owner !== viewer.userId))];
    const names = ownerIds.length && opts.ownerNames
      ? await opts.ownerNames(viewer.tenantId, ownerIds).catch(() => new Map<string, string>())
      : new Map<string, string>();
    const toolCounts = toolsState.current.assignedToolCounts();
    return employees.map(employee => ({
      ...employee,
      ownerIsViewer: !!employee.owner && employee.owner === viewer.userId,
      ownerDisplayName: names.get(employee.owner) ?? null,
      toolCount: toolCounts.get(employee.id) ?? 0,
    }));
  });
  // ownerUserId names the person who answers for this employee (sees and reports its work in the command room).
  // Only admins and owners reach this module, so only they can put an employee in someone else's hands.
  app.post<{ Body: { name: string; duty: string; prompt: string; source?: 'recommended' | 'manual'; ownerUserId?: string } }>('/', async (req) => {
    const { ownerUserId, ...input } = req.body;
    return view(svc.create({ ...input, owner: typeof ownerUserId === 'string' && ownerUserId ? ownerUserId : req.user!.userId }).id);
  });
  app.put<{ Params: { id: string }; Body: { prompt: string } }>('/:id/prompt', async (req) => (svc.updatePrompt(req.params.id, req.body.prompt, req.user!.userId), view(req.params.id)));
  app.post<{ Params: { id: string } }>('/:id/pause', async (req) => (svc.pause(req.params.id), view(req.params.id)));
  app.post<{ Params: { id: string } }>('/:id/resume', async (req) => (svc.resume(req.params.id), view(req.params.id)));
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    try {
      svc.remove(req.params.id);
      return { deleted: true };
    } catch (e) {
      return reply.code(409).send({ error: 'has_active_work', message: (e as Error).message });
    }
  });
};
