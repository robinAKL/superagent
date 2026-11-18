import { describe, expect, it } from 'vitest';
import { ontologyAttributes, validateProposals } from '../src/modules/analysis/service.js';

const evidence = [
  { sourceId: 's1', version: 'v1', locator: 'guide#L1', start: 0, end: 10, quote: 'Deposit is 60% of the order total.' },
  { sourceId: 's1', version: 'v1', locator: 'guide#L4', start: 20, end: 40, quote: 'Approval above NZD 50,000.' },
];

describe('ontology attributes from analysis', () => {
  it('keeps well-formed properties and drops malformed ones without failing the draft', () => {
    expect(ontologyAttributes([
      { name: 'Deposit share', value: '60% of order total', citation: 1 },
      { name: 'Approval limit', value: 50000, citation: 2 },
      { name: 'deposit share', value: 'duplicate' },
      { name: '', value: 'x' },
      { name: 'Out of range', value: 'y', citation: 9 },
      'junk',
    ], evidence.length)).toEqual([
      { name: 'Deposit share', value: '60% of order total', citation: 1 },
      { name: 'Approval limit', value: '50000', citation: 2 },
      { name: 'Out of range', value: 'y' },
    ]);
    expect(ontologyAttributes(undefined, 2)).toEqual([]);
  });

  it('stores attributes and the rule flag on object drafts only', () => {
    const [object, tool] = validateProposals([
      { key: 'deposit', kind: 'object', name: 'Deposit requirement', description: 'Deposit before supplier order', evidence, rule: true,
        attributes: [{ name: 'Deposit share', value: '60%', citation: 1 }] },
      { key: 'crm', kind: 'tool', name: 'CRM', description: 'Records orders', evidence, rule: true, attributes: [{ name: 'x', value: 'y' }] },
    ]);
    expect(object).toMatchObject({ ruleLike: true, attributes: [{ name: 'Deposit share', value: '60%', citation: 1 }] });
    expect(tool!.ruleLike).toBeUndefined();
    expect(tool!.attributes).toBeUndefined();
  });
});
