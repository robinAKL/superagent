import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { companyContext } from '../src/modules/sop/index.js';

function ctxFor(tenantId: string, userId: string, roles: UserContext['roles']): UserContext {
  return { tenantId, userId, roles, projectScopes: ['*'] };
}

async function seedTenant(repo: MemoryKnowledgeRepository, ctx: UserContext, prefix: string) {
  await repo.transact(ctx, s => {
    s.source.connections.push({
      id: `${prefix}-conn`,
      pluginId: 'mcp',
      name: `${prefix} MCP`,
      status: 'confirmed',
      scope: { endpoint: `https://${prefix}.example.com/mcp` },
    });
    s.connectionMeta[`${prefix}-conn`] = { name: `${prefix} MCP`, audience: [ctx.userId], projectIds: ['*'] };
    s.source.items.push({
      id: `${prefix}-item`,
      connectionId: `${prefix}-conn`,
      externalId: `${prefix}-ext`,
      title: `${prefix} doc`,
      mimeType: 'text/plain',
      version: 'v1',
      contentHash: 'h1',
      current: true,
      status: 'parsed',
      acl: [{ principal: ctx.userId, access: 'read' }],
    });
    s.source.chunks.push({ itemId: `${prefix}-item`, version: 'v1', index: 0, text: `${prefix} chunk` });
    s.analyses.push({
      id: `${prefix}-run`,
      actor: ctx,
      status: 'completed',
      stage: 'complete',
      signature: 'sig',
      createdAt: '2026-11-01T00:00:00Z',
      error: null,
    });
    s.recommendations.push(
      { id: `${prefix}-sop`, key: `${prefix}-sop`, kind: 'sop', name: `${prefix} SOP`, description: 'd', evidence: [], humanLocked: false, deleted: false },
      { id: `${prefix}-rule`, key: `${prefix}-rule`, kind: 'object', ruleLike: true, name: `${prefix} Rule`, description: 'r', evidence: [], humanLocked: false, deleted: false },
      { id: `${prefix}-obj`, key: `${prefix}-obj`, kind: 'object', name: `${prefix} Obj`, description: 'o', evidence: [], humanLocked: false, deleted: false },
      { id: `${prefix}-rel`, key: `${prefix}-rel`, kind: 'relation', name: `${prefix} Rel`, description: 'l', relation: { from: `${prefix}-obj`, to: `${prefix}-obj`, label: 'self' }, evidence: [], humanLocked: false, deleted: false },
    );
    s.liveMcp[ctx.userId] = {
      sources: {
        [`${prefix}-live`]: { id: `${prefix}-live`, endpoint: `https://${prefix}.example.com/live`, name: 'Live MCP', allowTools: false },
      },
    };
  });
}

describe('tenant knowledge reset', () => {
  it('refuses non-admin/owner roles and invalid confirmation text', async () => {
    const repo = new MemoryKnowledgeRepository();
    const app = await buildApp({ knowledgeDeps: { repo } });

    const empPreview = await app.inject({ method: 'GET', url: '/api/v1/knowledge/reset/preview', headers: { 'x-dev-user': 'u1|employee|' } });
    expect(empPreview.statusCode).toBe(403);

    const revReset = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/reset',
      headers: { 'x-dev-user': 'u2|reviewer|', 'content-type': 'application/json' },
      payload: { confirmText: 'RESET' },
    });
    expect(revReset.statusCode).toBe(403);

    const badConfirm = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/reset',
      headers: { 'x-dev-user': 'u3|admin|', 'content-type': 'application/json' },
      payload: { confirmText: 'WRONG' },
    });
    expect(badConfirm.statusCode).toBe(400);
    await app.close();
  });

  it('clears tenant A knowledge data while preserving connections and leaving tenant B untouched', async () => {
    const repo = new MemoryKnowledgeRepository();
    const tenantACtx = ctxFor('tenant-a', 'admin-a', ['admin']);
    const tenantBCtx = ctxFor('tenant-b', 'admin-b', ['owner']);
    await seedTenant(repo, tenantACtx, 'a');
    await seedTenant(repo, tenantBCtx, 'b');

    const app = await buildApp({ knowledgeDeps: { repo }, auth: { mode: 'dev', platformTenantId: 'tenant-a' } });
    const preview = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/reset/preview',
      headers: { 'x-dev-user': 'admin-a|admin|*' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().counts).toMatchObject({
      sources: 1,
      chunks: 1,
      analyses: 1,
      sops: 1,
      rules: 1,
      ontology: 2,
      otherDrafts: 0,
      preserved: { connections: 1, mcpUsers: 1 },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/reset',
      headers: { 'x-dev-user': 'admin-a|admin|*', 'content-type': 'application/json' },
      payload: { confirmText: 'RESET' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().ok).toBe(true);

    const stateA = await repo.read(tenantACtx);
    expect(stateA.source.items).toHaveLength(0);
    expect(stateA.source.chunks).toHaveLength(0);
    expect(stateA.analyses).toHaveLength(0);
    expect(stateA.recommendations).toHaveLength(0);
    expect(stateA.source.connections).toHaveLength(1);
    expect(Object.keys(stateA.liveMcp['admin-a']?.sources ?? {})).toEqual(['a-live']);

    const stateB = await repo.read(tenantBCtx);
    expect(stateB.source.items).toHaveLength(1);
    expect(stateB.source.chunks).toHaveLength(1);
    expect(stateB.analyses).toHaveLength(1);
    expect(stateB.recommendations).toHaveLength(4);
    expect(stateB.source.connections).toHaveLength(1);
    expect(Object.keys(stateB.liveMcp['admin-b']?.sources ?? {})).toEqual(['b-live']);
    await app.close();
  });

  it('accepts company name as confirmation text when configured', async () => {
    const repo = new MemoryKnowledgeRepository();
    const ctx = ctxFor('tenant-co', 'admin-co', ['admin']);
    await seedTenant(repo, ctx, 'co');
    await companyContext.current.save('tenant-co', 'admin-co', { name: 'VERA Shading', goal: 'g', boundaries: 'b' }, 0);

    const app = await buildApp({ knowledgeDeps: { repo }, auth: { mode: 'dev', platformTenantId: 'tenant-co' } });
    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/reset',
      headers: { 'x-dev-user': 'admin-co|admin|*', 'content-type': 'application/json' },
      payload: { confirmText: 'VERA Shading' },
    });
    expect(reset.statusCode).toBe(200);
    const state = await repo.read(ctx);
    expect(state.source.items).toHaveLength(0);
    expect(state.recommendations).toHaveLength(0);
    await app.close();
  });

  it('PgKnowledgeRepository.resetTenant deletes knowledge_chunks and tenant-exclusive sop_versions in one transaction', async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes('FOR UPDATE')) {
          return { rows: [{ doc: { spaceName: '企业知识', installedPlugins: ['local-file'], revision: 1, source: { connections: [], items: [], chunks: [], citations: [], flagged: [] }, connectionMeta: {}, confirmations: {}, analyses: [], recommendations: [], uploads: [], disabledPlugins: [], parseJobs: [], queryTemplates: [], profiles: {}, liveMcp: {}, veraMcp: {} } }] };
        }
        if (sql.includes('to_regclass')) return { rows: [{ v: 'sop_versions', i: 'sop_instances', e: 'sop_events' }] };
        if (sql.startsWith('DELETE FROM sop_versions')) return { rows: [], rowCount: 2 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as import('pg').Pool;
    const repo = new PgKnowledgeRepository(pool);
    const result = await repo.resetTenant(ctxFor('t-pg', 'u-pg', ['admin']), () => ({ ok: true }));
    expect(result.sopVersionsDeleted).toBe(2);
    expect(queries[0]!.sql).toBe('BEGIN');
    expect(queries.some(q => q.sql.includes('DELETE FROM knowledge_chunks WHERE tenant_id=$1') && q.params?.[0] === 't-pg')).toBe(true);
    const sopDelete = queries.find(q => q.sql.startsWith('DELETE FROM sop_versions'));
    expect(sopDelete?.sql).toContain('tenant_id <> $1');
    expect(sopDelete?.params).toEqual(['t-pg']);
    expect(queries.at(-1)!.sql).toBe('COMMIT');
  });
});
