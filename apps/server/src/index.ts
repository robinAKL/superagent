import { APP_ROLES, type AppRole } from '@superagent/shared';
import { buildApp } from './app.js';
import { dispatchBound, runWorker } from './worker.js';
import { bindRuntimeDb, runtimeState } from './modules/runtime/index.js';
import { bindRoomBrain, bindRoomStore, hydrateRoom, startRoomSupervisor } from './modules/room/index.js';
import { gatewayBrain } from './modules/room/brain.js';
import { answerFromMcp } from './modules/knowledge/mcp-answer.js';
import { bindWorkersDb, startPgListener } from './modules/workers/index.js';
import { bindAccounts } from './modules/accounts/index.js';
import { bindScheduleStore, startScheduleTimer } from './modules/schedules/index.js';
import { PgScheduleStore } from './modules/schedules/pg-schedules.js';
import { PgAccountStore } from './modules/accounts/pg-accounts.js';
import { microsoftProvider } from './modules/accounts/microsoft.js';
import { bindSopStore, hydrateSop } from './modules/sop/index.js';
import { bindGatewayStore, hydrateGateway } from './modules/gateway/index.js';
import { bindInboxStore, hydrateInbox } from './modules/humanwork/index.js';
import { bindExecutionStore, hydrateExecutions } from './modules/execution/index.js';
import { createKnowledgeDeps, knowledgeReady, restoreConfirmedOrganizations } from './modules/knowledge/runtime.js';
import { tickKnowledge } from './modules/knowledge/worker.js';
import { createLongWorkDeps } from './modules/longwork/runtime.js';
import { pgMailSopConsumer } from './modules/longwork/execution-adapter.js';

/** Microsoft 365 mailbox sign-in, when the platform app registration is configured. */
function accountProvider() {
  const clientId = process.env.MS_ACCOUNTS_CLIENT_ID, clientSecret = process.env.MS_ACCOUNTS_CLIENT_SECRET;
  return clientId && clientSecret ? microsoftProvider({ clientId, clientSecret }) : null;
}

const role = (process.env.APP_ROLE ?? 'web') as AppRole;
if (!APP_ROLES.includes(role)) {
  console.error(`Unknown APP_ROLE "${role}". Expected one of: ${APP_ROLES.join(', ')}`);
  process.exit(1);
}

if (role === 'web') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env); // throws BootstrapError naming missing settings → container exits
  const knowledge = createKnowledgeDeps(runtime);
  const longwork = createLongWorkDeps(runtime);
  bindRoomBrain(gatewayBrain(runtime.llm, undefined, (why) => console.warn(`room brain: ${why}; using fixed rules`)), knowledge.liveMcp ? {
    sources: async (user) => (await knowledge.liveMcp!.sources(user)).map(({ id, name, endpoint }) => ({ id, name, endpoint })),
    ask: (user, sourceId, question) => answerFromMcp(user, sourceId, question, knowledge.liveMcp!, runtime.llm, { quick: true }),
  } : null);
  let roomHydrated = !runtime.pool;
  let sopHydrated = !runtime.pool;
  let inboxHydrated = !runtime.pool;
  let executionHydrated = !runtime.pool;
  // Super Agent manages the board on a timer; with a database it starts once the room is loaded.
  if (!runtime.pool) { startRoomSupervisor(); startScheduleTimer(); bindAccounts({ secrets: runtime.app.setupDeps.secrets, provider: accountProvider() }); }
  if (runtime.pool) {
    // T-41: command-room rows, the task queue, and published SOP versions share one PostgreSQL.
    const pool = runtime.pool;
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await pool.query(text, params as unknown[])).rows as T[] }) };
    bindRoomStore(db);
    bindRuntimeDb(db);
    bindScheduleStore(new PgScheduleStore(db));
    bindAccounts({ store: new PgAccountStore(db), secrets: runtime.app.setupDeps.secrets, provider: accountProvider() });
    bindWorkersDb({
      ...db,
      // Room-binding changes run several statements on one connection under a per-tenant lock.
      async transaction<T>(work: (tx: typeof db) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work({ query: async <R>(text: string, params: readonly unknown[]) => ({ rows: (await client.query(text, params as unknown[])).rows as R[] }) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    });
    // One dedicated connection LISTENs for new work and worker events so held polls wake at once (T-07).
    startPgListener(() => pool.connect());
    bindSopStore(db);
    bindGatewayStore(db);
    bindInboxStore(db);
    bindExecutionStore(db);
    // Never crash the web role on an unreachable database: retry in the background and stay not-ready until done.
    const hydrate = () => hydrateRoom().then(() => { roomHydrated = true; startRoomSupervisor(); startScheduleTimer(); }, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'room hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrate, 5000).unref();
    });
    void hydrate();
    const hydrateSopRows = () => hydrateSop().then(() => { sopHydrated = true; }, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'sop hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrateSopRows, 5000).unref();
    });
    void hydrateSopRows();
    const hydrateGatewayRows = () => hydrateGateway().then(() => undefined, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'gateway hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrateGatewayRows, 5000).unref();
    });
    void hydrateGatewayRows();
    const hydrateInboxRows = () => hydrateInbox().then(() => { inboxHydrated = true; }, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'inbox hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrateInboxRows, 5000).unref();
    });
    void hydrateInboxRows();
    const hydrateExecutionRows = () => hydrateExecutions().then(() => { executionHydrated = true; }, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'execution hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrateExecutionRows, 5000).unref();
    });
    void hydrateExecutionRows();
  }
  const app = await buildApp({ ...runtime.app, knowledgeDeps: knowledge, longWorkDeps: longwork,
    readiness: [...runtime.app.readiness, { name: 'knowledge', check: () => knowledgeReady(knowledge) }, { name: 'longwork', check: longwork.ready }, { name: 'room', check: async () => roomHydrated }, { name: 'sop', check: async () => sopHydrated }, { name: 'inbox', check: async () => inboxHydrated }, { name: 'execution', check: async () => executionHydrated }], serveWeb: true, logger: true });
  app.addHook('onClose', async () => { await knowledge.close?.(); await runtime.close(); });
  // Employees and tool placeholders live in process memory; the confirmed organization in the tenant document brings them back.
  void restoreConfirmedOrganizations(knowledge).then(n => { if (n) console.log(JSON.stringify({ msg: 'organization restored', restored: n })); }, (e: unknown) => console.log(JSON.stringify({ msg: 'organization restore failed', error: e instanceof Error ? e.message : String(e) })));
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
} else if (role === 'worker') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const knowledge = createKnowledgeDeps(runtime);
  if (runtime.pool) {
    const pool = runtime.pool;
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await pool.query(text, params as unknown[])).rows as T[] }) };
    bindExecutionStore(db); bindGatewayStore(db); bindInboxStore(db);
    try { await hydrateGateway(); } catch (error) { await runtime.close(); throw error; }
  }
  const longwork = createLongWorkDeps(runtime, process.env, runtime.pool ? pgMailSopConsumer(runtime.pool) : undefined);
  if (!await longwork.ready()) { await runtime.close(); throw Error('Longwork migrations are required before starting the worker'); }
  if (!await knowledgeReady(knowledge)) { await knowledge.close?.(); await runtime.close(); throw Error('Knowledge migrations are required before starting the worker'); }
  let lastHeartbeat = 0;
  try { await runWorker({ runtime, signal: controller.signal, heartbeatMs: 1000,
    ticks: [
      async () => { await tickKnowledge(knowledge, runtime.config.platformTenantId); },
      async () => { await longwork.tick(); },
      // T-41 queue: one claim per tick for kinds with a registered handler; nothing claimed without one.
      async () => {
        if (!runtime.pool) return;
        const pool = runtime.pool;
        await dispatchBound({ query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await pool.query(text, params as unknown[])).rows as T[] }) }, runtimeState.queue, process.env.WORKER_ID ?? 'worker', runtime.config.platformTenantId);
      },
    ],
    log: entry => { if (entry.msg !== 'worker heartbeat' || Date.now() - lastHeartbeat >= 15_000) { console.log(JSON.stringify(entry)); lastHeartbeat = Date.now(); } },
  }); } finally { await knowledge.close?.(); }
} else {
  // APP_ROLE=browser: one sandbox run per Job execution (browser image variant, Dockerfile.browser).
  const { runFromEnv } = await import('./browser/runner.js');
  await runFromEnv();
}
