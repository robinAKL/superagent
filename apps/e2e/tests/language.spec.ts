/** Interface language: English by default, switchable to Chinese in the top bar, remembered in the browser. */
import { test, expect } from './fixtures.js';

test.describe('nothing chosen yet', () => {
  test.use({ lang: null });

  test('starts in English, switches to Chinese, and keeps the choice after a reload', async ({ page }) => {
    await page.goto('/#employees');
    const nav = page.getByRole('navigation', { name: 'Main menu' });
    // UX plan step 2: five destinations in two groups in the top bar.
    await expect(nav.getByRole('group', { name: 'Daily work' })).toBeVisible();
    await expect(nav.getByRole('group', { name: 'Team and setup' })).toBeVisible();
    await expect(nav.locator('.nav-item')).toHaveText(['Command room', 'My work', 'Calendar', 'Digital employees', 'Company knowledge', 'Admin settings']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Digital employees');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const language = page.getByRole('group', { name: 'Language' });
    await expect(language.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    await language.getByRole('button', { name: '中文' }).click();

    const navZh = page.getByRole('navigation', { name: '主菜单' });
    await expect(navZh.locator('.nav-item')).toHaveText(['指挥室', '待我处理', '日历', '数字员工', '企业知识', '管理设置']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('group', { name: '语言' }).getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(page.getByRole('navigation', { name: '主菜单' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');

    await page.getByRole('group', { name: '语言' }).getByRole('button', { name: 'EN' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Digital employees');
  });

  const PAGES: { hash: string; heading: string }[] = [
    { hash: 'room', heading: 'Command room' },
    { hash: 'work', heading: 'My work' },
    { hash: 'knowledge', heading: 'Enterprise Knowledge' },
    { hash: 'employees', heading: 'Digital employees' },
    { hash: 'tools', heading: 'Employee tools' },
    { hash: 'brain', heading: 'Super Agent' },
    { hash: 'settings', heading: 'Settings' },
  ];

  test('all seven pages open in English with no Han in the chrome', async ({ page }) => {
    const han = /[\u3400-\u9FFF]/;
    for (const { hash, heading } of PAGES) {
      await page.goto(`/#${hash}`);
      await expect(page.getByRole('heading', { level: 1 }), `#${hash}`).toHaveText(heading);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      const optional = async (locator: ReturnType<typeof page.locator>) =>
        (await locator.count()) ? await locator.first().innerText() : '';
      const chrome = [
        await page.getByRole('navigation', { name: 'Main menu' }).innerText(),
        await optional(page.locator('main .page-head')),
        await optional(page.locator('main [role="tablist"]')),
      ].join('\n');
      expect(chrome, `#${hash} chrome`).not.toMatch(han);
    }
    await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: '中文' }).click();
    await page.goto('/#employees');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');
  });
});
