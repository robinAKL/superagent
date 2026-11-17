import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(fileURLToPath(new URL('../../../deliverables/v12-compare-t20', import.meta.url)));
mkdirSync(DIR, { recursive: true });

const evidence = [{ sourceId: 's1', version: 'v1', start: 0, end: 8, locator: 'a.md#L1', quote: '客户下单后审核并结算。' }];
const sop = {
  id: 'sop1', key: 'order-settle', kind: 'sop', name: '订单到结算', description: '从三份资料合成的端到端流程。',
  humanLocked: false, deleted: false, recordedAt: '2026-11-18T00:00:00.000Z', evidence,
  workflow: {
    steps: [
      { key: 't', kind: 'trigger', label: '客户提交订单', after: [], citations: [1] },
      { key: 'a', kind: 'employee', label: '审核额度', after: ['t'], citations: [1] },
      { key: 'b', kind: 'tool', label: '登记结算', after: ['a'], citations: [1] },
    ],
  },
};
const rule = {
  id: 'r1', key: 'cap', kind: 'object', name: '超额需审批', description: '金额超过 5 万必须主管审批。',
  humanLocked: false, deleted: false, ruleLike: true, recordedAt: '2026-11-18T00:00:00.000Z', evidence,
};

async function mockLibrary(page: Page) {
  await page.route('**/api/v1/sop', async route => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (route.request().method() === 'GET' && path.endsWith('/api/v1/sop')) {
      await route.fulfill({ json: { sops: [] } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/v1/knowledge/recommendations**', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      json: { recommendations: [sop, rule], mcpRecommendations: [] },
    });
  });
  await page.route('**/api/v1/knowledge/overview', async route => {
    const json = await (await route.fetch()).json();
    json.items = [
      { id: 'i1', title: '订单指南', version: 'v1', confirmed: true, confirmedAt: '2026-11-18T00:00:00.000Z' },
      { id: 'i2', title: '结算政策', version: 'v1', confirmed: true, confirmedAt: '2026-11-18T00:00:00.000Z' },
      { id: 'i3', title: '审批规则', version: 'v1', confirmed: true, confirmedAt: '2026-11-18T00:00:00.000Z' },
    ];
    json.recommendations = [sop, rule];
    json.analyses = [{ id: 'a1', status: 'completed', createdAt: '2026-11-18T00:00:00.000Z' }];
    await route.fulfill({ json });
  });
}

test('one end-to-end SOP appears on the company-flow tab; the demoted rule is in the rule dimension', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/#brain?tab=sop');
  await expect(page.getByRole('heading', { name: '订单到结算' })).toBeVisible();
  await expect(page.getByRole('group', { name: '流程图', exact: true })).toBeVisible();
  await expect(page.getByText('超额需审批')).toHaveCount(0);

  await page.goto('/#knowledge?view=analysis&at=2026-11-18&known=2026-11-18');
  await expect(page.getByRole('complementary', { name: '关键规则' })).toContainText('金额超过 5 万必须主管审批');
  await page.getByRole('button', { name: /业务规则与政策/ }).click();
  await expect(page.getByRole('heading', { name: '订单到结算' })).toHaveCount(0);
});

test.describe('T-20 screenshots', () => {
  test.skip(!process.env.T20_SHOTS, 'set T20_SHOTS=1 to capture SOP vs rule screenshots');

  test('zh 1440 and 375', async ({ page }) => {
    await mockLibrary(page);
    await page.goto('/#brain?tab=sop');
    await expect(page.getByRole('heading', { name: '订单到结算' })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(DIR, 't20-flow-1440-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: resolve(DIR, 't20-flow-375-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#knowledge?view=analysis&at=2026-11-18&known=2026-11-18');
    await expect(page.getByRole('complementary', { name: '关键规则' })).toContainText('金额超过 5 万必须主管审批');
    await page.screenshot({ path: resolve(DIR, 't20-rules-1440-zh.png'), fullPage: true });
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en 1440 and 375', async ({ page }) => {
      await mockLibrary(page);
      await page.goto('/#brain?tab=sop');
      await expect(page.getByRole('heading', { name: '订单到结算' })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: resolve(DIR, 't20-flow-1440-en.png'), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: resolve(DIR, 't20-flow-375-en.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/#knowledge?view=analysis&at=2026-11-18&known=2026-11-18');
      await expect(page.getByRole('complementary', { name: 'Key rule' })).toContainText('金额超过 5 万必须主管审批');
      await page.screenshot({ path: resolve(DIR, 't20-rules-1440-en.png'), fullPage: true });
    });
  });
});
