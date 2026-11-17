import { test, expect } from './fixtures.js';

for (const lang of ['zh', 'en'] as const) {
  test.describe(lang, () => {
    test.use({ lang });

    test('employee cards show the owner and assigned tools, with compact custom tool rows', async ({ page, request }, info) => {
      const primaryName = lang === 'zh' ? '供应商订单审核员' : 'Supplier order reviewer';
      const secondaryName = lang === 'zh' ? '库存核对员' : 'Inventory reviewer';
      const toolName = lang === 'zh' ? '供应商订单登记' : 'Supplier order entry';
      const otherOwner = '0bc89f16-f7ab-418f-a1ae-191a7285bec1';
      const primary = await request.post('/api/v1/employees/', { data: { name: primaryName, duty: primaryName, prompt: primaryName } });
      const secondary = await request.post('/api/v1/employees/', {
        data: { name: secondaryName, duty: secondaryName, prompt: secondaryName, ownerUserId: otherOwner },
      });
      expect(primary.ok()).toBeTruthy();
      expect(secondary.ok()).toBeTruthy();
      const primaryId = (await primary.json()).id as string;
      const secondaryId = (await secondary.json()).id as string;
      const toolId = `e2e.employee-tools.${lang}`;
      try {
        const tool = await request.post('/api/v1/tools/', { data: {
          name: toolName, consumers: [primaryId], acceptanceCases: [],
          contract: { toolId, action: 'record supplier order', purpose: 'Record a supplier order', effect: 'read' },
        } });
        expect(tool.ok()).toBeTruthy();
        await page.route('**/api/v1/knowledge/organization', route => route.fulfill({ json: {
          employees: [], tools: [], sops: [], confirmation: { confirmedAt: '2026-11-18T00:00:00Z', revision: 1, employees: 2, tools: 1 },
          changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
        } }));
        await page.goto('/#employees');
        const primaryCard = page.locator(`[data-employee="${primaryId}"]`);
        const secondaryCard = page.locator(`[data-employee="${secondaryId}"]`);
        await expect(primaryCard).toContainText(lang === 'zh' ? '你' : 'You');
        await expect(primaryCard).toContainText(lang === 'zh' ? '1 个工具' : '1 tool');
        await expect(secondaryCard).toContainText(lang === 'zh' ? '未设置' : 'Not set');
        await expect(secondaryCard).toContainText(lang === 'zh' ? '0 个工具' : '0 tools');
        await expect(secondaryCard).not.toContainText(otherOwner);
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
          await info.attach(`employee-cards-${width}-${lang}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
        }

        await page.goto('/#tools');
        const custom = page.getByRole('region', { name: lang === 'zh' ? '自定义工具' : 'Custom tools' });
        const row = custom.locator(`[data-tool-id="${toolId}"]`);
        const summary = row.getByRole('button');
        await expect(summary).toContainText(toolName);
        await expect(summary).toContainText(lang === 'zh' ? '占位' : 'Placeholder');
        await expect(summary).toHaveAttribute('aria-expanded', 'false');
        await expect(custom.locator('.steps')).toHaveCount(0);
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
          await info.attach(`custom-tools-${width}-${lang}`, { body: await custom.screenshot(), contentType: 'image/png' });
        }
        await summary.click();
        await expect(row.locator('.steps > li')).toHaveCount(7);
        await summary.click();
        await expect(row.locator('.steps')).toHaveCount(0);
      } finally {
        await request.delete(`/api/v1/employees/${primaryId}`);
        await request.delete(`/api/v1/employees/${secondaryId}`);
      }
    });
  });
}
