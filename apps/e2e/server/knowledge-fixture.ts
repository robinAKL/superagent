/** Explicit synthetic source/model/DB drivers. No Azure, Graph, or model-provider proof is claimed. */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SourceError, type KnowledgeSourcePlugin, type SourceItemRef, type UserContext } from '@superagent/shared';
import { MemoryKnowledgeRepository } from '../../server/src/modules/knowledge/repository.js';
import { DatabaseGateway, type DatabaseResource } from '../../server/src/modules/knowledge/database.js';
import { textWithLineAnchors } from '../../server/src/modules/knowledge/plugins/local-file.js';
import { tickKnowledge } from '../../server/src/modules/knowledge/worker.js';
import type { KnowledgeDeps } from '../../server/src/modules/knowledge/service.js';
import type { Evidence, RecommendedWorkflow } from '../../server/src/modules/knowledge/domain.js';
import type { AuditEntry } from '../../server/src/modules/audit/audit.js';
import type { SourceResource } from '../../server/src/modules/knowledge/sources.js';
import { LiveMcpKnowledge } from '../../server/src/modules/knowledge/live-mcp.js';
import { InMemorySecretStore } from '../../server/src/modules/setup/secrets.js';
import { createOrganizationSink } from '../../server/src/modules/employees/organization.js';
import { employeesState } from '../../server/src/modules/employees/index.js';
import { toolsState } from '../../server/src/modules/tools/index.js';

export const KNOWLEDGE_OWNER = 'e2e-knowledge-owner';
export const KNOWLEDGE_HEADER = `${KNOWLEDGE_OWNER}|owner|P-1`;
export const ROLE_FILE = [
  '角色：采购专员；责任：核对采购申请并跟踪供应商。',
  '角色：财务专员；责任：核对付款金额与票据。',
  '角色：仓储专员；责任：复核入库批次与库存数量。',
  '角色：业务主管；责任：审核异常并协调部门职责。',
  '工具：只读单据查询；职责：按编号查证业务记录。',
].join('\n');
export const DB_RESOURCE_ID = 'synthetic-dba-lots';
export const MAIL_RESOURCE_ID = 'synthetic-mailbox';
export const SHAREPOINT_RESOURCE_ID = 'synthetic-sharepoint';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface RemoteControl { available: boolean; acl: 'allowed' | 'revoked' | 'unknown'; version: number; text: string }
interface DatabaseControl { available: boolean; readOnly: boolean; schemaVersion: number; revision: number; rowValue: number }
const ctx: UserContext = { tenantId: 'e2e', userId: KNOWLEDGE_OWNER, roles: ['owner'], projectScopes: ['P-1'] };

export function createKnowledgeFixture(): { deps: KnowledgeDeps; attach(app: FastifyInstance): Promise<void> } {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic knowledge E2E fixture is forbidden in production.');
  let mail: RemoteControl;
  let sharepoint: RemoteControl;
  let db: DatabaseControl;
  let modelAvailable = true;
  let modelSuffix = '';
  let reads = { email: 0, sharepoint: 0, database: 0, model: 0 };
  let liveAudit: AuditEntry[] = [];
  const columns = ['lot_id', 'project_id', 'quantity', 'status', 'manufacturing_order_reference', 'sensitive_email', ...Array.from({ length: 10 }, (_, index) => `inspection_detail_${index + 1}`), 'final_quality_disposition'];
  const resource: DatabaseResource = {
    id: DB_RESOURCE_ID, name: 'DBA 批准的批次只读视图（合成测试）', projectIds: ['P-1'],
    scope: { audience: [KNOWLEDGE_OWNER], maxRows: 25, tables: { approved_lots: { columns, sensitive: ['sensitive_email'] } } },
    async inspect() {
      if (!db.available) throw new SourceError('transient', 'synthetic database unavailable');
      return { version: `synthetic-schema-${db.schemaVersion}`, tables: { approved_lots: columns.map(column => ({ column, type: column === 'quantity' ? 'numeric' : 'text' })) } };
    },
    async factRevision() { if (!db.available) throw new SourceError('transient', 'synthetic database unavailable'); return `synthetic-data-${db.revision}`; },
    async verifyReadOnly() { return db.available && db.readOnly; },
    async open() {
      if (!db.available) throw new SourceError('transient', 'synthetic database unavailable');
      return { release() {}, client: { async query(sql, args) {
        if (!sql.startsWith('SELECT * FROM (')) return { rows: [] };
        reads.database++;
        // The fixture driver models a DBA-owned P-1-filtered view. SQL validation/binding is the real gateway's job.
        const requestedLot = args?.[0];
        if (requestedLot !== undefined && requestedLot !== 'LOT-P1') return { rows: [] };
        const row = Object.fromEntries(columns.map(column => [column, column === 'quantity' ? db.rowValue : column === 'lot_id' ? 'LOT-P1' : column === 'project_id' ? 'P-1' : column === 'sensitive_email' ? 'driver-private@synthetic.invalid' : column === 'final_quality_disposition' ? '最后一列可见' : `synthetic-${column}`]));
        return { rows: [row] };
      } } };
    },
  };
  function remote(pluginId: 'email' | 'sharepoint'): KnowledgeSourcePlugin {
    const state = () => pluginId === 'email' ? mail : sharepoint;
    const locator = pluginId === 'email' ? 'synthetic-mail://finance/Inbox/mail-roles' : 'synthetic-sharepoint://approved/职责.md';
    const ref = (hidden = false): SourceItemRef => ({ externalId: hidden ? `${pluginId}-denied` : `${pluginId}-roles`, version: `v${state().version}`, title: hidden ? '禁止泄露的私人薪资标题' : pluginId === 'email' ? '采购财务职责邮件（合成）' : '仓储管理职责文档（合成）', locator: hidden ? 'synthetic://denied' : locator, change: state().acl === 'revoked' ? 'access_revoked' : 'upsert' });
    const available = () => { if (!state().available) throw new SourceError('auth', 'synthetic source authorization unavailable'); };
    return {
      manifest: { id: pluginId, name: pluginId === 'email' ? '企业邮件' : 'SharePoint', version: 'synthetic-1', capabilities: { incremental: true, attachments: false, acl: true, liveQuery: false }, permissions: ['read approved synthetic source'] },
      async testConnection() { available(); return { ok: true }; },
      async listItems() { available(); return { items: [ref(), ref(true)], nextCursor: `synthetic-${state().version}-${state().acl}` }; },
      async getAcl(_connection, item) {
        available();
        if (state().acl === 'unknown') return { status: 'unknown', reason: 'synthetic ACL unknown' };
        return { status: 'known', entries: [{ principal: item.externalId.endsWith('-denied') || state().acl === 'revoked' ? 'synthetic-unrelated-user' : KNOWLEDGE_OWNER, access: 'read' }] };
      },
      async readItem(_connection, item) {
        available();
        if (item.externalId.endsWith('-denied') || state().acl !== 'allowed') throw new SourceError('scope', 'synthetic source denied');
        reads[pluginId]++;
        return textWithLineAnchors(state().text, locator);
      },
    };
  }
  const deps: KnowledgeDeps & { sourceResources: SourceResource[] } = {
    repo: new MemoryKnowledgeRepository(), database: new DatabaseGateway([resource]),
    organization: createOrganizationSink(() => employeesState.current, () => toolsState.current),
    sourceResources: [], plugins: { email: remote('email'), sharepoint: remote('sharepoint') },
    enqueue: async () => undefined,
    audit: { append: async entry => { liveAudit.push(structuredClone(entry)); } },
    model: {
      async check() { if (!modelAvailable) throw new Error('synthetic model unavailable'); },
      async recommend(input) {
        if (!modelAvailable) throw new Error('synthetic model unavailable');
        reads.model++;
        const proposals: {
          key: string; kind: 'employee' | 'tool' | 'sop' | 'relation' | 'object'; name: string; description: string; evidence: Evidence[];
          relation?: { from: string; to: string; label: string }; workflow?: RecommendedWorkflow;
        }[] = [];
        for (const evidence of input.evidence) {
          for (const match of evidence.quote.matchAll(/(角色|工具)：([^；\n]+)；(?:责任|职责)：([^\n]+)/g)) {
            const quote = match[0], start = evidence.start + (match.index ?? 0);
            const source = { ...evidence, start, end: start + quote.length, quote };
            const kind = match[1] === '角色' ? 'employee' as const : 'tool' as const;
            const name = match[2]!;
            if (!proposals.some(proposal => proposal.key === `${kind}-${digest(name).slice(0, 12)}`)) proposals.push({ key: `${kind}-${digest(name).slice(0, 12)}`, kind, name, description: match[3]! + modelSuffix, evidence: [source] });
          }
        }
        const schema = input.evidence.find(evidence => evidence.locator.includes('@schema '));
        if (schema && !proposals.some(proposal => proposal.kind === 'employee')) {
          proposals.push({ key: 'schema-data-analyst', kind: 'employee', name: '数据分析员', description: `理解批准的数据库结构并核对当前事实。${modelSuffix}`, evidence: [{ ...schema }] });
          proposals.push({ key: 'schema-query-tool', kind: 'tool', name: '只读批次查询', description: `只使用批准的参数化 SELECT 模板；仍为待配置工具草案。${modelSuffix}`, evidence: [{ ...schema }] });
        }
        const handbook = input.evidence.find(evidence => evidence.locator.endsWith('handbook://procedures/returns'));
        if (handbook) {
          const role = proposals.find(proposal => proposal.name === '退货专员')?.key;
          proposals.push({
            key: 'returns', kind: 'sop', name: '退货审核流程', description: '核对收货记录后登记退款。', evidence: [handbook],
            workflow: { steps: [
              { key: 'arrived', kind: 'trigger', label: '收到退货', after: [], citations: [1] },
              { key: 'check', kind: 'employee', label: '核对收货记录', after: ['arrived'], citations: [1], employeeKey: role },
              { key: 'record', kind: 'tool', label: '登记退款', after: ['check'], citations: [1] },
            ] },
          });
          proposals.push({ key: 'return-document', kind: 'object', name: '退货记录', description: '记录已收到的退货。', evidence: [handbook] });
          proposals.push({ key: 'refund', kind: 'object', name: '退款', description: '退货核对后登记的退款。', evidence: [handbook] });
          proposals.push({ key: 'return-refund', kind: 'relation', name: '退货退回款项', description: '核对退货后登记退款。', evidence: [handbook],
            relation: { from: 'return-document', to: 'refund', label: '登记退款' } });
          proposals.push({ key: 'return-receipt', kind: 'relation', name: '退货关联收货记录', description: '登记前需要核对记录。', evidence: [handbook],
            relation: { from: 'return-document', to: 'receipt', label: '关联' } });
        }
        return proposals;
      },
    },
  };
  function reset() {
    deps.repo = new MemoryKnowledgeRepository();
    delete deps.liveMcp;
    mail = { available: true, acl: 'allowed', version: 1, text: ROLE_FILE.split('\n').slice(0, 2).join('\n') };
    sharepoint = { available: true, acl: 'allowed', version: 1, text: ROLE_FILE.split('\n').slice(2).join('\n') };
    db = { available: true, readOnly: true, schemaVersion: 1, revision: 1, rowValue: 120 };
    resource.scope.audience = [KNOWLEDGE_OWNER]; resource.projectIds = ['P-1'];
    modelAvailable = true; modelSuffix = ''; reads = { email: 0, sharepoint: 0, database: 0, model: 0 }; liveAudit = [];
    deps.sourceResources = [
      { id: MAIL_RESOURCE_ID, name: '财务收件箱（合成测试）', pluginId: 'email', scope: { mailbox: 'finance@synthetic.invalid', folder: 'Inbox', receivedSince: '2026-01-01T00:00:00Z' }, audience: [KNOWLEDGE_OWNER], projectIds: ['P-1'] },
      { id: SHAREPOINT_RESOURCE_ID, name: '批准的职责资料库（合成测试）', pluginId: 'sharepoint', scope: { driveId: 'synthetic-approved-drive', folderPath: '/approved' }, audience: [KNOWLEDGE_OWNER], projectIds: ['P-1'] },
    ];
    for (const employee of employeesState.current.list().filter(row => row.id.startsWith('emp-org-'))) employeesState.current.remove(employee.id);
  }
  reset();
  return { deps, async attach(app) {
    if (process.env.NODE_ENV === 'production') throw new Error('Synthetic knowledge E2E routes are forbidden in production.');
    await app.register(async testApp => {
      testApp.addHook('preHandler', async (request, reply) => {
        if (request.headers['x-dev-user'] !== KNOWLEDGE_HEADER) return reply.code(403).send({ error: 'test_driver_identity_required' });
      });
      testApp.post('/reset', async () => { reset(); return { fixture: 'synthetic-only', reset: true }; });
      testApp.post('/seed-live-mcp', async () => {
        const endpoint = 'https://handbook.synthetic.example/mcp';
        const uri = 'handbook://procedures/returns';
        const network: typeof fetch = async (input, init) => {
          if (String(input) !== endpoint || init?.method !== 'POST') return new Response(null, { status: 405 });
          const { id, method, params } = JSON.parse(String(init.body));
          if (method === 'notifications/initialized') return new Response(null, { status: 202 });
          const results: Record<string, unknown> = {
            initialize: { protocolVersion: params?.protocolVersion, serverInfo: { name: '退货手册 MCP', version: 'test' }, capabilities: { resources: {} } },
            'resources/list': { resources: [{ uri, name: '退货流程' }] },
            'resources/templates/list': { resourceTemplates: [] },
            'resources/read': { contents: [{ uri, text: '角色：退货专员；责任：核对收货记录后登记退款。' }] },
          };
          return Response.json({ jsonrpc: '2.0', id, result: results[method] });
        };
        deps.liveMcp = new LiveMcpKnowledge(deps.repo, new InMemorySecretStore(), network);
        const connected = await deps.liveMcp.connect(ctx, { endpoint });
        return { id: 'source' in connected ? connected.source?.id : undefined };
      });
      testApp.post<{ Body: Record<string, unknown> }>('/control', async request => {
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_test_control' };
        if (body.kind === 'mail' || body.kind === 'sharepoint') {
          const state = body.kind === 'mail' ? mail : sharepoint;
          if (typeof body.available === 'boolean') state.available = body.available;
          if (body.acl === 'allowed' || body.acl === 'revoked' || body.acl === 'unknown') state.acl = body.acl;
          if (typeof body.text === 'string' && body.text.length <= 10000) { state.text = body.text; state.version++; }
          if (body.bumpVersion === true) state.version++;
          if (body.resourceAudience === 'revoked') deps.sourceResources.find(resource => resource.pluginId === (body.kind === 'mail' ? 'email' : 'sharepoint'))!.audience = [];
          if (body.resourceAudience === 'allowed') deps.sourceResources.find(resource => resource.pluginId === (body.kind === 'mail' ? 'email' : 'sharepoint'))!.audience = [KNOWLEDGE_OWNER];
        } else if (body.kind === 'database') {
          if (typeof body.available === 'boolean') db.available = body.available;
          if (typeof body.readOnly === 'boolean') db.readOnly = body.readOnly;
          if (typeof body.rowValue === 'number' && Number.isFinite(body.rowValue)) { db.rowValue = body.rowValue; db.revision++; }
          if (body.schemaChanged === true) db.schemaVersion++;
          if (body.audience === 'revoked') resource.scope.audience = [];
          if (body.audience === 'allowed') resource.scope.audience = [KNOWLEDGE_OWNER];
        } else if (body.kind === 'model') {
          if (typeof body.available === 'boolean') modelAvailable = body.available;
          if (typeof body.suffix === 'string' && body.suffix.length <= 1000) modelSuffix = body.suffix;
        } else throw new Error('Unknown synthetic test control');
        return { fixture: 'synthetic-only', controlled: true };
      });
      testApp.post('/advance', async () => ({ fixture: 'synthetic-only', worked: await tickKnowledge(deps, 'e2e') }));
      testApp.get('/audit', async () => {
        const entries = [...(deps.repo as MemoryKnowledgeRepository).auditEntries, ...liveAudit].map(entry => ({
          actor: entry.actor, action: entry.action, objectType: entry.objectType, objectId: entry.objectId, versionRef: entry.versionRef, result: entry.result,
          detail: entry.detail && Object.fromEntries(Object.entries(entry.detail).filter(([key]) => ['connectionId', 'rowCount', 'queriedAt', 'reason', 'changedFields', 'revision'].includes(key))),
        }));
        return { fixture: 'synthetic-only', entries, counters: { ...reads } };
      });
      testApp.get('/metadata', async () => {
        const state = await deps.repo.read(ctx);
        return { fixture: 'synthetic-only', sourceCount: state.source.items.filter(item => item.current).length, chunkCount: state.source.chunks.length, schemaVersions: state.source.items.filter(item => item.current).map(item => item.version), recommendations: state.recommendations.map(({ id, key, kind, name, humanLocked, deleted }) => ({ id, key, kind, name, humanLocked, deleted })), analyses: state.analyses.map(({ id, status, signature }) => ({ id, status, signature })) };
      });
    }, { prefix: '/__test/knowledge' });
  } };
}
