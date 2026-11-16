import { test, expect } from './fixtures.js';

test.use({ lang: null });

test('command room defaults to English and switches system copy live', async ({ page }) => {
  expect((await page.request.post('/__e2e/room/reset')).ok()).toBe(true);
  const worker = await page.request.post('/api/v1/employees/', {
    data: { name: 'LanguageAnalyst', duty: 'Review source material', prompt: 'Review material', ownerUserId: 'e2e-owner' },
  });
  expect(worker.ok()).toBe(true);
  await page.goto('/#room');
  const room = page.getByRole('region', { name: 'Command room', exact: true });
  await expect(room.getByRole('heading', { name: 'Command room' })).toBeVisible();
  await expect(room.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(room.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(room.getByText('No tasks yet')).toBeVisible();
  await expect(room.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const textbox = room.getByRole('textbox', { name: 'Message the command room' });
  await expect(textbox).toHaveAttribute('placeholder', 'Write a message or @mention a digital employee to assign work.');
  await expect(room).not.toContainText(/[\u3400-\u9fff]/u);

  await textbox.fill('@LanguageAnalyst Review source material');
  await textbox.press('Enter');
  await expect(room.getByText('Assigned to @LanguageAnalyst. The employee is offline and the task is waiting for a connection.')).toBeVisible();
  await room.getByRole('button', { name: 'View task', exact: true }).first().click();
  const details = room.getByRole('complementary', { name: 'Task details' });
  await expect(details.getByText('Waiting for connection')).toBeVisible();
  await expect(details.getByText('Prompt snapshot')).toBeVisible();
  await expect(details.getByRole('button', { name: 'Save criteria' })).toBeVisible();
  await expect(room).not.toContainText(/[\u3400-\u9fff]/u);
  await details.getByRole('button', { name: 'Close' }).click();

  await textbox.fill('请保留这条原始消息');
  await textbox.press('Enter');
  await expect(room.getByText('请保留这条原始消息', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent Room 指挥室' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '共享协作记录' })).toBeVisible();
});
