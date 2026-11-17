import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('D:/workspace/super agent/superagent-t16/deliverables/v12-compare-t17');
mkdirSync(DIR, { recursive: true });

const tools = Array.from({ length: 16 }, (_, i) => ({
  id: `tool-${i + 1}`,
  key: `tool-${i + 1}`,
  name: i === 0 ? '订单查询' : i === 15 ? '超阈值审批' : `工具占位 ${i + 1}`,
  description: '占位工具，用于组织草案右栏高度验收。',
  evidence: [],
  toolId: null,
  match: 'placeholder',
  matchName: null,
}));

const draftOrg = {
  employees: [{
    id: 'role-1', key: 'role-1', name: '订单审核员', duty: '核对订单信用额度并提交审批。',
    prompt: '按制度核对。', promptEdited: false, origin: 'inferred', evidence: [],
    privateSource: false, tools: tools.map(t => t.key), sops: ['sop-order'], employeeId: null,
  }],
  tools,
  sops: [{
    id: 'sop-1', key: 'sop-order', name: '订单与履行全流程',
    description: '从接单到出库的流程分组。', evidence: [],
  }],
  confirmation: null, changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
};

async function mockDraft(page: Page) {
  await page.route('**/api/v1/knowledge/organization**', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOrg) });
  });
}

async function openDraft(page: Page) {
  await mockDraft(page);
  await page.goto('/#employees?view=draft');
  await expect(page.getByRole('heading', { name: /Tools \(16\)|工具（16）/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '订单审核员' })).toBeVisible();
}

test('org draft tools list scrolls inside one column at 1440 and follows the page at 375', async ({ page }) => {
  await openDraft(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = page.locator('.org-side .org-list').first();
  const metrics = await list.evaluate(el => {
    const cs = getComputedStyle(el);
    const side = el.closest('.org-side');
    const sideCs = side ? getComputedStyle(side) : null;
    return {
      overflow: cs.overflowY,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      sideOverflow: sideCs?.overflowY ?? '',
    };
  });
  expect(metrics.overflow).toMatch(/auto|scroll/);
  expect(metrics.sideOverflow).not.toMatch(/auto|scroll/);
  expect(metrics.scrollH).toBeGreaterThan(metrics.clientH);
  await expect(page.getByLabel('流程（1）').getByText('订单与履行全流程')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  const mobile = await list.evaluate(el => {
    const cs = getComputedStyle(el);
    return { overflow: cs.overflowY, maxH: cs.maxHeight, scrollH: document.documentElement.scrollHeight };
  });
  expect(mobile.overflow).toBe('visible');
  expect(mobile.maxH).toBe('none');
  expect(mobile.scrollH).toBeGreaterThan(812);
});

test.describe('T-17 screenshots', () => {
  test.skip(!process.env.T17_SHOTS, 'set T17_SHOTS=1 to capture org-draft tools screenshots');

  test('zh 1440 and 375', async ({ page }) => {
    await openDraft(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: resolve(DIR, 't17-org-tools-1440-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: resolve(DIR, 't17-org-tools-375-zh.png'), fullPage: true });
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en 1440 and 375', async ({ page }) => {
      await openDraft(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: resolve(DIR, 't17-org-tools-1440-en.png'), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: resolve(DIR, 't17-org-tools-375-en.png'), fullPage: true });
    });
  });
});
