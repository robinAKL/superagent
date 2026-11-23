import { describe, expect, it } from 'vitest';
import { readableTitle } from '../src/pages/MaterialReview';

describe('material titles', () => {
  it('replace a title made of spreadsheet cells with the file name', () => {
    expect(readableTitle("'In Put'!1:1 B: Company C: Customer Name D: Phone Number E: Email F: Address", 'Shutter Studio Wholesale Order Template - native repaired.xlsm'))
      .toBe('Shutter Studio Wholesale Order Template - native repaired');
    expect(readableTitle('Sheet1!A1:F20', 'orders.xlsx')).toBe('orders');
  });
  it('keep a title a person wrote or analysis named properly', () => {
    expect(readableTitle('Wholesale Customers and Leads Database', 'Overall Database.xlsm')).toBe('Wholesale Customers and Leads Database');
    expect(readableTitle('订单审核指南', 'guide.md')).toBe('订单审核指南');
    expect(readableTitle('Plan A: pricing', 'x.md')).toBe('Plan A: pricing');
  });
});
