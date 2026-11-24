/**
 * T-13: an agent's permission prompt, filed by its Link, is decided in the command room and the waiting Link
 * gets the decision. Runs against the real server; the "Link" is plain HTTP with the worker token.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

const OWNER = 'e2e-approvals-owner|owner|';
const EMPLOYEE = 'e2e-approvals-staff|employee|';

async function newWorker(request: APIRequestContext) {
  const res = await request.post('/api/v1/workers', { headers: { 'x-dev-user': OWNER }, data: { name: `link-${Date.now()}`, kind: 'link' } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).token as string;
}

async function filePrompt(request: APIRequestContext, token: string, summary: string) {
  const res = await request.post('/api/v1/worker-link/approvals', {
    headers: { authorization: `Bearer ${token}` },
    data: { tool: 'Bash', input: { command: 'npm test' }, summary, roomTaskId: 'task_e2e' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).approval.id as string;
}

const waitResult = async (request: APIRequestContext, token: string, id: string) =>
  (await (await request.post(`/api/v1/worker-link/approvals/${id}/wait`, { headers: { authorization: `Bearer ${token}` }, data: { waitMs: 0 } })).json()).approval;

async function openRoom(page: Page, user: string) {
  await page.setExtraHTTPHeaders({ 'x-dev-user': user });
  await page.goto('/#room');
  await page.reload();
}

test('the room owner allows and denies agent prompts; the Link receives each decision', async ({ page, request }) => {
  const token = await newWorker(request);
  const allowId = await filePrompt(request, token, '运行测试套件 ' + Date.now());
  const denyId = await filePrompt(request, token, '删除临时目录 ' + Date.now());

  await openRoom(page, OWNER);
  const panel = page.getByRole('region', { name: '待确认的 agent 操作' });
  await expect(panel).toBeVisible();
  const allowItem = panel.locator(`[data-approval="${allowId}"]`);
  const denyItem = panel.locator(`[data-approval="${denyId}"]`);
  await expect(allowItem).toContainText('运行测试套件');
  await expect(allowItem).toContainText('npm test');
  await expect(allowItem).toContainText('task_e2e');

  await allowItem.getByRole('button', { name: '允许这一次', exact: true }).click();
  await expect(allowItem).toHaveCount(0);
  expect(await waitResult(request, token, allowId)).toMatchObject({ status: 'allowed', decidedBy: 'e2e-approvals-owner' });

  await denyItem.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(denyItem).toHaveCount(0);
  expect((await waitResult(request, token, denyId)).status).toBe('denied');
});

test('an employee does not see agent confirmations and cannot decide them', async ({ page, request }) => {
  const token = await newWorker(request);
  const id = await filePrompt(request, token, '员工不可见 ' + Date.now());
  await openRoom(page, EMPLOYEE);
  await expect(page.locator('.exec-room[data-view="employee"]')).toBeVisible();
  await expect(page.locator('.exec-approvals')).toHaveCount(0);
  const res = await request.post(`/api/v1/workers/approvals/${id}/decide`, { headers: { 'x-dev-user': EMPLOYEE }, data: { decision: 'allow' } });
  expect(res.status()).toBe(403);
  expect((await waitResult(request, token, id)).status).toBe('pending');
});
