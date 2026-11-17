import { test, expect } from './fixtures.js';

test.use({ extraHTTPHeaders: { 'x-dev-user': 'e2e-knowledge-owner|owner|P-1' } });

const rule = {
  id: 'r1', key: 'threshold', kind: 'relation', name: '审批阈值', description: '审批阈值自 2026-08-01 起生效。',
  humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31',
  relation: { from: 'order', to: 'approval', label: '超阈值需' },
  evidence: [{ sourceId: 's', version: 'v1', start: 0, end: 8, locator: 'policy.md#L4', quote: '审批阈值自 2026-08-01 起生效，2026-10-31 截止。' }],
};

test('looking back at a business date hides a rule that was not yet in effect', async ({ page }) => {
  await page.route('**/api/v1/knowledge/overview', async route => {
    const response = await route.fetch();
    const json = await response.json();
    json.recommendations = [rule, { id: 'o1', key: 'order', kind: 'object', name: '订单', description: '订单', humanLocked: false, deleted: false, recordedAt: '2026-11-03T00:00:00.000Z', evidence: rule.evidence }];
    json.analyses = [{ id: 'a1', status: 'completed', createdAt: '2026-11-03T00:00:00.000Z' }];
    await route.fulfill({ json });
  });
  await page.goto('/#knowledge?view=analysis&at=2026-09-15&known=2026-11-08');
  await expect(page.getByRole('complementary', { name: '关键规则' })).toContainText('业务有效：2026-08-01');
  await page.goto('/#knowledge?view=analysis&at=2026-11-02&known=2026-11-08');
  await expect(page.getByRole('complementary', { name: '关键规则' })).toContainText('还没有找到规则');
});
