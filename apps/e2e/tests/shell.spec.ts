/** App shell — maps prototype QA: qa-room-header, primary navigation (qa-outcomes "Primary navigation changed"). */
import { test, expect } from './fixtures.js';

test('owner navigation has 6 entries in 2 groups in the top bar, routed by hash (UX plan step 2)', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主菜单' });
  await expect(nav.getByRole('group', { name: '日常工作' }).locator('.nav-item')).toHaveText(['指挥室', '待我处理', '日历']);
  await expect(nav.getByRole('group', { name: '团队与配置' }).locator('.nav-item')).toHaveText(['数字员工', '企业知识', '管理设置']);
  await expect(nav.locator('[aria-current="page"]')).toHaveText('指挥室');
  await nav.getByText('管理设置').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('管理设置');
  await expect(nav.locator('[aria-current="page"]')).toHaveText('管理设置');
  // Pages that left the menu keep their routes and light up the destination they belong to.
  await page.goto('/#tools');
  await expect(nav.locator('[aria-current="page"]')).toHaveText('数字员工');
  await page.goto('/#brain');
  await expect(nav.locator('[aria-current="page"]')).toHaveText('数字员工');
});

const PAGES = ['room', 'work', 'calendar', 'knowledge', 'employees', 'tools', 'brain', 'settings'];

test('every page has the same head: title, subtitle under it (not the room), actions top-right', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop rule; phones stack the actions under the title');
  for (const hash of PAGES) {
    await page.goto(`/#${hash}`);
    const head = page.locator('main .page-head').first();
    await expect(head, `#${hash}`).toBeVisible();
    const h1 = await head.locator('h1').boundingBox();
    expect(h1, `#${hash}`).toBeTruthy();
    if (hash === 'room') {
      // The command room keeps its head to one line so the conversation gets the height: no subtitle.
      await expect(head.locator('p')).toHaveCount(0);
    } else {
      const sub = await head.locator('p').first().boundingBox();
      expect(sub, `#${hash}`).toBeTruthy();
      expect(Math.abs(sub!.x - h1!.x), `#${hash} subtitle aligned under the title`).toBeLessThanOrEqual(1);
      expect(sub!.y, `#${hash} subtitle below the title`).toBeGreaterThanOrEqual(h1!.y + h1!.height - 1);
    }
    expect(await head.locator('h1').evaluate(el => getComputedStyle(el).fontSize), `#${hash}`).toBe('22px'); // the v2 type scale: 22px page titles, 14px body
    const actions = head.locator('.page-head-actions');
    if (await actions.count()) {
      const box = (await actions.boundingBox())!;
      expect(box.x, `#${hash} actions to the right`).toBeGreaterThan(h1!.x + h1!.width);
      expect(Math.abs(box.y - h1!.y), `#${hash} actions top-aligned`).toBeLessThanOrEqual(16);
    }
  }
});

test('no horizontal page scroll at phone width', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone-width rule');
  for (const hash of PAGES) {
    await page.goto(`/#${hash}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `#${hash}`).toBeLessThanOrEqual(0);
  }
});

test('the language switch fits inside the top bar (desktop and phone width)', async ({ page }) => {
  await page.goto('/');
  const bar = await page.locator('.topbar').boundingBox();
  const sw = await page.locator('.lang-switch').boundingBox();
  expect(bar && sw).toBeTruthy();
  expect(sw!.x).toBeGreaterThanOrEqual(bar!.x);
  expect(sw!.x + sw!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
  expect(sw!.y).toBeGreaterThanOrEqual(bar!.y);
  expect(sw!.y + sw!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
  const product = await page.locator('.topbar .product').boundingBox();
  expect(product!.x + product!.width, 'product name and switch do not overlap').toBeLessThanOrEqual(sw!.x);
});

test('digital employees without an analysed draft say how to start instead of showing invented roles', async ({ page }) => {
  // Employees other specs added are on the wall; the draft view is where a missing analysis shows.
  await page.goto('/#employees?view=draft');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');
  // Other specs already added employees, so this view is about suggestions only.
  await expect(page.getByRole('heading', { name: '还没有推荐的员工' })).toBeVisible();
  await expect(page.getByRole('link', { name: '去企业知识', exact: true })).toHaveAttribute('href', '#knowledge');
  await expect(page.locator('.org-role')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部发布' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/已完成|已发布/);
});

test('configured knowledge starts with an empty source list for an ungranted owner', async ({ page }) => {
  await page.goto('/#knowledge');
  await expect(page.locator('main')).toContainText('还没有资料。');
  await expect(page.locator('.knowledge-item')).toHaveCount(0);
  await expect(page.locator('.knowledge-recommendation')).toHaveCount(0);
});
