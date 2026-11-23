import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { groupCapabilities } from '../src/pages/EmployeeFeedback';
import { WorkerConnectPanel } from '../src/pages/WorkerConnectPanel';
import { EmployeeWall } from '../src/pages/EmployeeWall';

describe('capability requests', () => {
  it('merge the ways analysis names one capability, most requested first', () => {
    const groups = groupCapabilities([
      { name: 'approve_order (CRM)' }, { name: 'approve_order (CRM action)' }, { name: 'approve_order (CRM)' },
      { name: 'record_order_deposit (CRM action)' }, { name: 'list_invoices (CRM/finance action)' },
    ]);
    expect(groups.map(group => [group.name, group.count])).toEqual([['approve_order', 3], ['list_invoices', 1], ['record_order_deposit', 1]]);
    expect(groups[0]!.systems).toEqual(['CRM']);
    expect(groups[1]!.systems).toEqual(['CRM/finance']);
  });
});

describe('team foundation', () => {
  it('the employee list is a table and shows no account id', () => {
    const html = renderToStaticMarkup(<LangProvider initial="zh"><EmployeeWall hasDraft employees={[
      { id: 'emp-1', name: '订单审核员', duty: '核对额度', status: 'online', owner: '7898fa05-9d2d-4f85-a473-ced03719ab9e' },
    ]} /></LangProvider>);
    expect(html).toContain('<table class="data-table emp-table">');
    expect(html).toContain('<th scope="col">员工</th>');
    expect(html).not.toContain('7898fa05');
  });

  it('linked computers never call a binding "removed" before the employee list has loaded', () => {
    const html = renderToStaticMarkup(<LangProvider initial="zh"><WorkerConnectPanel /></LangProvider>);
    expect(html).not.toContain('员工已移除');
  });
});
