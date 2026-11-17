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

const ROLE_FILE = [
  '角色：采购专员；责任：核对采购申请并跟踪供应商。',
  '角色：财务专员；责任：核对付款金额与票据。',
  '工具：只读单据查询；职责：按编号查证业务记录。',
].join('\n');

async function seedCompanyGraph(page: Page) {
  await page.request.post('/__test/knowledge/reset', { data: {} });
  const existing = await page.request.get('/api/v1/sop/company-context');
  const version = ((await existing.json()) as { context?: { version?: number } }).context?.version ?? 0;
  const saved = await page.request.put('/api/v1/sop/company-context', {
    data: { name: 'ISWELL', goal: '核对供应商发票并完成付款登记', boundaries: '审批人确认后才能登记付款', expectedVersion: version },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.goto('/#knowledge');
  await page.getByLabel(/选择文件|Choose files/).setInputFiles({
    name: '实际上传职责.md', mimeType: 'text/markdown', buffer: Buffer.from(ROLE_FILE),
  });
  await expect(page.getByText('可搜索', { exact: true }).or(page.getByText('Searchable', { exact: true }))).toBeVisible();
  const started = await page.request.post('/api/v1/knowledge/analyses', { data: {} });
  expect(started.ok()).toBeTruthy();
  await page.request.post('/__test/knowledge/advance', { data: {} });
}

async function openCompanyGraph(page: Page, lang: 'zh' | 'en') {
  await page.goto('/#knowledge?view=graph&at=2026-11-18&known=2026-11-18');
  const ontology = page.locator('section.onto');
  await expect(ontology).toBeVisible();
  await ontology.locator('.onto-panel').getByRole('button', { name: /ISWELL/ }).click();
  await expect(ontology.locator('.onto-panel')).toContainText(lang === 'zh' ? '企业' : 'Enterprise');
  await expect(ontology.locator('.onto-panel')).toContainText(lang === 'zh' ? '知识截至' : 'Known to the platform by');
  await expect(ontology.locator('.onto-panel')).toContainText('2026-11-18');
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
