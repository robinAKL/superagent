import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from '../src/components/RichText';
import { actorLabel, computerText, fromComputer, messageKindLabel, taskStatusLabel, type ApiMessage, type ApiTask } from '../src/pages/CommandRoomPage';

const task = { id: 'task_24', title: '列出文件', status: 'running', assigneeUserId: 'owner-1', waitingReason: null, employeeId: 'emp-1' } as ApiTask;
const employees = [{ id: 'emp-1', name: 'Wholesale Operations', duty: '', status: 'active', ownerUserId: 'owner-1' }] as never[];
const viewer = { userId: 'owner-1', roles: ['admin'], owner: true } as never;

describe('command room messages from a Link computer', () => {
  const update: ApiMessage = { id: 'm1', seq: 1, authorUserId: 'owner-1', body: 'Link received the task.', taskIds: ['task_24'], kind: 'reply', clientMessageId: 'worker-progress:task_24:abc' };
  const typed: ApiMessage = { ...update, id: 'm2', body: '谢谢', clientMessageId: 'c-1' };

  it('are labelled with the digital employee, not as the viewer', () => {
    expect(fromComputer(update)).toBe(true);
    expect(actorLabel(update, viewer, [task], employees, 'zh')).toBe('Wholesale Operations');
    expect(messageKindLabel(update, [task], 'zh')).toBe('进度');
    expect(messageKindLabel(update, [task], 'en')).toBe('Update');
    // A message the viewer typed is still theirs.
    expect(actorLabel(typed, viewer, [task], employees, 'zh')).toBe('我');
  });

  it("show Link's fixed status lines in Chinese and keep the CLI's own reason", () => {
    expect(computerText('Link received the task.', 'zh')).toBe('电脑已领取任务。');
    expect(computerText('Link received the task.', 'en')).toBe('Link received the task.');
    expect(computerText('claude-code requires sign-in.', 'zh')).toContain('重新登录');
    expect(computerText('Agent CLI did not return a completed result. Rate limit reached', 'zh')).toBe('本地 Agent 没有给出结果。 Rate limit reached');
  });

  it('task status names a failed run and a computer waiting for sign-in', () => {
    expect(taskStatusLabel({ status: 'waiting', waitingReason: '执行失败' }, 'en')).toBe('Failed on the computer');
    expect(taskStatusLabel({ status: 'waiting', waitingReason: '等待本地登录' }, 'zh')).toBe('等待本地登录');
    expect(taskStatusLabel({ status: 'running', waitingReason: null }, 'zh')).toBe('进行中');
  });
});

describe('RichText', () => {
  it('renders headings, fenced code, lists, inline code and bold', () => {
    const html = renderToStaticMarkup(<RichText text={'## 项目根目录内容\n\n`C:\\work`\n\n```\n（空）\n```\n\n- 第一\n- **第二**\n\n1. 一\n2. 二'} />);
    expect(html).toContain('<h4>项目根目录内容</h4>');
    expect(html).toContain('<code>C:\\work</code>');
    expect(html).toContain('<pre><code>（空）</code></pre>');
    expect(html).toContain('<ul><li>第一</li><li><strong>第二</strong></li></ul>');
    expect(html).toContain('<ol><li>一</li><li>二</li></ol>');
    expect(html).not.toContain('##');
  });

  it('never turns text into markup', () => {
    const html = renderToStaticMarkup(<RichText text={'<img src=x onerror=alert(1)> **<b>x</b>**'} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });
});
