import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('D:/workspace/super agent/superagent-t16/deliverables/v12-compare-t16');
mkdirSync(DIR, { recursive: true });

test.skip(!process.env.T16_SHOTS, 'set T16_SHOTS=1 to capture T-16 evidence screenshots');

const readyOrg = {
  employees: [{ id: 'role-1', name: '应付专员', tools: [], sops: [] }],
  tools: [], sops: [], confirmation: null, changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
};

async function shot(page: Page, name: string, lang: 'zh' | 'en') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(DIR, `${name}-1440-${lang}.png`), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: resolve(DIR, `${name}-375-${lang}.png`), fullPage: true });
}

async function fillCompany(page: Page, lang: 'zh' | 'en') {
  await page.goto('/#brain');
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

    await page.route('**/api/v1/knowledge/organization**', async route => {
      if (route.request().method() === 'POST' && route.request().url().endsWith('/confirm')) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'generic' }) });
      }
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyOrg) });
    });
    await page.reload();
    await fillCompany(page, 'zh');
    await expect(page.getByRole('button', { name: '确认并发布配置，生成数字员工' })).toBeEnabled();
    await page.getByRole('button', { name: '确认并发布配置，生成数字员工' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '无法生成数字员工' })).toBeVisible();
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

      await page.route('**/api/v1/knowledge/organization**', async route => {
        if (route.request().method() === 'POST' && route.request().url().endsWith('/confirm')) {
          return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'generic' }) });
        }
        if (route.request().method() !== 'GET') return route.continue();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyOrg) });
      });
      await page.reload();
      await fillCompany(page, 'en');
      await expect(page.getByRole('button', { name: 'Confirm and publish configuration, generate digital employees' })).toBeEnabled();
      await page.getByRole('button', { name: 'Confirm and publish configuration, generate digital employees' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Could not generate digital employees' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Saved configuration' })).toHaveCount(0);
      await shot(page, 't08-publish-fail', 'en');
    });
  });
});

async function seedOntology(page: Page) {
  await page.request.post('/__test/knowledge/reset', { data: {} });
  const seeded = await page.request.post('/__test/knowledge/seed-live-mcp', { data: {} });
  expect(seeded.ok()).toBeTruthy();
  const { id } = await seeded.json() as { id: string };
  const started = await page.request.post('/api/v1/knowledge/analyses', { data: { mcpSourceIds: [id] } });
  expect(started.ok()).toBeTruthy();
  await page.request.post('/__test/knowledge/advance', { data: {} });
}

test.describe('T-09 ontology shots', () => {
  test.use({ extraHTTPHeaders: { 'x-dev-user': 'e2e-knowledge-owner|owner|P-1' } });
  test('zh ontology detail', async ({ page }) => {
    await seedOntology(page);
    await page.goto('/#brain?tab=ontology');
    const ontology = page.getByRole('region', { name: '本体关系图', exact: true });
    await expect(ontology.getByRole('img', { name: /个实体 ·/ })).toBeVisible();
    await ontology.locator('.onto-panel').getByRole('button', { name: /退货记录/ }).click();
    await expect(ontology.locator('.onto-panel')).toContainText('退货手册 MCP');
    await shot(page, 't09-ontology', 'zh');
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en ontology detail', async ({ page }) => {
      await seedOntology(page);
      await page.goto('/#brain?tab=ontology');
      const ontology = page.getByRole('region', { name: 'Ontology graph', exact: true });
      await expect(ontology).toBeVisible();
      await ontology.locator('.onto-panel').getByRole('button').first().click();
      await shot(page, 't09-ontology', 'en');
    });
  });
});

test.describe('T-11 employee drawer shots', () => {
  test('zh drawer and feedback', async ({ page, request }) => {
    const created = await request.post('/api/v1/employees/', {
      data: { name: 'T16订单审核员', duty: '核对信用额度', prompt: '按制度核对订单', source: 'manual' },
    });
    expect(created.ok()).toBeTruthy();
    await page.route('**/api/v1/knowledge/organization**', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          employees: [], tools: [], sops: [],
          confirmation: { confirmedAt: '2026-11-17T00:00:00.000Z', revision: 1, employees: 1, tools: 0 },
          changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
        }),
      });
    });
    await page.goto('/#employees');
    await expect(page.getByRole('heading', { name: /员工反馈与能力申请/ })).toBeVisible();
    await page.locator('.emp-card').filter({ hasText: 'T16订单审核员' }).getByRole('button', { name: '管理', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '管理 T16订单审核员' })).toBeVisible();
    await shot(page, 't11-drawer', 'zh');
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en drawer and feedback', async ({ page, request }) => {
      const created = await request.post('/api/v1/employees/', {
        data: { name: 'T16 Order reviewer', duty: 'Check credit limit', prompt: 'Follow the policy', source: 'manual' },
      });
      expect(created.ok()).toBeTruthy();
      await page.route('**/api/v1/knowledge/organization**', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            employees: [], tools: [], sops: [],
            confirmation: { confirmedAt: '2026-11-17T00:00:00.000Z', revision: 1, employees: 1, tools: 0 },
            changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
          }),
        });
      });
      await page.goto('/#employees');
      await expect(page.getByRole('heading', { name: /Employee feedback/ })).toBeVisible();
      await page.locator('.emp-card').filter({ hasText: 'T16 Order reviewer' }).getByRole('button', { name: 'Manage', exact: true }).click();
      await expect(page.getByRole('dialog', { name: /Manage T16 Order reviewer/ })).toBeVisible();
      await shot(page, 't11-drawer', 'en');
    });
  });
});
