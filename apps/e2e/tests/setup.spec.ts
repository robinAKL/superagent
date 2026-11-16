/**
 * Setup (PRD §3.1) end to end against the real server and a stub model provider.
 * Maps: key-only-to-server, three-part test, selectable = listed ∩ verified, activation, role restriction.
 */
import { test, expect } from './fixtures.js';
import { EMPLOYEE } from '../playwright.config.js';

const GOOD = 'e2e-stub-key-0000GOOD';
const BAD = 'e2e-wrong-key-1111BAD';

test.describe.configure({ mode: 'serial' });

test('a rejected key is reported as invalid, cannot be activated, and is never echoed', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.locator('main')).toContainText('状态：未配置');
  await page.getByLabel('API Key', { exact: true }).fill(BAD);
  await page.getByLabel('模型 ID', { exact: true }).fill('stub-large');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('main')).toContainText('认证：Key 无效');
  await expect(page.getByRole('button', { name: '保存并生效' })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(BAD);
});

test('a valid key: only verified models are selectable; activation stores it server-side and shows last 4 only', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/setup/llm')) sent.push(r.url());
  });
  await page.goto('/#settings');
  await page.getByLabel('API Key', { exact: true }).fill(GOOD);
  await page.getByLabel('模型 ID', { exact: true }).fill('stub-large');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('main')).toContainText('凭据验证通过');
  await expect(page.locator('main')).toContainText('已选择 stub-large 作为主模型。');
  await expect(page.locator('main')).not.toContainText('stub-unverified');
  await page.getByRole('button', { name: '保存并生效' }).click();
  await expect(page.locator('main')).toContainText('模型已保存并生效。');
  await expect(page.locator('main')).toContainText('状态：已配置 · Key ••••GOOD · 主模型 stub-large');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(await page.content()).not.toContain(GOOD);
  expect(sent.every((u) => u.startsWith('http://127.0.0.1'))).toBe(true); // key goes only to our own server

  await page.reload();
  await expect(page.locator('main')).toContainText('状态：已配置 · Key ••••GOOD');
});

test('the status API never returns the key or its secret reference', async ({ request }) => {
  const r = await request.get('/api/v1/setup/llm');
  expect(r.status()).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(GOOD);
  expect(text).not.toMatch(/secret|version|llm-provider-key/i);
});

test('an employee cannot read or change Setup (server-side role check)', async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'x-dev-user': EMPLOYEE } });
  expect((await ctx.get('/api/v1/setup/llm')).status()).toBe(403);
  expect((await ctx.put('/api/v1/setup/llm', { data: { provider: 'anthropic', apiKey: GOOD, probeModel: 'stub-large', primaryModel: 'stub-large' } })).status()).toBe(403);
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: {} });
  expect((await anon.get('/api/v1/setup/llm', { headers: { 'x-dev-user': '' } })).status()).toBe(401);
  await ctx.dispose();
  await anon.dispose();
});

test('the owner sets a monthly budget cap in Setup; invalid amounts are refused', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.locator('main')).toContainText('当前上限：未设置（模型调用会被拒绝）');
  const cap = page.getByLabel('新的上限（美元，最多两位小数）');
  await cap.fill('12.345');
  await page.getByRole('button', { name: '保存上限' }).click();
  await expect(page.locator('main')).toContainText('未保存：');
  await cap.fill('200');
  await page.getByRole('button', { name: '保存上限' }).click();
  await expect(page.locator('main')).toContainText('已保存，立即对本月生效');
  await expect(page.locator('main')).toContainText('当前上限：US$200.00 / 月');
  await page.reload();
  await expect(page.locator('main')).toContainText('当前上限：US$200.00 / 月');
});
