import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('D:/workspace/super agent/superagent-t16/deliverables/v12-compare-t16');
mkdirSync(DIR, { recursive: true });

test.skip(!process.env.T16_SHOTS, 'set T16_SHOTS=1 to capture T-16 evidence screenshots');

async function shot(page: Page, name: string, lang: 'zh' | 'en') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(DIR, `${name}-1440-${lang}.png`), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: resolve(DIR, `${name}-375-${lang}.png`), fullPage: true });
}

async function fillCompany(page: Page, lang: 'zh' | 'en') {
  await page.goto('/#brain');
  await expect(page.getByLabel(lang === 'zh' ? '企业名称' : 'Company name')).toBeEnabled();
  if (lang === 'zh') {
    await page.getByLabel('企业名称').fill('测试财务部');
    await page.getByLabel('希望交给数字团队的工作').fill('核对供应商发票并完成付款登记');
    await page.getByLabel('必须遵守的边界').fill('审批人确认后才能登记付款');
  } else {
    await page.getByLabel('Company name').fill('Test finance');
    await page.getByLabel('Work to hand to the digital team').fill('Match supplier invoices and register payment');
    await page.getByLabel('Boundaries that must be followed').fill('A person must approve before payment is registered');
  }
}

test.describe('T-08 company setup shots', () => {
  test('zh save and publish-fail', async ({ page }) => {
    await fillCompany(page, 'zh');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toBeVisible();
    await shot(page, 't08-save', 'zh');

    await page.route('**/api/v1/sop/company-context', async route => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 400, json: { error: 'invalid_company_context' } });
      return route.continue();
    });
    await page.reload();
    await fillCompany(page, 'zh');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '无法保存配置' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toHaveCount(0);
    await shot(page, 't08-publish-fail', 'zh');
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en save and publish-fail', async ({ page }) => {
      await fillCompany(page, 'en');
      await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved configuration' })).toBeVisible();
      await shot(page, 't08-save', 'en');

      await page.route('**/api/v1/sop/company-context', async route => {
        if (route.request().method() === 'PUT') return route.fulfill({ status: 400, json: { error: 'invalid_company_context' } });
        return route.continue();
      });
      await page.reload();
      await fillCompany(page, 'en');
      await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Could not save the configuration' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Saved configuration' })).toHaveCount(0);
      await shot(page, 't08-publish-fail', 'en');
    });
  });
});

const GRAPH_EVIDENCE = [{ sourceId: 's', version: 'v1', start: 0, end: 8, locator: 'policy.md#L4', quote: '审批阈值自 2026-08-01 起生效，2026-10-31 截止。' }];
const GRAPH_DRAFTS = [
  { id: 'o1', key: 'order', kind: 'object', name: '订单', description: '客户提交的订单', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', evidence: GRAPH_EVIDENCE },
  { id: 'o2', key: 'approval', kind: 'object', name: '主管审批', description: '主管复核', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', evidence: GRAPH_EVIDENCE },
  { id: 'r1', key: 'threshold', kind: 'relation', name: '审批阈值', description: '审批阈值自 2026-08-01 起生效。', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31', relation: { from: 'order', to: 'approval', label: '超阈值需' }, evidence: GRAPH_EVIDENCE },
];

async function seedCompanyGraph(page: Page) {
  await page.request.post('/__test/knowledge/reset', { data: {} });
  const existing = await page.request.get('/api/v1/sop/company-context');
  const version = ((await existing.json()) as { context?: { version?: number } }).context?.version ?? 0;
  const saved = await page.request.put('/api/v1/sop/company-context', {
    data: { name: 'ISWELL', goal: '核对供应商发票并完成付款登记', boundaries: '审批人确认后才能登记付款', expectedVersion: version },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.route('**/api/v1/knowledge/overview', async route => {
    const response = await route.fetch();
    const json = await response.json() as { recommendations?: unknown[]; analyses?: unknown[] };
    json.recommendations = GRAPH_DRAFTS;
    json.analyses = [{ id: 'a1', status: 'completed', createdAt: '2026-11-03T00:00:00.000Z' }];
    await route.fulfill({ json });
  });
}

async function openCompanyGraph(page: Page, lang: 'zh' | 'en') {
  await page.goto('/#knowledge?view=graph&at=2026-09-15&known=2026-11-08');
  const ontology = page.locator('section.onto');
  await expect(ontology).toBeVisible();
  await expect(ontology).toContainText('ISWELL');
  await ontology.locator('.onto-panel').getByRole('button', { name: '订单', exact: true }).or(ontology.locator('.onto-panel').getByRole('button', { name: '订单' })).click();
  const panel = ontology.locator('.onto-panel');
  await expect(panel).toContainText(lang === 'zh' ? '业务时间' : 'Business date');
  await expect(panel).toContainText('2026-08-01');
  await expect(panel).toContainText('2026-11-03');
  await expect(panel).toContainText('policy.md#L4');
  await expect(panel).toContainText('超阈值需');
  await expect(panel).toContainText('主管审批');
  await expect(panel).toContainText(lang === 'zh' ? '知识截至' : 'Known to the platform by');
  await expect(panel).toContainText('2026-11-08');
}

test.describe('T-09 ontology shots', () => {
  test.use({ extraHTTPHeaders: { 'x-dev-user': 'e2e-knowledge-owner|owner|P-1' } });
  test('zh knowledge graph company detail', async ({ page }) => {
    await seedCompanyGraph(page);
    await openCompanyGraph(page, 'zh');
    await shot(page, 't09-ontology', 'zh');
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en knowledge graph company detail', async ({ page }) => {
      await seedCompanyGraph(page);
      await openCompanyGraph(page, 'en');
      await shot(page, 't09-ontology', 'en');
    });
  });
});

const confirmedOrg = {
  employees: [], tools: [], sops: [],
  confirmation: { confirmedAt: '2026-11-17T00:00:00.000Z', revision: 1, employees: 1, tools: 0 },
  changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
};

async function mockOrg(page: Page) {
  await page.route('**/api/v1/knowledge/organization**', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(confirmedOrg) });
  });
}

async function shotEl(page: Page, locator: import('@playwright/test').Locator, name: string, lang: 'zh' | 'en') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await locator.screenshot({ path: resolve(DIR, `${name}-1440-${lang}.png`) });
  await page.setViewportSize({ width: 375, height: 812 });
  await locator.screenshot({ path: resolve(DIR, `${name}-375-${lang}.png`) });
}

test.describe('T-11 employee drawer shots', () => {
  test('zh empty, filled feedback, and drawer', async ({ page, request }) => {
    const created = await request.post('/api/v1/employees/', {
      data: { name: 'T16订单审核员', duty: '核对信用额度', prompt: '按制度核对订单', source: 'manual' },
    });
    expect(created.ok()).toBeTruthy();
    const employee = await created.json() as { id: string };
    await mockOrg(page);
    await page.goto('/#employees');
    const feedback = page.getByRole('region', { name: /员工反馈与能力申请/ });
    await expect(feedback).toBeVisible();
    await shotEl(page, feedback, 't11-empty', 'zh');

    expect((await request.post('/api/v1/work-items/', {
      data: { kind: 'data_check', assigneeUserId: 'e2e-owner', payload: { title: '核对额度反馈', employeeId: employee.id } },
    })).ok()).toBeTruthy();
    expect((await request.post('/api/v1/tools/', {
      data: {
        name: '额度查询占位',
        contract: { toolId: 't16.quota.lookup', action: 'lookup', purpose: 'query', targetSystem: 'erp', effect: 'read', input: { type: 'object' }, output: { type: 'object' }, risk: 'low' },
        acceptanceCases: ['normal'], consumers: [employee.id],
      },
    })).ok()).toBeTruthy();
    await page.reload();
    await expect(feedback.getByText('核对额度反馈')).toBeVisible();
    await expect(feedback.getByText(/额度查询占位/)).toBeVisible();
    await shotEl(page, feedback, 't11-feedback', 'zh');

    await page.locator('.emp-card').filter({ hasText: 'T16订单审核员' }).getByRole('button', { name: '管理', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '管理 T16订单审核员' });
    await expect(drawer.getByRole('button', { name: '暂停' })).toBeVisible();
    await shotEl(page, drawer, 't11-drawer', 'zh');
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en empty, filled feedback, and drawer', async ({ page, request }) => {
      const created = await request.post('/api/v1/employees/', {
        data: { name: 'T16 Order reviewer', duty: 'Check credit limit', prompt: 'Follow the policy', source: 'manual' },
      });
      expect(created.ok()).toBeTruthy();
      const employee = await created.json() as { id: string };
      await mockOrg(page);
      await page.goto('/#employees');
      const feedback = page.getByRole('heading', { name: /Employee feedback/ }).locator('..');
      await expect(feedback).toBeVisible();
      await shotEl(page, feedback, 't11-empty', 'en');

      expect((await request.post('/api/v1/work-items/', {
        data: { kind: 'data_check', assigneeUserId: 'e2e-owner', payload: { title: 'Credit-limit feedback', employeeId: employee.id } },
      })).ok()).toBeTruthy();
      expect((await request.post('/api/v1/tools/', {
        data: {
          name: 'Quota lookup placeholder',
          contract: { toolId: 't16.quota.lookup.en', action: 'lookup', purpose: 'query', targetSystem: 'erp', effect: 'read', input: { type: 'object' }, output: { type: 'object' }, risk: 'low' },
          acceptanceCases: ['normal'], consumers: [employee.id],
        },
      })).ok()).toBeTruthy();
      await page.reload();
      await expect(page.getByText('Credit-limit feedback')).toBeVisible();
      await expect(page.getByText(/Quota lookup placeholder/)).toBeVisible();
      await shotEl(page, page.locator('.emp-feedback'), 't11-feedback', 'en');

      await page.locator('.emp-card').filter({ hasText: 'T16 Order reviewer' }).getByRole('button', { name: 'Manage', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: /Manage T16 Order reviewer/ });
      await expect(drawer.getByRole('button', { name: 'Pause' })).toBeVisible();
      await shotEl(page, drawer, 't11-drawer', 'en');
    });
  });
});
