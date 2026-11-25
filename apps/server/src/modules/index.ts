import type { FastifyPluginAsync } from 'fastify';
import type { Role } from '@superagent/shared';
import { setupModule } from './setup/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { roomModule } from './room/index.js';
import { employeesModule } from './employees/index.js';
import { toolsModule } from './tools/index.js';
import { runtimeModule } from './runtime/index.js';
import { gatewayModule } from './gateway/index.js';
import { humanworkModule } from './humanwork/index.js';
import { sopModule } from './sop/index.js';
import { executionModule } from './execution/index.js';
import { workersModule } from './workers/index.js';
import { accountsModule } from './accounts/index.js';
import { schedulesModule } from './schedules/index.js';

export interface ModuleDef {
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: FastifyPluginAsync<any>;
  /** Roles allowed to call this module (server-side check). Omit = any signed-in user. */
  roles?: Role[];
}

/** Mount points. Add your module here in its own PR; do not edit other owners' modules. */
export const modules: ModuleDef[] = [
  { prefix: 'setup', plugin: setupModule, roles: ['admin', 'owner'] }, // T-39 Claude
  { prefix: 'knowledge', plugin: knowledgeModule }, // T-40 Codex
  { prefix: 'room', plugin: roomModule },         // T-41 Grok
  { prefix: 'employees', plugin: employeesModule, roles: ['admin', 'owner'] }, // T-42
  { prefix: 'tools', plugin: toolsModule, roles: ['admin', 'owner', 'reviewer'] }, // T-42
  // HTTP queue is for the internal operator (admin/owner). The worker process does not use this
  // route; it calls claimTask with PLATFORM_TENANT_ID. employee and reviewer are refused.
  { prefix: 'runtime', plugin: runtimeModule, roles: ['admin', 'owner'] },
  { prefix: 'gateway', plugin: gatewayModule },   // T-41 Grok
  { prefix: 'work-items', plugin: humanworkModule }, // T-41 Grok
  { prefix: 'sop', plugin: sopModule, roles: ['admin', 'owner'] }, // T-41 Grok (runtime) / T-48 page
  { prefix: 'executions', plugin: executionModule, roles: ['admin', 'owner'] }, // T-56 executor
  // Worker registry. Admin/owner except the self-service routes (pairing and the member's own computers), which the
  // module checks per route. The worker's own channel is /api/v1/worker-link, outside sign-in.
  { prefix: 'workers', plugin: workersModule }, // room T-03
  // Mail and calendar accounts: an administrator's own (controls Super Agent) and each digital employee's own.
  { prefix: 'accounts', plugin: accountsModule, roles: ['admin', 'owner'] },
  // The workflow calendar: every signed-in member; the module shows each role only what it may see.
  { prefix: 'schedules', plugin: schedulesModule },
];
