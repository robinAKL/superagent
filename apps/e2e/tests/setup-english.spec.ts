/**
 * English is the default interface language: the settings page shows no Chinese until the person switches to 中文.
 * Uses a rejected key only, so it never changes the configuration other specs rely on.
 */
import { test, expect } from './fixtures.js';

test.use({ lang: null });

const CJK = /[一-鿿]/;

test('settings shows no Chinese in English, including the test result, and Chinese after switching', async ({ page }) => {
  await page.goto('/#settings');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(main).toContainText('Status: ');
  await page.getByLabel('API key', { exact: true }).fill('e2e-wrong-key-1111BAD');
  await page.getByLabel('Model ID', { exact: true }).fill('stub-large');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(main).toContainText('Authentication: Invalid key');
  expect(await main.innerText()).not.toMatch(CJK);
  const attributes = await main.locator('[aria-label], [placeholder], option').evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.textContent ?? ''}`).join(' '));
  expect(attributes).not.toMatch(CJK);

  await page.getByRole('button', { name: '中文' }).click();
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('管理设置');
  await expect(main).toContainText('认证：Key 无效');
});
