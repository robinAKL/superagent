import { describe, expect, it } from 'vitest';
import { collapseProgress, type ApiMessage } from '../src/pages/CommandRoomPage';

const m = (id: string, over: Partial<ApiMessage>): ApiMessage => ({ id, seq: Number(id.slice(1)), authorUserId: 'u', body: id, taskIds: ['t1'], kind: 'reply', ...over });

describe('progress from a computer', () => {
  it('keeps only the latest step of each task, and none once the report is in', () => {
    const asked = m('m1', { kind: 'message', clientMessageId: 'web-1' });
    const received = m('m2', { clientMessageId: 'worker-progress:t1:a' });
    const started = m('m3', { clientMessageId: 'worker-progress:t1:b' });
    const other = m('m4', { taskIds: ['t2'], clientMessageId: 'worker-progress:t2:a' });
    expect(collapseProgress([asked, received, started, other]).map(x => x.id)).toEqual(['m1', 'm3', 'm4']);
    const report = m('m5', { kind: 'report', clientMessageId: 'worker-report:t1:c' });
    expect(collapseProgress([asked, received, started, other, report]).map(x => x.id)).toEqual(['m1', 'm4', 'm5']);
  });
});
