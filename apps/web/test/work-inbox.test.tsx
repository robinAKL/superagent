import { describe, it, expect } from 'vitest';
import { approvalCount, toolsAwaitingPublish } from '../src/pages/WorkInboxPage';

describe('work inbox summary', () => {
  it('counts approvals by kind and tools by real lifecycle stage, not by title regex', () => {
    expect(approvalCount([{ kind: 'action_approval' }, { kind: 'supply_info' }, { kind: 'tool_note' }])).toBe(1);
    expect(toolsAwaitingPublish([
      { stage: 'release' }, { stage: 'test' }, { stage: 'available' }, { stage: 'placeholder' }, { stage: 'install' },
    ])).toBe(2);
  });
});
