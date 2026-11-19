/** Real browser + Fastify/service/gateway E2E. Only external source/model/DB drivers are explicitly synthetic. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, APIResponse } from '@playwright/test';
import { test, expect } from './fixtures.js';
const t33Shot = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../deliverables/v12-compare-t33', name);
// Kept local so Playwright discovery does not load the server's Azure/PG dependency graph.
const KNOWLEDGE_HEADER = 'e2e-knowledge-owner|owner|P-1';
const DB_RESOURCE_ID = 'synthetic-dba-lots';
const MAIL_RESOURCE_ID = 'synthetic-mailbox';
const SHAREPOINT_RESOURCE_ID = 'synthetic-sharepoint';
const ROLE_FILE = [
  '角色：采购专员；责任：核对采购申请并跟踪供应商。',
  '角色：财务专员；责任：核对付款金额与票据。',
  '角色：仓储专员；责任：复核入库批次与库存数量。',
  '角色：业务主管；责任：审核异常并协调部门职责。',
  '工具：只读单据查询；职责：按编号查证业务记录。',
].join('\n');

interface Item { id: string; title: string; version: string; confirmed: boolean; locator: string }
interface Recommendation { id: string; key: string; kind: string; name: string; description: string; humanLocked: boolean; origin?: string; evidence: { sourceId: string; version: string; start: number; end: number; locator: string; quote: string }[]; proposedChange?: { name: string; description: string }; stale?: boolean }
async function addLegacyWorkflowDrafts(page: Page) {
  await page.route('**/api/v1/knowledge/recommendations', async route => {
    const body = await (await route.fetch()).json();
    const workflow = body.mcpRecommendations.find((draft: Recommendation) => draft.key === 'returns');
    body.mcpRecommendations.unshift(
      { ...workflow, id: 'old-guide', key: 'old-guide', name: 'CRM操作指南', workflow: undefined },
      { ...workflow, id: 'old-rule', key: 'old-rule', name: '系统规则', ruleLike: true },
      { ...workflow, id: 'old-object', key: 'old-object', name: '客户对象', kind: 'object' },
      { ...workflow, id: 'single-excerpt', key: 'single-excerpt', name: '订单流程', evidence: workflow.evidence.slice(0, 1) },
    );
    await route.fulfill({ json: body });
  });
}
interface Overview { spaceName: string; plugins: { id: string; installed: boolean; builtIn: boolean; enabled: boolean }[]; connections: { id: string; name: string; pluginId: string; status: string }[]; items: Item[]; recommendations: Recommendation[]; analyses: { id: string; status: string }[]; databaseResources: { id: string; tables: Record<string, { columns: string[] }> }[]; sourceResources: { id: string; projectIds: string[] }[] }
interface Preview { items: { id: string; title: string; version: string; locator: string }[]; blocked: number; scope: Record<string, unknown> }
const ROOT = '/api/v1/knowledge';
const OWNER_WITHOUT_PROJECT = 'e2e-knowledge-owner|owner|';
const OTHER_OWNER = 'e2e-other-owner|owner|P-1';
const SQL = 'SELECT lot_id, project_id, quantity, status, manufacturing_order_reference, sensitive_email, inspection_detail_1, inspection_detail_2, inspection_detail_3, inspection_detail_4, inspection_detail_5, inspection_detail_6, inspection_detail_7, inspection_detail_8, inspection_detail_9, inspection_detail_10, final_quality_disposition FROM approved_lots WHERE lot_id = $1';

test.use({ extraHTTPHeaders: { 'x-dev-user': KNOWLEDGE_HEADER } });
// Config fullyParallel:false keeps this file sequential; independent resets let later cases run after a failure.
test.describe.configure({ mode: 'default' });
async function response<T>(incoming: Promise<APIResponse>, statuses = [200, 201, 202]): Promise<T> {
  const result = await incoming;
  expect(statuses, await result.text()).toContain(result.status());
  return result.json() as Promise<T>;
}
const getOverview = (page: Page) => response<Overview>(page.request.get(`${ROOT}/overview`));
const post = <T = Record<string, unknown>>(page: Page, path: string, data: unknown = {}) => response<T>(page.request.post(ROOT + path, { data }));
const control = (page: Page, data: unknown) => response(page.request.post('/__test/knowledge/control', { data }));
/**
 * Since the guided 3-step layout (#77), space naming, the read-only database panel and manual roles sit in the
 * collapsed 高级 section. The prototype assertions below predate that and expect them on the page, so every load
 * opens it the way a person would.
 */
async function openAdvanced(page: Page) {
  const advanced = page.locator('details.knowledge-advanced');
  if (!(await advanced.evaluate(el => (el as HTMLDetailsElement).open))) await advanced.locator(':scope > summary').click();
  await expect(advanced.locator('.knowledge-advanced-body')).toBeVisible();
}
/** Opens a source card's own connection form (the global form was replaced by per-card 配置连接 in #77). */
async function configureCard(page: Page, pluginId: string) {
  await page.getByTestId(`plugin-${pluginId}`).getByRole('button', { name: '配置连接', exact: true }).click();
}
async function openSources(page: Page) {
  const toggle = page.locator('button[aria-controls="knowledge-sources"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.getByTestId('plugin-local-file')).toBeVisible();
}
async function openWorkspace(page: Page, name: '资料库' | '分类与候选') {
  const nav = page.getByRole('navigation', { name: '知识工作区' });
  const button = nav.getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-current') !== 'page') await button.click();
}
async function refresh(page: Page) { await page.reload(); await expect(page.getByRole('heading', { name: '企业知识', exact: true })).toBeVisible(); await openSources(page); await openAdvanced(page); }
async function install(page: Page, id: string) { await post(page, `/plugins/${id}/install`); }
async function confirmItems(page: Page) {
  for (const item of (await getOverview(page)).items.filter(item => !item.confirmed)) await post(page, `/items/${item.id}/confirm`, { version: item.version });
}
async function localFile(page: Page, confirmed = true, text = ROLE_FILE) {
  const name = '实际上传职责.md';
  if (confirmed) {
    await openWorkspace(page, '资料库');
    await page.getByLabel('选择文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
  } else {
    const connection = await post<{ id: string }>(page, '/connections', { name: '本地职责资料', pluginId: 'local-file', scope: {} });
    await post(page, `/connections/${connection.id}/confirm`);
    await post(page, '/uploads', { connectionId: connection.id, name, text });
    await refresh(page);
    await openWorkspace(page, '资料库');
  }
  await expect(page.locator('#knowledge-items-list .mr-meta').filter({ hasText: name })).toBeVisible();
}
async function dbSource(page: Page, confirmed = true, sourceConfirmed = true) {
  const connection = await post<{ id: string }>(page, '/connections', { name: 'P-1 批次只读数据库', pluginId: 'database', scope: { resourceId: DB_RESOURCE_ID }, readOnlyAcknowledged: true });
  if (confirmed) { await post(page, `/connections/${connection.id}/confirm`); await post(page, `/connections/${connection.id}/sync`); if (sourceConfirmed) await confirmItems(page); }
  await refresh(page); return connection;
}
async function remoteSource(page: Page, pluginId: 'email' | 'sharepoint', imported = true, confirmed = true) {
  const name = pluginId === 'email' ? '邮件只读来源' : '文档库只读来源';
  const connection = await post<{ id: string }>(page, '/connections', { name, pluginId, scope: { resourceId: pluginId === 'email' ? MAIL_RESOURCE_ID : SHAREPOINT_RESOURCE_ID }, readOnlyAcknowledged: true });
  await post(page, `/connections/${connection.id}/confirm`);
  const preview = await response<Preview>(page.request.get(`${ROOT}/connections/${connection.id}/preview`));
  if (imported) { await post(page, `/connections/${connection.id}/import`, { ids: preview.items.map(item => item.id) }); if (confirmed) await confirmItems(page); }
  await refresh(page); return { ...connection, name, preview };
}
async function analyse(page: Page) {
  await post(page, '/analyses');
  await response(page.request.post('/__test/knowledge/advance', { data: {} }));
  await refresh(page);
  await openWorkspace(page, '分类与候选');
  expect((await getOverview(page)).analyses.at(-1)?.status).toBe('completed');
}
const card = (page: Page, name: string) => page.locator('.knowledge-recommendation').filter({ has: page.locator(`input[value=${JSON.stringify(name)}]`) });
async function openDraft(page: Page, name: string) {
  await openWorkspace(page, '分类与候选');
  await page.getByRole('list', { name: '草案列表' }).getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
  return card(page, name);
}
async function lockRole(page: Page, name: string, replacement = '人工保留职责') {
  const target = await openDraft(page, name);
  await target.locator('textarea').fill('这是人工核对后保留的说明。');
  await target.getByLabel('名称', { exact: true }).fill(replacement);
  await card(page, replacement).getByRole('button', { name: '保存并人工锁定', exact: true }).click();
  await expect(card(page, replacement).getByText('人工锁定', { exact: true })).toBeVisible();
  return replacement;
}
async function querySetup(page: Page) {
  const connection = await dbSource(page);
  const template = await post<{ id: string }>(page, `/connections/${connection.id}/templates`, { sql: SQL, params: ['lot_id'] });
  await refresh(page);
  await page.getByLabel('已批准模板').selectOption(template.id);
  await page.getByLabel('执行参数（JSON 数组）').fill('["LOT-P1"]');
  return { connection, template };
}
async function queryUi(page: Page) {
  await openSources(page);
  await page.getByLabel('执行参数（JSON 数组）').fill('["LOT-P1"]');
  const result = page.waitForResponse(response => response.url().endsWith('/query') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '执行已批准模板', exact: true }).click();
  expect((await result).ok()).toBe(true);
  await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toBeVisible();
}
async function assertDenied(page: Page, path: string, data: unknown, identity?: string) {
  const denied = await page.request.post(ROOT + path, { data, headers: identity ? { 'x-dev-user': identity } : undefined });
  expect(denied.status(), await denied.text()).toBeGreaterThanOrEqual(400);
  expect(denied.status()).toBeLessThan(500);
}

test.beforeEach(async ({ page }) => {
  await response(page.request.post('/__test/knowledge/reset', { data: {} }));
  await page.goto('/#knowledge');
  await openSources(page);
  await openAdvanced(page);
});

test('MCP analysis keeps supported drafts and shows them in Super Agent', async ({ page }) => {
  const { id } = await response<{ id: string }>(page.request.post('/__test/knowledge/seed-live-mcp', { data: {} }));
  await page.reload();
  await openWorkspace(page, '分类与候选');
  const source = page.getByRole('checkbox', { name: '退货手册 MCP' });
  const start = page.getByRole('button', { name: '开始分析', exact: true });
  await expect(source).toBeChecked();
  await expect(start).toBeEnabled();
  await source.press('Space');
  await expect(source).not.toBeChecked();
  await expect(start).toBeDisabled();
  await page.getByRole('group', { name: '纳入分析的 MCP 来源' }).getByText('退货手册 MCP', { exact: true }).click();
  await expect(source).toBeChecked();
  const request = page.waitForRequest(req => req.url().endsWith('/analyses') && req.method() === 'POST');
  await start.click();
  expect((await request).postDataJSON()).toEqual({ mcpSourceIds: [id] });
  await expect(page.getByRole('button', { name: '分析进行中', exact: true })).toBeDisabled();
  await response(page.request.post('/__test/knowledge/advance', { data: {} }));
  await page.reload();
  await expect(page.getByText('因缺少有效对象草案，已跳过 1 条关系。')).toBeVisible();
  const draft = card(page, '退货专员');
  await expect(draft.getByText('仅自己可见的 MCP 分析草案')).toBeVisible();
  await draft.locator('summary').click();
  await expect(draft.getByLabel('来源依据').getByText('退货手册 MCP / handbook://procedures/returns')).toBeVisible();
  await expect(draft.locator('blockquote')).toHaveText('角色：退货专员；责任：核对收货记录后登记退款。');

  await page.route('**/api/v1/sop', route => route.fulfill({ status: 503, json: {} }));
  // Analysis ends in one primary action: review the organization draft. Private MCP drafts appear there, marked as such,
  // and the step strip leads on to Super Agent where the workflow drafts are reviewed.
  await page.getByRole('link', { name: '审阅组织草案', exact: true }).click();
  const role = page.getByRole('article', { name: '退货专员' });
  await expect(role.getByText('来自你的 MCP 来源', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '3 发布流程', exact: true }).click();
  await page.getByRole('link', { name: '审阅候选流程', exact: true }).click();
  await page.getByRole('link', { name: '所有分析草案', exact: true }).click();
  const privateDrafts = page.getByRole('region', { name: '分析结果' });
  await expect(privateDrafts.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
  const diagram = privateDrafts.getByRole('group', { name: '流程图', exact: true });
  await expect(diagram.locator('[data-edge="check:record"]')).toHaveAttribute('marker-end', /url/);
  await diagram.getByRole('button', { name: /核对收货记录/ }).click();
  await expect(privateDrafts.getByRole('complementary', { name: '步骤依据' })).toContainText('退货手册 MCP');
  await expect(privateDrafts.getByRole('link', { name: '在流程编辑器中打开' })).toHaveCount(0);
  await privateDrafts.getByLabel('草案类型').selectOption('employee');
  await expect(privateDrafts.getByRole('heading', { name: '退货专员' })).toBeVisible();
  await privateDrafts.getByLabel('草案类型').selectOption('sop');
  await expect(privateDrafts.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
  await expect(privateDrafts.getByRole('heading', { name: '退货关联收货记录' })).toHaveCount(0);
  await privateDrafts.getByText('查看来源依据', { exact: true }).last().click();
  await expect(privateDrafts.getByText('退货手册 MCP / handbook://procedures/returns', { exact: true }).last()).toBeVisible();
  await page.getByRole('tab', { name: '企业流程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
  await expect(page.getByRole('group', { name: '流程图', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看我的 MCP 流程草案', exact: true }).click();
  await expect(privateDrafts.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
  await page.goto('/#brain?tab=ontology');
  const ontology = page.getByRole('region', { name: '本体关系图', exact: true });
  await expect(ontology).toContainText('全部来源');
  await expect(ontology.getByRole('img', { name: /个实体 ·/ })).toBeVisible();
  await ontology.locator('.onto-panel').getByRole('button', { name: /退货记录/ }).click();
  await expect(ontology.locator('.onto-panel')).toContainText('退货手册 MCP');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('[qa-enablement#1] New company begins without invented knowledge', async ({ page }) => {
  await test.step('real empty tenant has no sources, candidates or analyses', async () => {
    const overview = await getOverview(page); expect(overview.items).toEqual([]); expect(overview.recommendations).toEqual([]); expect(overview.analyses).toEqual([]);
    await openWorkspace(page, '资料库'); await expect(page.getByText('还没有资料。', { exact: true })).toBeVisible();
  });
});
test('[qa-enablement#2] Recommendations gated before knowledge confirmation', async ({ page }) => {
  await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  await assertDenied(page, '/analyses', {}); expect((await getOverview(page)).recommendations).toEqual([]);
});
test('[qa-enablement#3] Manual role is distinguished from document inference', async ({ page }) => {
  await page.getByLabel('人工角色名称', { exact: true }).fill('人工运营协调员'); await page.getByLabel('人工角色说明', { exact: true }).fill('人工记录的既有职责。'); await page.getByRole('button', { name: '添加人工角色', exact: true }).click();
  await expect(await openDraft(page, '人工运营协调员')).toContainText('人工补充 · 不是文档推断');
  const manual = (await getOverview(page)).recommendations[0]!; expect(manual.origin).toBe('manual'); expect(manual.evidence).toEqual([]); expect(manual.humanLocked).toBe(true);
  await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-enablement#4] Actual local text file is read', async ({ page }) => {
  await localFile(page); await page.getByText('查看当前版本原文与定位', { exact: true }).click();
  await expect(page.locator('.knowledge-item-preview')).toContainText(ROLE_FILE.split('\n')[0]!);
  const item = (await getOverview(page)).items[0]!; const preview = await response<{ chunks: { text: string; locator: string }[] }>(page.request.get(`${ROOT}/items/${item.id}/preview?version=${item.version}`)); expect(preview.chunks.map(chunk => chunk.text).join('\n')).toBe(ROLE_FILE); expect(preview.chunks[0]!.locator).toContain('#L1');
});
test('A mixed file selection publishes readable files and reports failures individually', async ({ page }) => {
  await openWorkspace(page, '资料库');
  await expect(page.getByTestId('plugin-mcp')).toBeHidden();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加资料', exact: true }).click();
  const files = await chooser;
  expect(files.isMultiple()).toBe(true);
  await files.setFiles([
    { name: '第一份', mimeType: 'application/octet-stream', buffer: Buffer.from('入库材料一。') },
    { name: '无法读取.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 0]) },
    { name: '第二份.log', mimeType: 'text/plain', buffer: Buffer.from('入库材料二。') },
  ]);
  await expect(page.getByText('上传失败', { exact: true })).toBeVisible();
  await expect(page.getByText('可搜索', { exact: true })).toHaveCount(2);
  const overview = await getOverview(page);
  expect(overview.connections).toHaveLength(1);
  expect(overview.items.map(item => item.title).sort()).toEqual(['第一份', '第二份.log'].sort());
  expect(overview.items.every(item => item.confirmed)).toBe(true);
});
test('[qa-enablement#5] Imported but unconfirmed knowledge cannot generate recommendations', async ({ page }) => {
  await localFile(page, false); expect((await getOverview(page)).items.every(item => !item.confirmed)).toBe(true); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled(); await assertDenied(page, '/analyses', {});
});
test('A single action confirms the displayed versions and starts analysis', async ({ page }) => {
  await remoteSource(page, 'email', true, false);
  await remoteSource(page, 'sharepoint', true, false);
  const materials = (await getOverview(page)).items;
  expect(materials).toHaveLength(2);
  expect(materials.every(item => !item.confirmed)).toBe(true);
  await openWorkspace(page, '资料库');
  await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toHaveCount(0);
  const confirmation = page.waitForRequest(req => req.url().endsWith('/items/confirm') && req.method() === 'POST');
  const run = page.waitForResponse(res => res.url().endsWith('/analyses') && res.request().method() === 'POST');
  await page.getByRole('button', { name: '确认并分析（2）' }).click();
  expect((await confirmation).postDataJSON()).toEqual({ items: materials.map(({ id, version }) => ({ id, version })) });
  expect((await run).status()).toBe(202);
  expect((await getOverview(page)).items.every(item => item.confirmed)).toBe(true);
  await expect(page.getByRole('button', { name: '分析进行中', exact: true })).toBeDisabled();
  await response(page.request.post('/__test/knowledge/advance', { data: {} }));
  await page.reload();
  await expect(await openDraft(page, '采购专员')).toBeVisible();
});
test('[qa-enablement#6] Four roles follow distinct evidence-bearing responsibilities', async ({ page }) => {
  await localFile(page); await analyse(page); const roles = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee'); expect(roles.map(role => role.name).sort()).toEqual(['业务主管', '仓储专员', '财务专员', '采购专员'].sort()); expect(new Set(roles.map(role => role.description)).size).toBe(4); for (const role of roles) await expect(await openDraft(page, role.name)).toBeVisible();
});
test('[qa-enablement#7] Every inferred role cites a source line', async ({ page }) => {
  await localFile(page); await analyse(page); for (const role of (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee')) { expect(role.evidence.length).toBeGreaterThan(0); const target = await openDraft(page, role.name); await target.locator('summary').click(); await expect(target.locator('.knowledge-evidence')).toContainText('#L'); for (const evidence of role.evidence) expect(ROLE_FILE.slice(evidence.start, evidence.end)).toBe(evidence.quote); }
});
test('[qa-enablement#8] Tools proposed alongside roles before business execution', async ({ page }) => {
  await localFile(page); const before = await response<unknown>(page.request.get('/api/v1/tools/')); await analyse(page); const tools = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'tool'); expect(tools).toHaveLength(1); expect(tools[0]!.evidence.length).toBeGreaterThan(0); await expect(await openDraft(page, tools[0]!.name)).toContainText('工具草案'); expect(await response(page.request.get('/api/v1/tools/'))).toEqual(before);
});
test('[qa-enablement#10] Reanalysis preserves human edits and presents differences', async ({ page }) => {
  await localFile(page); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'model', suffix: '二次分析修改。' }); await analyse(page); const recommendation = (await getOverview(page)).recommendations.find(rec => rec.name === retained)!; expect(recommendation.description).toBe('这是人工核对后保留的说明。'); expect(recommendation.proposedChange?.description).toContain('二次分析修改'); await expect(await openDraft(page, retained)).toContainText('分析提出了修改，尚未覆盖人工内容');
});
test('[qa-enablement#50] Reanalysis preserves explicit role deletion instead of recreating it', async ({ page }) => {
  await localFile(page); await analyse(page); await (await openDraft(page, '采购专员')).getByRole('button', { name: '删除草案', exact: true }).click(); await expect(card(page, '采购专员')).toHaveCount(0); await analyse(page); expect((await getOverview(page)).recommendations.some(rec => rec.name === '采购专员')).toBe(false); await expect(card(page, '采购专员')).toHaveCount(0);
});

test('[qa-database-knowledge#1] Documents and databases share enterprise knowledge entry', async ({ page }) => {
  await openWorkspace(page, '资料库'); await expect(page.getByRole('heading', { name: '企业资料', exact: true })).toBeVisible(); await openSources(page); await expect(page.getByRole('heading', { name: '只读数据库来源', exact: true })).toBeVisible(); await expect(page.getByTestId('plugin-database')).toContainText('只读数据库');
});
test('[qa-database-knowledge#2] Data source requires explicit read-only policy acknowledgement', async ({ page }) => {
  await refresh(page); await page.getByLabel('数据库连接名称', { exact: true }).fill('待确认数据库'); await expect(page.getByRole('button', { name: '验证并连接数据库', exact: true })).toBeDisabled(); await assertDenied(page, '/connections', { name: 'forged', pluginId: 'database', scope: { resourceId: DB_RESOURCE_ID } }); await page.getByLabel('我已核对数据库范围，并确认使用独立只读账号接入', { exact: true }).check(); const created = page.waitForResponse(result => result.url().endsWith('/knowledge/connections') && result.request().method() === 'POST'); await page.getByRole('button', { name: '验证并连接数据库', exact: true }).click(); expect((await created).status()).toBe(201); expect((await getOverview(page)).connections[0]).toMatchObject({ name: '待确认数据库', status: 'confirmed' });
});
test('[qa-database-knowledge#3] Connection string cannot be pasted into credential reference', async ({ page }) => {
  await assertDenied(page, '/connections', { name: 'unsafe', pluginId: 'database', readOnlyAcknowledged: true, credentialRef: 'postgres://raw:secret@outside/database', scope: { resourceId: DB_RESOURCE_ID } }); await assertDenied(page, '/connections', { name: 'unsafe', pluginId: 'database', readOnlyAcknowledged: true, scope: { resourceId: DB_RESOURCE_ID, connectionString: 'postgres://raw:secret@outside/database' } }); expect((await getOverview(page)).connections).toEqual([]); await expect(page.locator('.database-source')).toContainText('请勿');
});
test('[qa-database-knowledge#4] Database source can start without any uploaded file', async ({ page }) => { await dbSource(page); expect((await getOverview(page)).items.length).toBeGreaterThan(0); expect((await getOverview(page)).items.some(item => item.title.endsWith('.md'))).toBe(false); await openWorkspace(page, '资料库'); await expect(page.locator('#knowledge-items-list')).toContainText('approved_lots'); });
test('[qa-database-knowledge#5] Unconfirmed database cannot feed recommendations', async ({ page }) => { const connection = await dbSource(page, false); await assertDenied(page, `/connections/${connection.id}/sync`, {}); await assertDenied(page, '/analyses', {}); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled(); });
test('[qa-database-knowledge#6] Confirming source forms logical enterprise knowledge space', async ({ page }) => { await dbSource(page, true, false); await expect(page.getByRole('form', { name: '知识空间命名' })).toBeVisible(); await openWorkspace(page, '资料库'); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); await confirmItems(page); await refresh(page); expect((await getOverview(page)).items.every(item => item.confirmed)).toBe(true); });
test('[qa-database-knowledge#7] Knowledge space can be named without copying database', async ({ page }) => {
  await dbSource(page); const before = await response(page.request.get('/__test/knowledge/metadata')); await page.getByLabel('知识空间名称', { exact: true }).fill('批次管理知识空间'); await page.getByRole('button', { name: '保存知识空间名称', exact: true }).click(); await expect(page.getByLabel('知识空间名称', { exact: true })).toHaveValue('批次管理知识空间'); expect((await getOverview(page)).spaceName).toBe('批次管理知识空间'); expect(await response(page.request.get('/__test/knowledge/metadata'))).toEqual(before);
});
test('[qa-database-knowledge#8] Confirmed metadata can support role candidates', async ({ page }) => { await dbSource(page); await analyse(page); await expect(await openDraft(page, '数据分析员')).toBeVisible(); expect((await getOverview(page)).recommendations.find(rec => rec.name === '数据分析员')!.evidence[0]!.locator).toContain('@schema '); });
test('[qa-database-knowledge#10] Schema does not become a published SOP', async ({ page }) => { await dbSource(page); await analyse(page); expect((await getOverview(page)).recommendations.some(rec => rec.kind === 'sop')).toBe(false); await expect(page.locator('.knowledge-recommendations')).not.toContainText('已发布'); });
test('[qa-database-knowledge#11] Database metadata recommends read-only query placeholder without inventing mail workflow', async ({ page }) => { await dbSource(page); await analyse(page); await expect(await openDraft(page, '只读批次查询')).toContainText('工具草案'); const candidates = (await getOverview(page)).recommendations; expect(candidates.map(candidate => candidate.name).join(' ')).not.toMatch(/邮件|发送|发票审批/); expect(candidates.every(candidate => candidate.evidence.length > 0)).toBe(true); });
test('[qa-database-knowledge#20] Row update expires fact result without changing metadata analysis', async ({ page }) => {
  await querySetup(page); await analyse(page); await queryUi(page); const before = await response(page.request.get('/__test/knowledge/metadata')); await control(page, { kind: 'database', rowValue: 144 }); await page.getByRole('button', { name: '核对事实是否仍有效', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('结果已过期'); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toHaveCount(0); expect(await response(page.request.get('/__test/knowledge/metadata'))).toEqual(before);
});
test('[qa-database-knowledge#21] Next query reads new synthetic value', async ({ page }) => { await querySetup(page); await queryUi(page); await expect(page.getByRole('cell', { name: '120', exact: true })).toBeVisible(); await control(page, { kind: 'database', rowValue: 144 }); await page.getByRole('button', { name: '核对事实是否仍有效', exact: true }).click(); await queryUi(page); await expect(page.getByRole('cell', { name: '144', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '120', exact: true })).toHaveCount(0); });
test('[qa-database-knowledge#22] Data change does not silently rewrite schema rules or team', async ({ page }) => { const connection = await dbSource(page); await analyse(page); const before = await getOverview(page); await control(page, { kind: 'database', rowValue: 155 }); await post(page, `/connections/${connection.id}/sync`); const after = await getOverview(page); expect(after.recommendations).toEqual(before.recommendations); expect(after.items.map(item => item.version)).toEqual(before.items.map(item => item.version)); await refresh(page); await expect(await openDraft(page, '数据分析员')).toBeVisible(); });
test('[qa-database-knowledge#24] Reads and denials leave audit metadata', async ({ page }) => {
  const { connection, template } = await querySetup(page); await queryUi(page); await assertDenied(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }, OTHER_OWNER); const audit = await response<{ entries: { action: string; result: string }[] }>(page.request.get('/__test/knowledge/audit')); expect(audit.entries.some(entry => entry.result === 'ok' && /fact|query/.test(entry.action))).toBe(true); expect(audit.entries.some(entry => entry.result === 'denied')).toBe(true); expect(JSON.stringify(audit)).not.toMatch(/driver-private|SELECT |LOT-P1|synthetic-quantity/); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toBeVisible();
});
test('[qa-database-knowledge#25] Unavailable source cannot be queried', async ({ page }) => { const { connection, template } = await querySetup(page); await control(page, { kind: 'database', available: false }); const denied = await page.request.post(`${ROOT}/connections/${connection.id}/query`, { data: { templateId: template.id, args: ['LOT-P1'] } }); expect(denied.ok()).toBe(false); const audit = await response<{ counters: { database: number } }>(page.request.get('/__test/knowledge/audit')); expect(audit.counters.database).toBe(0); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toHaveCount(0); });
test('[qa-database-knowledge#26] Parameterized Lot lookup stays inside approved project', async ({ page }) => {
  const { connection, template } = await querySetup(page); const fact = await post<{ rows: Record<string, unknown>[] }>(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }); expect(fact.rows.every(row => row.project_id === 'P-1')).toBe(true); expect((await post<{ rows: unknown[] }>(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P2'] })).rows).toEqual([]); await assertDenied(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }, OWNER_WITHOUT_PROJECT); await queryUi(page); await expect(page.getByRole('cell', { name: 'P-1', exact: true })).toBeVisible();
});
test('[qa-database-knowledge#27] Database column names do not split words', async ({ page }) => { await querySetup(page); await queryUi(page); const heading = page.getByRole('columnheader', { name: 'manufacturing_order_reference', exact: true }); await expect(heading).toBeVisible(); expect(await heading.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; })).toBe(1); });
test('[qa-database-knowledge#28] Last fact column is reachable through local horizontal scroll', async ({ page }) => { await querySetup(page); await queryUi(page); await page.setViewportSize({ width: 390, height: 844 }); const scroller = page.getByLabel('可横向滚动的查询结果', { exact: true }); await scroller.scrollIntoViewIfNeeded(); expect(await scroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true); await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; }); await expect(page.getByRole('columnheader', { name: 'final_quality_disposition', exact: true })).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); });
test('[qa-database-knowledge#30] Database capability cannot be changed to write in UI', async ({ page }) => { await refresh(page); await expect(page.locator('.database-source')).toContainText('独立只读'); await expect(page.locator('.database-source').getByRole('option', { name: /写入|write|delete/i })).toHaveCount(0); await expect(page.locator('.database-source').getByLabel(/执行模式|读写模式/)).toHaveCount(0); });
test('[qa-database-knowledge#31] Saving write effect is refused even if DOM is manipulated', async ({ page }) => {
  await refresh(page); await page.locator('.database-source form').first().evaluate(form => { const input = document.createElement('input'); input.name = 'effect'; input.value = 'write'; form.append(input); }); await assertDenied(page, '/connections', { name: 'forged DOM write', pluginId: 'database', readOnlyAcknowledged: true, effect: 'write', scope: { resourceId: DB_RESOURCE_ID } }); expect((await getOverview(page)).connections).toEqual([]); await expect(page.locator('.database-source')).toContainText('只读');
});
test('[qa-database-knowledge#33] Personal project options stay inside source permission', async ({ page }) => { await refresh(page); const overview = await getOverview(page); expect(overview.databaseResources.map(resource => resource.id)).toEqual([DB_RESOURCE_ID]); await expect(page.locator('.database-source')).not.toContainText('P-2'); const denied = await response<Overview>(page.request.get(`${ROOT}/overview`, { headers: { 'x-dev-user': OWNER_WITHOUT_PROJECT } })); expect(denied.databaseResources).toEqual([]); });
test('[qa-database-knowledge#34] Forged personal scope cannot expand source permission', async ({ page }) => {
  await assertDenied(page, '/connections', { name: 'expanded', pluginId: 'database', readOnlyAcknowledged: true, projectIds: ['P-2'], scope: { resourceId: DB_RESOURCE_ID, projectIds: ['P-2'] } }); await assertDenied(page, '/connections', { name: 'expanded', pluginId: 'database', readOnlyAcknowledged: true, scope: { resourceId: DB_RESOURCE_ID, tables: { payroll: { columns: ['salary'] } }, maxRows: 99999 } }); expect((await getOverview(page)).connections).toEqual([]); await refresh(page); await expect(page.locator('.database-source')).not.toContainText('payroll');
});
test('[qa-database-knowledge#35] Schema change withdraws source confirmation and invalidates old analysis', async ({ page }) => {
  const connection = await dbSource(page); await analyse(page); await control(page, { kind: 'database', schemaChanged: true }); await post(page, `/connections/${connection.id}/sync`); const overview = await getOverview(page); expect(overview.items.every(item => !item.confirmed)).toBe(true); expect(overview.analyses.some(run => run.status === 'stale')).toBe(true); await refresh(page); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-database-knowledge#36] Metadata reanalysis preserves human role edits', async ({ page }) => { const connection = await dbSource(page); await analyse(page); const retained = await lockRole(page, '数据分析员'); await control(page, { kind: 'database', schemaChanged: true }); await post(page, `/connections/${connection.id}/sync`); await confirmItems(page); await analyse(page); await expect(await openDraft(page, retained)).toContainText('人工锁定'); await expect(await openDraft(page, retained)).toContainText('分析提出了修改'); });

test('Local uploads stay searchable and their two internal connections are hidden', async ({ page }) => {
  const legacy = await post<{ id: string }>(page, '/connections', { name: 'from local', pluginId: 'local-file' });
  await post(page, `/connections/${legacy.id}/confirm`);
  await post(page, '/uploads', { connectionId: legacy.id, name: 'legacy.txt', text: 'Retained legacy evidence' });
  await confirmItems(page);
  await localFile(page);
  expect((await getOverview(page)).connections).toHaveLength(2);
  await openWorkspace(page, '资料库'); await expect(page.locator('#knowledge-items-list .mr-meta').filter({ hasText: 'legacy.txt' })).toBeVisible(); await openSources(page);
  await expect(page.locator('#knowledge-sources').getByText('from local', { exact: true })).toHaveCount(0);
  await expect(page.locator('#knowledge-sources').getByText('本地上传', { exact: true })).toHaveCount(0);
  const result = await response<{ hits: unknown[] }>(page.request.get(`${ROOT}/search?q=Retained`));
  expect(result.hits).toHaveLength(1);
});

test('MCP URL configuration reports an invalid address inline', async ({ page }) => {
  await configureCard(page, 'mcp');
  await page.getByLabel('MCP 地址', { exact: true }).fill('https://127.0.0.1/mcp');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.locator('#knowledge-sources').getByRole('alert')).toContainText('请输入公开可访问的 HTTPS MCP 地址');
});

test('[qa-source-plugins#1] Knowledge-source catalog includes MCP', async ({ page }) => { for (const id of ['local-file', 'mcp', 'database', 'email', 'sharepoint']) await expect(page.getByTestId(`plugin-${id}`)).toBeVisible(); expect((await getOverview(page)).plugins).toHaveLength(5); });
test('[qa-source-plugins#2] Built-in sources offer configuration without installation', async ({ page }) => { const overview = await getOverview(page); expect(overview.plugins.every(plugin => plugin.builtIn && plugin.installed)).toBe(true); await expect(page.getByTestId('plugin-local-file')).toContainText('自动接入'); await expect(page.locator('#knowledge-sources').getByRole('button', { name: /安装/ })).toHaveCount(0); });
test('[qa-source-plugins#3] Opening SharePoint configuration creates no connection or materials', async ({ page }) => { await configureCard(page, 'sharepoint'); await expect(page.getByRole('combobox', { name: /已批准的来源资源/ })).toBeVisible(); const overview = await getOverview(page); expect(overview.connections).toEqual([]); expect(overview.items).toEqual([]); });
test('[qa-source-plugins#6] Import does not imply source confirmation', async ({ page }) => { await localFile(page, false); await openWorkspace(page, '资料库'); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); expect((await getOverview(page)).items[0]!.confirmed).toBe(false); });
test('[qa-source-plugins#7] Opening email configuration does not connect a mailbox', async ({ page }) => { await configureCard(page, 'email'); await expect(page.getByRole('combobox', { name: /已批准的来源资源/ })).toBeVisible(); const overview = await getOverview(page); expect(overview.connections).toEqual([]); expect(overview.items).toEqual([]); });
test('[qa-source-plugins#9] Connection requires explicit read-only scope', async ({ page }) => {
  await refresh(page); await configureCard(page, 'email'); await page.getByLabel('连接名称', { exact: true }).fill('邮件范围'); await expect(page.getByRole('button', { name: '验证并连接', exact: true })).toBeDisabled(); await assertDenied(page, '/connections', { name: 'forged mail', pluginId: 'email', scope: { resourceId: MAIL_RESOURCE_ID } }); await page.getByLabel('我已核对来源范围，并确认仅以只读方式接入', { exact: true }).check(); const created = page.waitForResponse(result => result.url().endsWith('/knowledge/connections') && result.request().method() === 'POST'); await page.getByRole('button', { name: '验证并连接', exact: true }).click(); expect((await created).status()).toBe(201); expect((await getOverview(page)).connections[0]).toMatchObject({ name: '邮件范围', status: 'confirmed' });
});
test('[qa-source-plugins#11] Preview shows mailbox folder and date scope', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); const row = page.locator('.knowledge-source-list > li').filter({ has: page.getByText(connection.name, { exact: true }) }); await row.getByRole('button', { name: '预览来源范围与资料', exact: true }).click(); const preview = page.getByRole('region', { name: `${connection.name} 来源元数据预览` }); await expect(preview).toContainText('finance@synthetic.invalid'); await expect(preview).toContainText('Inbox'); await expect(preview).toContainText('2026-01-01'); await expect(preview).toContainText('权限受限资料：1'); await expect(preview).not.toContainText('禁止泄露的私人薪资标题');
});
test('[qa-source-plugins#14] Forged preview selection cannot bypass ACL', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); await assertDenied(page, `/connections/${connection.id}/import`, { ids: ['email-denied', 'forged-selection-hash'] }); await control(page, { kind: 'mail', acl: 'revoked' }); await assertDenied(page, `/connections/${connection.id}/import`, { ids: connection.preview.items.map(item => item.id) }); const audit = await response<{ counters: { email: number } }>(page.request.get('/__test/knowledge/audit')); expect(audit.counters.email).toBe(0); expect((await getOverview(page)).items).toEqual([]); await expect(page.locator('main')).not.toContainText('禁止泄露的私人薪资标题');
});
test('[qa-source-plugins#16] Imported mail independently awaits confirmation with references and versions', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); const row = page.locator('.knowledge-source-list > li').filter({ has: page.getByText(connection.name, { exact: true }) }); await row.getByRole('button', { name: '预览来源范围与资料', exact: true }).click(); const preview = page.getByRole('region', { name: `${connection.name} 来源元数据预览` }); await expect(preview.getByRole('checkbox')).toHaveCount(1); await preview.getByRole('checkbox').check(); const imported = page.waitForResponse(result => result.url().endsWith(`/connections/${connection.id}/import`)); await preview.getByRole('button', { name: '导入所选资料（1）', exact: true }).click(); expect((await imported).ok()).toBe(true); await openWorkspace(page, '资料库'); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); const item = (await getOverview(page)).items[0]!; expect(item.confirmed).toBe(false); expect(item.version).toBe('v1'); expect(item.locator).toContain('synthetic-mail://'); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#17] Confirmed mixed knowledge creates evidence-based candidates', async ({ page }) => {
  await remoteSource(page, 'email'); await remoteSource(page, 'sharepoint'); await analyse(page); const roles = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee'); expect(roles).toHaveLength(4); expect(new Set(roles.flatMap(role => role.evidence.map(evidence => evidence.sourceId))).size).toBe(2); for (const role of roles) { expect(role.evidence.length).toBeGreaterThan(0); await expect(await openDraft(page, role.name)).toBeVisible(); }
});
test('[qa-source-plugins#20] Delta does not overwrite human role edit', async ({ page }) => { const connection = await remoteSource(page, 'email'); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'mail', text: '角色：采购专员；责任：核对新增供应商与采购版本。' }); await post(page, `/connections/${connection.id}/sync`); await refresh(page); await expect(await openDraft(page, retained)).toBeVisible(); expect((await getOverview(page)).recommendations.find(rec => rec.name === retained)!.description).toBe('这是人工核对后保留的说明。'); });
test('[qa-source-plugins#21] Reanalysis preserves human edits', async ({ page }) => { const connection = await remoteSource(page, 'email'); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'mail', text: '角色：采购专员；责任：核对新增供应商与采购版本。' }); await post(page, `/connections/${connection.id}/sync`); await confirmItems(page); await analyse(page); await expect(await openDraft(page, retained)).toContainText('分析提出了修改'); expect((await getOverview(page)).recommendations.find(rec => rec.name === retained)!.proposedChange?.description).toContain('新增供应商'); });
test('[qa-source-plugins#23] Recovery requires source confirmation again', async ({ page }) => {
  const connection = await remoteSource(page, 'email'); await control(page, { kind: 'mail', acl: 'unknown' }); await post(page, `/connections/${connection.id}/sync`); expect((await getOverview(page)).items).toEqual([]); await control(page, { kind: 'mail', acl: 'allowed', bumpVersion: true }); await post(page, `/connections/${connection.id}/sync`); await refresh(page); expect((await getOverview(page)).items.every(item => !item.confirmed)).toBe(true); await openWorkspace(page, '资料库'); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#25] Forged source confirmation cannot override revoked ACL', async ({ page }) => {
  const connection = await remoteSource(page, 'email'); const item = (await getOverview(page)).items[0]!; await control(page, { kind: 'mail', acl: 'revoked' }); await assertDenied(page, `/items/${item.id}/confirm`, { version: item.version }); await post(page, `/connections/${connection.id}/sync`); await assertDenied(page, `/items/${item.id}/confirm`, { version: item.version }); await refresh(page); expect((await getOverview(page)).items).toEqual([]); await openWorkspace(page, '分类与候选'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#28] Paused knowledge plugin blocks its source references', async ({ page }) => {
  await remoteSource(page, 'email'); await analyse(page); await openSources(page); await page.getByRole('button', { name: '暂停企业邮件', exact: true }).click(); await expect(page.getByTestId('plugin-email')).toContainText('已暂停'); expect((await getOverview(page)).items).toEqual([]); expect((await getOverview(page)).recommendations).toEqual([]); const search = await response<{ hits: unknown[] }>(page.request.get(`${ROOT}/search?q=${encodeURIComponent('采购')}`)); expect(search.hits).toEqual([]); await expect(card(page, '采购专员')).toHaveCount(0);
});
test('[qa-source-plugins#29] Database plugin leads to existing scoped read-only configuration', async ({ page }) => { await configureCard(page, 'database'); await expect(page.getByRole('heading', { name: '只读数据库来源', exact: true })).toBeInViewport(); await expect(page.getByLabel('DBA 批准的资源')).toBeVisible(); await expect(page.locator('.database-source-scope')).toContainText('approved_lots'); });
test('[qa-source-plugins#30] Installing knowledge plugins did not install employee business tools', async ({ page }) => { const before = await response(page.request.get('/api/v1/tools/')); for (const id of ['database', 'email', 'sharepoint']) await install(page, id); expect(await response(page.request.get('/api/v1/tools/'))).toEqual(before); expect((await getOverview(page)).connections).toEqual([]); await refresh(page); await expect(page.getByTestId('plugin-email')).toContainText('待配置'); });

test('[qa-enablement#52] No browser errors or imported script execution', async ({ page }) => {
  const hostile = ['角色：采购专员；责任：核对采购申请。', '<script>window.__kbPwned = 1</script>', '<img src="x" onerror="window.__kbPwned = 2">'].join('\n');
  await localFile(page, false, hostile);
  await page.getByText('查看当前版本原文与定位', { exact: true }).click();
  const preview = page.locator('.knowledge-item-preview');
  await expect(preview).toContainText('<script>window.__kbPwned = 1</script>');
  await expect(preview.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __kbPwned?: number }).__kbPwned)).toBeUndefined();
});

test('[qa-database-knowledge#38] No browser errors or real SQL execution', async ({ page }) => {
  const { connection } = await querySetup(page);
  const reads = async () => (await response<{ counters: { database: number } }>(page.request.get('/__test/knowledge/audit'))).counters.database;
  const before = await reads();
  for (const sql of ['DELETE FROM approved_lots WHERE lot_id = $1', 'UPDATE approved_lots SET quantity = 0 WHERE lot_id = $1', `${SQL}; DROP TABLE approved_lots`]) {
    const refused = await page.request.post(`${ROOT}/connections/${connection.id}/templates`, { data: { sql, params: ['lot_id'] } });
    expect(refused.status(), sql).toBe(422);
  }
  expect(await reads()).toBe(before);
  await queryUi(page);
  await expect(page.getByRole('cell', { name: 'LOT-P1', exact: true })).toBeVisible();
});

test('a saved team size proposal is preselected and applies with one click', async ({ page }) => {
  await response(page.request.post('/__test/knowledge/reset', { data: {} }));
  const EIGHT = ['采购专员', '财务专员', '仓储专员', '业务主管', '客服专员', '质检专员', '物流专员', '合同专员']
    .map((name, i) => `角色：${name}；责任：负责第${i + 1}类业务的核对与登记。`).concat('工具：只读单据查询；职责：按编号查证业务记录。').join(String.fromCharCode(10));
  await localFile(page, true, EIGHT); await analyse(page);
  await page.goto('/#employees?view=draft');
  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  await page.goto('/#employees');
  await expect(page.locator('[data-employee^="emp-org-"]')).toHaveCount(8);

  await response(page.request.post('/api/v1/knowledge/organization/plan', { data: { count: 2 } }));
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: '数字员工人数' })).toHaveValue('2');
  await page.getByRole('button', { name: '调整为 2 人', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '移除 8 名' })).toBeVisible();
  await page.goto('/#employees');
  await expect(page.locator('[data-employee^="emp-org-"]')).toHaveCount(2);
  const registry = await (await page.request.get('/api/v1/employees/')).json() as { id: string }[];
  const team = registry.filter(e => e.id.startsWith('emp-org-'));
  expect(team).toHaveLength(2);
  // The command room offers exactly these two team employees for assignment.
  await page.goto('/#room');
  await page.getByRole('button', { name: '团队', exact: true }).click();
  await expect(page.locator('#room-team [data-team-member^="emp-org-"]')).toHaveCount(2);
  for (const e of team) await expect(page.locator(`#room-team [data-team-member="${e.id}"]`)).toBeVisible();
  // Leave no draft or team behind for later files (the shell spec checks the empty state).
  await response(page.request.post('/__test/knowledge/reset', { data: {} }));
});

test('one team size submission leaves one employee and that employee can be bound to Link from the web', async ({ page }) => {
  await response(page.request.post('/__test/knowledge/reset', { data: {} }));
  const TWELVE = ['采购专员', '财务专员', '仓储专员', '业务主管', '客服专员', '质检专员', '物流专员', '合同专员', '订单专员', '信用专员', '出纳专员', '复核专员']
    .map((name, i) => `角色：${name}；责任：负责第${i + 1}类业务的核对与登记。`).concat('工具：只读单据查询；职责：按编号查证业务记录。').join(String.fromCharCode(10));
  await localFile(page, true, TWELVE); await analyse(page);
  await page.goto('/#employees?view=draft');
  await page.getByRole('button', { name: '创建团队', exact: true }).click();
  await page.goto('/#employees');
  await expect(page.locator('[data-employee^="emp-org-"]')).toHaveCount(12);

  await page.locator('.team-size-stepper input').fill('1');
  await page.getByRole('button', { name: '调整为 1 人', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '移除 12 名' })).toBeVisible();
  await page.goto('/#employees');
  await expect(page.locator('[data-employee^="emp-org-"]')).toHaveCount(1);
  const registry = await (await page.request.get('/api/v1/employees/')).json() as { id: string; name: string }[];
  const team = registry.filter(e => e.id.startsWith('emp-org-'));
  expect(team).toHaveLength(1);
  await page.goto('/#room');
  await page.getByRole('button', { name: '团队', exact: true }).click();
  await expect(page.locator('#room-team [data-team-member^="emp-org-"]')).toHaveCount(1);
  await expect(page.locator(`#room-team [data-team-member="${team[0]!.id}"]`)).toBeVisible();

  const device = await response<{ token: string; worker: { id: string } }>(
    page.request.post('/api/v1/workers', { data: { name: 'E2E Link', kind: 'link' } }),
  );
  const workerHeaders = { authorization: `Bearer ${device.token}` };
  const projectId = 'e2e-link-project';
  await response(page.request.post('/api/v1/worker-link/heartbeat', { headers: workerHeaders, data: {
    capabilities: { agents: ['codex'], projects: [{ id: projectId, name: 'Orders', agent: 'codex' }] },
  } }));
  try {
    await page.goto('/#employees');
    await page.locator(`[data-employee="${team[0]!.id}"]`).getByRole('link', { name: '管理 Link' }).click();
    const card = page.locator('[data-worker]').filter({ hasText: 'E2E Link' });
    await expect(card.getByText('在线', { exact: true })).toBeVisible();
    await expect(card.getByLabel('本地项目')).toHaveValue(projectId);
    await expect(card.getByLabel('数字员工')).toHaveValue(team[0]!.id);
    await card.getByRole('button', { name: '绑定员工', exact: true }).click();
    await expect(card.getByRole('button', { name: '移除绑定' })).toBeVisible();
    await page.goto('/#employees');
    await expect(page.getByText('已绑定 · 可接任务')).toBeVisible();

    const posted = await response<{ task: { id: string; projectId: string } }>(page.request.post('/api/v1/room/messages', { data: {
      roomId: 'room-1', clientMessageId: 'resize-and-bind-e2e', body: `@${team[0]!.name} Summarize the orders in this folder.`,
    } }));
    expect(posted.task.projectId).toBe(projectId);
    const poll = await response<{ events: unknown[] }>(page.request.post('/api/v1/worker-link/poll', {
      headers: workerHeaders, data: { waitMs: 0 },
    }));
    expect(poll.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'wake', payload: expect.objectContaining({ roomTaskId: posted.task.id, projectId }),
    })]));
    await response(page.request.post(`/api/v1/worker-link/room-tasks/${posted.task.id}/report`, {
      headers: workerHeaders, data: { body: 'Summary ready.' },
    }));
  } finally {
    await response(page.request.post(`/api/v1/workers/${device.worker.id}/revoke`, { data: {} }));
    await response(page.request.post('/__test/knowledge/reset', { data: {} }));
  }
});

test('Workflows / SOP opens on the extracted flowchart when the only workflow is a private MCP draft', async ({ page }) => {
  await response(page.request.post('/__test/knowledge/seed-live-mcp', { data: {} }));
  await page.reload();
  await openWorkspace(page, '分类与候选');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByRole('button', { name: '分析进行中', exact: true })).toBeDisabled();
  await response(page.request.post('/__test/knowledge/advance', { data: {} }));
  // No saved (published or draft) workflow in this workspace yet.
  await addLegacyWorkflowDrafts(page);
  await page.route('**/api/v1/sop', route => route.fulfill({ status: 200, json: { sops: [] } }));
  await page.goto('/#knowledge?view=sop');
  await page.reload();
  const sw = page.getByRole('group', { name: '工作流视图' });
  await expect(sw.getByRole('button', { name: /从知识提取 SOP/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: /从知识提取 SOP/ })).toContainText('(1)');
  const drafts = page.getByRole('region', { name: /候选流程|分析结果/ });
  await expect(drafts.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
  await expect(drafts.getByRole('group', { name: '流程图', exact: true }).locator('[data-edge="check:record"]')).toHaveAttribute('marker-end', /url/);
  await expect(drafts.getByText(/CRM操作指南|系统规则|客户对象|订单流程/)).toHaveCount(0);
  if (process.env.T23_SHOTS) await page.screenshot({ path: '../../deliverables/v12-compare-t23/workflow-candidates-zh.png', fullPage: true });
  // An explicit choice is kept.
  await sw.getByRole('button', { name: '已发布图与草稿图' }).click();
  await expect(sw.getByRole('button', { name: '已发布图与草稿图' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/sub=flows/);
});

test('Workflows / SOP does not treat a failed workflow list as empty', async ({ page }) => {
  await page.route('**/api/v1/sop', route => route.fulfill({ status: 200, json: { error: 'unavailable' } }));
  await page.goto('/#knowledge?view=sop');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('无法读取已发布图与草稿图');
  await expect(page.getByRole('heading', { name: '还没有工作流' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试读取知识状态' })).toBeVisible();
});

test('Workflows / SOP says how to get a workflow when there is none', async ({ page }) => {
  await page.route('**/api/v1/sop', route => route.fulfill({ status: 200, json: { sops: [] } }));
  await page.goto('/#knowledge?view=sop');
  await page.reload();
  const empty = page.locator('.knowledge-flow-empty');
  await expect(empty.getByRole('heading', { name: '还没有工作流' })).toBeVisible();
  await expect(empty.getByRole('link', { name: '打开资料库' })).toHaveAttribute('href', '#knowledge');
  await expect(page.getByLabel('选择流程')).toHaveCount(0);
});

test.describe('English Workflows / SOP empty and MCP-only panes', () => {
  test.use({ lang: 'en' });

  test('Workflows / SOP opens on the extracted flowchart when the only workflow is a private MCP draft (en)', async ({ page }) => {
    await response(page.request.post('/__test/knowledge/seed-live-mcp', { data: {} }));
    await page.reload();
    await page.getByRole('navigation', { name: 'Knowledge workspace' }).getByRole('button', { name: 'Classification & candidates', exact: true }).click();
    await page.getByRole('button', { name: 'Start analysis', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Analysis running', exact: true })).toBeDisabled();
    await response(page.request.post('/__test/knowledge/advance', { data: {} }));
    await addLegacyWorkflowDrafts(page);
    await page.route('**/api/v1/sop', route => route.fulfill({ status: 200, json: { sops: [] } }));
    await page.goto('/#knowledge?view=sop');
    await page.reload();
    const sw = page.getByRole('group', { name: 'Workflow view' });
    await expect(sw.getByRole('button', { name: /Extract SOP from knowledge/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sw.getByRole('button', { name: /Extract SOP from knowledge/ })).toContainText('(1)');
    const drafts = page.getByRole('region', { name: /Workflow candidates|Analysis results/ });
    await expect(drafts.getByRole('heading', { name: '退货审核流程' })).toBeVisible();
    await expect(drafts.getByRole('group', { name: 'Flow chart', exact: true }).locator('[data-edge="check:record"]')).toHaveAttribute('marker-end', /url/);
    await expect(drafts.getByText(/CRM操作指南|系统规则|客户对象|订单流程/)).toHaveCount(0);
    if (process.env.T23_SHOTS) await page.screenshot({ path: '../../deliverables/v12-compare-t23/workflow-candidates-en.png', fullPage: true });
  });

  test('Workflows / SOP says how to get a workflow when there is none (en)', async ({ page }) => {
    await page.route('**/api/v1/sop', route => route.fulfill({ status: 200, json: { sops: [] } }));
    await page.goto('/#knowledge?view=sop');
    await page.reload();
    const empty = page.locator('.knowledge-flow-empty');
    await expect(empty.getByRole('heading', { name: 'No workflows yet' })).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Open the Library' })).toHaveAttribute('href', '#knowledge');
    await expect(page.getByLabel('Select workflow')).toHaveCount(0);
    await expect(page.getByLabel('选择流程')).toHaveCount(0);
  });
});

test.describe('T-24 ontology default scope with companyName and personal MCP drafts', () => {
  const evidence = [{ sourceId: 'mcp-1', version: 'v1', start: 0, end: 8, locator: 'crm://leads', quote: '报价单由销售顾问跟进并关联客户档案。' }];
  const mcpDrafts = [
    { id: 'o1', key: 'customer', kind: 'object', name: '客户档案', description: '客户主数据', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', privateMcp: { sourceId: 'mcp-1', sourceName: 'CRM MCP' }, evidence },
    { id: 'o2', key: 'quote', kind: 'object', name: '报价单', description: '销售报价单', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', privateMcp: { sourceId: 'mcp-1', sourceName: 'CRM MCP' }, evidence },
    { id: 'r1', key: 'quote-customer', kind: 'relation', name: '报价关联客户', description: '报价单关联客户档案', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', privateMcp: { sourceId: 'mcp-1', sourceName: 'CRM MCP' }, relation: { from: 'quote', to: 'customer', label: '关联' }, evidence },
  ];

  async function seedAndOpen(page: import('@playwright/test').Page) {
    const existing = await page.request.get('/api/v1/sop/company-context');
    const version = ((await existing.json()) as { context?: { version?: number } }).context?.version ?? 0;
    const saved = await page.request.put('/api/v1/sop/company-context', {
      data: { name: 'VERA Shading', goal: '跟进客户报价', boundaries: '需保留报价记录', expectedVersion: version },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await page.route('**/api/v1/knowledge/overview**', async route => {
      const response = await route.fetch();
      const json = await response.json() as { recommendations?: unknown[]; mcpRecommendations?: unknown[]; analyses?: unknown[] };
      json.recommendations = [];
      json.mcpRecommendations = mcpDrafts;
      json.analyses = [{ id: 'a1', status: 'completed', createdAt: '2026-11-03T00:00:00.000Z' }];
      await route.fulfill({ json });
    });
    await page.goto('/#knowledge?view=graph&at=2026-09-15&known=2026-11-08');
    await page.reload();
  }

  test('defaults to all sources in zh so company and MCP share one graph', async ({ page }) => {
    await seedAndOpen(page);
    const ontology = page.locator('section.onto');
    await expect(ontology).toBeVisible();
    await expect(ontology.getByRole('tab', { name: /全部来源/ })).toHaveAttribute('aria-selected', 'true');
    await expect(ontology.locator('.onto-node')).toHaveCount(4);
    await expect(ontology.locator('.onto-link-line')).toHaveCount(3);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: t33Shot('t33-ontology-1440-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: t33Shot('t33-ontology-375-zh.png'), fullPage: true });
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('defaults to all sources in en so company and MCP share one graph', async ({ page }) => {
      await seedAndOpen(page);
      const ontology = page.locator('section.onto');
      await expect(ontology).toBeVisible();
      await expect(ontology.getByRole('tab', { name: /All sources/ })).toHaveAttribute('aria-selected', 'true');
      await expect(ontology.locator('.onto-node')).toHaveCount(4);
      await expect(ontology.locator('.onto-link-line')).toHaveCount(3);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: t33Shot('t33-ontology-1440-en.png'), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: t33Shot('t33-ontology-375-en.png'), fullPage: true });
    });
  });
});

test.describe('T-27 admin tenant knowledge reset', () => {
  test('zh: admin resets tenant knowledge base with preview, then re-uploads and analyzes', async ({ page }) => {
    await page.request.post('/__test/knowledge/reset', { data: {} });
    await localFile(page, true);
    await response(page.request.post('/api/v1/knowledge/analyses', { data: {} }));
    await response(page.request.post('/__test/knowledge/advance', { data: {} }));

    await page.goto('/#settings');
    await page.reload();
    const resetBtn = page.getByRole('button', { name: '清空本租户知识库', exact: true });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    const dialog = page.getByRole('dialog', { name: '确认清空本租户知识库' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('知识源 1');
    if (process.env.T27_SHOTS) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: '../../deliverables/v12-compare-t27/t27-reset-dialog-1440-zh.png', fullPage: true });
    }

    const confirmBtn = dialog.getByRole('button', { name: '确认清空', exact: true });
    await expect(confirmBtn).toBeDisabled();
    await dialog.getByRole('textbox').fill('RESET');
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByRole('status').filter({ hasText: '已清空本租户知识库' })).toBeVisible();

    await page.goto('/#knowledge');
    await page.reload();
    await expect(page.getByText('还没有资料。', { exact: true })).toBeVisible();
    if (process.env.T27_SHOTS) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: '../../deliverables/v12-compare-t27/t27-reset-empty-1440-zh.png', fullPage: true });
    }

    await localFile(page, true);
    await response(page.request.post('/api/v1/knowledge/analyses', { data: {} }));
    await response(page.request.post('/__test/knowledge/advance', { data: {} }));
    const overview = await getOverview(page);
    expect(overview.items.length).toBeGreaterThan(0);
    expect(overview.recommendations.length).toBeGreaterThan(0);
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en: admin resets tenant knowledge base with preview and sees empty library', async ({ page }) => {
      await page.request.post('/__test/knowledge/reset', { data: {} });
      const connection = await post<{ id: string }>(page, '/connections', { name: 'Local materials', pluginId: 'local-file', scope: {} });
      await post(page, `/connections/${connection.id}/confirm`);
      await post(page, '/uploads', { connectionId: connection.id, name: 'ops.md', text: ROLE_FILE });
      await confirmItems(page);
      await response(page.request.post('/api/v1/knowledge/analyses', { data: {} }));
      await response(page.request.post('/__test/knowledge/advance', { data: {} }));

      await page.goto('/#settings');
      await page.reload();
      const resetBtn = page.getByRole('button', { name: 'Reset tenant knowledge base', exact: true });
      await expect(resetBtn).toBeVisible();
      await resetBtn.click();

      const dialog = page.getByRole('dialog', { name: 'Confirm tenant knowledge base reset' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Sources: 1');
      if (process.env.T27_SHOTS) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: '../../deliverables/v12-compare-t27/t27-reset-dialog-1440-en.png', fullPage: true });
      }

      const confirmBtn = dialog.getByRole('button', { name: 'Confirm reset', exact: true });
      await expect(confirmBtn).toBeDisabled();
      await dialog.getByRole('textbox').fill('RESET');
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();
      await expect(page.getByRole('status').filter({ hasText: 'Tenant knowledge base cleared.' })).toBeVisible();

      await page.goto('/#knowledge');
      await page.reload();
      await expect(page.getByText('No materials yet.', { exact: true })).toBeVisible();
      if (process.env.T27_SHOTS) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: '../../deliverables/v12-compare-t27/t27-reset-empty-1440-en.png', fullPage: true });
      }
    });
  });
});
