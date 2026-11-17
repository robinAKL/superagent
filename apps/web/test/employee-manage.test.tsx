import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { EmployeeManage, mentionsEmployee } from '../src/pages/EmployeeManage';
import { EmployeeFeedback } from '../src/pages/EmployeeFeedback';
import { EmployeeWall } from '../src/pages/EmployeeWall';

describe('employee manage drawer', () => {
  it('only treats inbox payloads that name a known employee id as feedback', () => {
    const ids = new Set(['emp-1']);
    expect(mentionsEmployee({ employeeId: 'emp-1', title: 'Need a CRM' }, ids)).toBe(true);
    expect(mentionsEmployee({ title: 'tool release please' }, ids)).toBe(false);
    expect(mentionsEmployee({ employeeId: 'someone-else' }, ids)).toBe(false);
  });

  it('renders duty, prompt version, owner, pause and an honest empty feedback region', () => {
    const employee = { id: 'emp-1', name: '订单审核员', duty: '核对额度', status: 'online', owner: 'dev-owner', promptVersion: 2 };
    const drawer = renderToStaticMarkup(<LangProvider initial="zh"><EmployeeManage employee={employee} lang="zh" onClose={() => undefined} onChanged={() => undefined} /></LangProvider>);
    expect(drawer).toContain('管理 订单审核员');
    expect(drawer).toContain('核对额度');
    expect(drawer).toContain('v2');
    expect(drawer).toContain('dev-owner');
    expect(drawer).toContain('暂停');
    const en = renderToStaticMarkup(<LangProvider initial="en"><EmployeeFeedback employees={[]} /></LangProvider>);
    expect(en).toContain('Employee feedback and capability requests (0)');
    expect(en).not.toMatch(/[一-鿿]/);
    expect(renderToStaticMarkup(<LangProvider initial="zh"><EmployeeWall hasDraft employees={[employee]} onManage={() => undefined} /></LangProvider>)).toContain('<button type="button" class="btn">管理</button>');
  });
});
