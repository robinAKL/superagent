import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { PgKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const schema = `t27reset_${randomUUID().replace(/-/g, '')}`;

const DDL = `
CREATE SCHEMA "${schema}";
CREATE TABLE "${schema}".knowledge_tenants (
  tenant_id text PRIMARY KEY,
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "${schema}".knowledge_chunks (
  tenant_id text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  content text NOT NULL,
  locator text NOT NULL,
  title text NOT NULL,
  principals text[] NOT NULL,
  project_ids text[] NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE TABLE "${schema}".knowledge_audit_log (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  version_ref text,
  result text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "${schema}".sop_versions (
  id text NOT NULL,
  tenant_id text NOT NULL,
  sop_id text NOT NULL,
  number integer NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL,
  report jsonb,
  revision integer NOT NULL,
  validated_revision integer,
  effective_at text,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE "${schema}".sop_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  sop_id text NOT NULL,
  sop_version_id text NOT NULL,
  version_number integer NOT NULL,
  event_key text NOT NULL UNIQUE,
  status text NOT NULL
);
`;

function boundPool(pool: pg.Pool): pg.Pool {
  return {
    async query(sql: string, params?: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}", public`);
      return client;
    },
  } as unknown as pg.Pool;
}

live('real Postgres: reset clears tenant A knowledge_tenants & knowledge_chunks while preserving tenant B, connections, published sop_versions and sop_instances', async () => {
  const rawPool = new pg.Pool({ connectionString: databaseUrl });
  await rawPool.query(DDL);
  try {
    const pool = boundPool(rawPool);
    const repo = new PgKnowledgeRepository(pool);
    const service = new KnowledgeService({ repo });
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const ctxA: UserContext = { tenantId: tenantA, userId: 'admin-a', roles: ['admin'], projectScopes: ['*'] };
    const ctxB: UserContext = { tenantId: tenantB, userId: 'admin-b', roles: ['admin'], projectScopes: ['*'] };

    for (const [ctx, prefix] of [[ctxA, 'a'], [ctxB, 'b']] as const) {
      await repo.transact(ctx, s => {
        s.source.connections.push({ id: `${prefix}-conn`, pluginId: 'mcp', name: `${prefix} MCP`, status: 'confirmed', scope: { endpoint: `https://${prefix}.example.com` } });
        s.connectionMeta[`${prefix}-conn`] = { name: `${prefix} MCP`, audience: [ctx.userId], projectIds: ['*'] };
        s.source.items.push({ id: `${prefix}-item`, connectionId: `${prefix}-conn`, externalId: `${prefix}-ext`, title: `${prefix} doc`, mimeType: 'text/plain', version: 'v1', contentHash: 'h1', current: true, status: 'parsed', acl: [{ principal: ctx.userId, access: 'read' }] });
        s.source.chunks.push({ itemId: `${prefix}-item`, version: 'v1', index: 0, text: `${prefix} text` });
        s.confirmations[`${prefix}-item`] = { version: 'v1', signature: 'sig', confirmedBy: ctx.userId, confirmedAt: '2026-11-01T00:00:00Z' };
        s.recommendations.push({ id: `${prefix}-sop`, key: `${prefix}-sop`, kind: 'sop', name: `${prefix} SOP`, description: 'd', evidence: [], humanLocked: false, deleted: false });
      });
    }

    await pool.query(`INSERT INTO sop_versions (id, tenant_id, sop_id, number, definition, status, revision) VALUES ('v-pub', $1, 'sop-shared', 1, '{}'::jsonb, 'published', 1), ('v-draft', $1, 'sop-draft', 1, '{}'::jsonb, 'draft', 1)`, [tenantA]);
    await pool.query(`INSERT INTO sop_instances (id, tenant_id, sop_id, sop_version_id, version_number, event_key, status) VALUES ('inst-a', $1, 'sop-shared', 'v-pub', 1, 'k-a', 'running')`, [tenantA]);

    await service.resetKnowledge(ctxA, { confirmText: 'RESET' });

    const aState = await repo.read(ctxA);
    expect(aState.source.items).toHaveLength(0);
    expect(aState.recommendations).toHaveLength(0);
    expect(aState.source.connections).toHaveLength(1);

    const bState = await repo.read(ctxB);
    expect(bState.source.items).toHaveLength(1);
    expect(bState.recommendations).toHaveLength(1);

    const aChunks = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id=$1`, [tenantA]);
    expect(aChunks.rows[0]?.n).toBe(0);

    const sopVers = await pool.query<{ id: string }>(`SELECT id FROM sop_versions ORDER BY id`);
    expect(sopVers.rows.map(r => r.id)).toEqual(['v-draft', 'v-pub']);

    const sopInsts = await pool.query<{ id: string }>(`SELECT id FROM sop_instances`);
    expect(sopInsts.rows.map(r => r.id)).toEqual(['inst-a']);
  } finally {
    await rawPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await rawPool.end();
  }
});
