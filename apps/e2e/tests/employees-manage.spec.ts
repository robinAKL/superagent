import { test, expect } from './fixtures.js';

const owner = { 'x-dev-user': 'e2e-owner|owner|' };

test('the card wall manage button opens a drawer that pauses on the employees API', async ({ page, request }) => {
  const created = await request.post('/api/v1/employees/', {
    headers: owner,
    data: { name: '订单审核员', duty: '核对信用额度', prompt: '按制度核对订单', source: 'manual' },
  });
  expect(created.ok()).toBeTruthy();
  const employee = await created.json() as { id: string };
  await page.setExtraHTTPHeaders(owner);
  await page.route('**/api/v1/knowledge/organization', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        employees: [], tools: [], sops: [],
        confirmation: { confirmedAt: '2026-11-17T00:00:00.000Z', revision: 1, employees: 1, tools: 0 },
        changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
      }),
    });
  });
  await page.goto('/#employees');
  await expect(page.getByRole('region', { name: '数字员工' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /员工反馈与能力申请/ })).toBeVisible();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '管理 订单审核员' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('核对信用额度')).toBeVisible();
  await expect(drawer.getByText('v1')).toBeVisible();
  const paused = page.waitForResponse(r => r.url().includes(`/api/v1/employees/${employee.id}/pause`) && r.request().method() === 'POST');
  await drawer.getByRole('button', { name: '暂停' }).click();
  expect((await paused).ok()).toBeTruthy();
});
