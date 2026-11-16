/**
 * English is the default interface language. Pages localized here must not show Chinese UI text until the
 * person switches to 中文. (The language switch itself is labelled in its own language and is outside these areas.)
 */
import { test, expect } from './fixtures.js';

test.use({ lang: null });

const CJK = /[一-鿿]/;

test('the command room shows no Chinese in English, and the Chinese copy after switching', async ({ page }) => {
  // An empty room, so only interface text is on the page (message bodies are whatever people and the server wrote).
  expect((await page.request.post('/__e2e/room/reset')).ok()).toBe(true);
  await page.setExtraHTTPHeaders({ 'x-dev-user': 'e2e-english-owner|owner|' });
  await page.goto('/#room');
  const room = page.locator('.exec-room');
  await expect(room).toBeVisible();
  await expect(room.getByRole('heading', { name: 'Shared collaboration log' })).toBeVisible();
  await expect(room.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  expect(await room.innerText()).not.toMatch(CJK);
  // Accessible names count too: screen readers read them out.
  const labels = await room.locator('[aria-label], [placeholder]').evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`).join(' '));
  expect(labels).not.toMatch(CJK);

  await page.getByRole('button', { name: '中文' }).click();
  await expect(room.getByRole('heading', { name: '共享协作记录' })).toBeVisible();
  await expect(room.getByRole('button', { name: '发送', exact: true })).toBeVisible();
});
