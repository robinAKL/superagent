import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deliverables/v12-compare-t30');

test.describe('T-30 Link device pairing', () => {
  test('zh: allow pairing, restrict, revoke', async ({ page }) => {
    const started = await page.request.post('/api/v1/worker-link/pair/start', { data: { hostname: 'Robin-PC', agents: ['codex'] } });
    expect(started.ok()).toBeTruthy();
    const body = await started.json() as { userCode: string; deviceCode: string };

    await page.goto(`/#connect?code=${encodeURIComponent(body.userCode)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('连接此电脑');
    await expect(page.getByText('Robin-PC')).toBeVisible();
    await page.getByRole('button', { name: '允许' }).click();
    await expect(page.getByRole('status')).toContainText('此电脑已连接');
    await mkdir(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(SHOTS, 't30-connect-allowed-1440-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(SHOTS, 't30-connect-allowed-375-zh.png'), fullPage: true });

    const polled = await page.request.post('/api/v1/worker-link/pair/poll', { data: { deviceCode: body.deviceCode } });
    const token = (await polled.json() as { token: string }).token;
    expect(token).toMatch(/^saw_/);

    await page.goto('/#settings');
    await expect(page.getByRole('heading', { name: '已连接的电脑' })).toBeVisible();
    // With a computer already paired, the always-latest download stays on the page.
    const download = page.getByRole('link', { name: '下载最新版 Link（Windows）' });
    await expect(download).toHaveAttribute('href', '/download/link');
    await download.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 't30-link-download-375-zh.png') });
    const card = page.locator('article').filter({ hasText: 'Robin-PC' });
    await card.locator('summary').filter({ hasText: '设备权限' }).click();
    await card.getByLabel('允许的员工（留空=全部）').fill('emp-a');
    await card.getByRole('button', { name: '保存限制' }).click();
    await expect(page.getByRole('status').filter({ hasText: '限制已保存' })).toBeVisible();
    await card.getByRole('button', { name: '吊销' }).click();
    await expect(card.getByText('已吊销')).toBeVisible();

    const hb = await page.request.post('/api/v1/worker-link/heartbeat', { headers: { authorization: `Bearer ${token}` }, data: {} });
    expect(hb.status()).toBe(401);
  });

  test.describe('en', () => {
    test.use({ lang: 'en' });
    test('en: deny pairing and show connect page', async ({ page }) => {
      const started = await page.request.post('/api/v1/worker-link/pair/start', { data: { hostname: 'Desk' } });
      const body = await started.json() as { userCode: string; deviceCode: string };
      await page.goto(`/#connect?code=${encodeURIComponent(body.userCode)}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect this computer');
      await page.getByRole('button', { name: 'Deny' }).click();
      await expect(page.getByRole('status')).toContainText('Pairing declined');
      await mkdir(SHOTS, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: path.join(SHOTS, 't30-connect-deny-1440-en.png'), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: path.join(SHOTS, 't30-connect-deny-375-en.png'), fullPage: true });
      const polled = await page.request.post('/api/v1/worker-link/pair/poll', { data: { deviceCode: body.deviceCode } });
      expect((await polled.json() as { status: string }).status).toBe('denied');
    });
  });
});
