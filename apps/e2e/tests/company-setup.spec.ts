import { test, expect } from './fixtures.js';

async function fillCompany(page: import('@playwright/test').Page) {
  await page.goto('/#brain');
  await expect(page.getByLabel('企业名称')).toBeEnabled();
  await page.getByLabel('企业名称').fill('测试财务部');
  await page.getByLabel('希望交给数字团队的工作').fill('核对供应商发票并完成付款登记');
  await page.getByLabel('必须遵守的边界').fill('审批人确认后才能登记付款');
}

const readyOrg = {
  employees: [{ id: 'role-1', name: '应付专员', tools: [], sops: [] }],
  tools: [], sops: [], confirmation: null, changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
};

test('saving company setup does not wait for organization publish', async ({ page }) => {
  await fillCompany(page);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('希望交给数字团队的工作')).toHaveValue('核对供应商发票并完成付款登记');
});

test('a failed employee generate does not show saved configuration', async ({ page }) => {
  await page.route('**/api/v1/knowledge/organization**', async route => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/confirm')) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'generic' }) });
    }
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyOrg) });
  });
  await fillCompany(page);
  await expect(page.getByRole('button', { name: '确认并发布配置，生成数字员工' })).toBeEnabled();
  await page.getByRole('button', { name: '确认并发布配置，生成数字员工' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '无法生成数字员工' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toHaveCount(0);
});
