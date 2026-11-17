import type { FastifyPluginAsync } from 'fastify';
import { ToolGateway } from './gateway.js';
import { loadGatewaySnapshot, saveGatewaySnapshot, type Queryable } from './pg-gateway.js';

/** One gateway per process. Postgres is the restart copy; this object stays the one the executor holds. */
export const gatewayState = { current: new ToolGateway() };

let gatewayStore: Queryable | null = null;

export function bindGatewayStore(db: Queryable | null): void {
  gatewayStore = db;
}

export async function flushGateway(instanceId?: string): Promise<void> {
  if (!gatewayStore) return;
  const { actions } = gatewayState.current.snapshot();
  await saveGatewaySnapshot(gatewayStore, {
    actions: actions.filter(action => instanceId ? action.instanceId === instanceId : !action.instanceId.startsWith('cmd_')),
  });
}

export async function hydrateGateway(instanceId?: string): Promise<void> {
  if (!gatewayStore) return;
  const saved = await loadGatewaySnapshot(gatewayStore, instanceId);
  if (saved.actions.length === 0) return;
  gatewayState.current.load(saved, instanceId !== undefined);
}

export const gatewayModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'gateway', writesRetryOnUnknown: false }));
};
