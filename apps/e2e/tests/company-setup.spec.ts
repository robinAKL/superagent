import { test, expect } from './fixtures.js';

async function fillCompany(page: import('@playwright/test').Page) {
  await page.goto('/#brain');
  await expect(page.getByLabel('企业名称')).toBeEnabled();
  await page.getByLabel('企业名称').fill('测试财务部');
  await page.getByLabel('希望交给数字团队的工作').fill('核对供应商发票并完成付款登记');
  await page.getByLabel('必须遵守的边界').fill('审批人确认后才能登记付款');
}

test('saving company settings has no impact on the confirmed team', async ({ page }) => {
  const before = await (await page.request.get('/api/v1/employees/')).json();
  const teamWrites: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/knowledge/organization')) teamWrites.push(request.url());
  });
  await fillCompany(page);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('希望交给数字团队的工作')).toHaveValue('核对供应商发票并完成付款登记');
  expect(teamWrites).toEqual([]);
  expect(await (await page.request.get('/api/v1/employees/')).json()).toEqual(before);
});

test('a failed company save is reported as a save error', async ({ page }) => {
  await page.route('**/api/v1/sop/company-context', async route => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 400, json: { error: 'invalid_company_context' } });
    return route.continue();
  });
  await fillCompany(page);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '无法保存配置' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已保存配置' })).toHaveCount(0);
});
