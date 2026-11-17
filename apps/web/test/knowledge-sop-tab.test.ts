import { describe, expect, it } from 'vitest';
import { sopTabView } from '../src/pages/knowledge-sop-tab';

describe('sopTabView', () => {
  it('waits until both counts are known instead of opening an empty editor', () => {
    expect(sopTabView(null, null, 'auto')).toEqual({ loading: true, empty: false, sub: 'auto' });
    expect(sopTabView(0, null, 'auto')).toEqual({ loading: true, empty: false, sub: 'auto' });
    expect(sopTabView(null, 1, 'auto')).toEqual({ loading: true, empty: false, sub: 'auto' });
  });

  it('opens extracted SOP candidates when nothing is saved yet', () => {
    expect(sopTabView(0, 1, 'auto')).toEqual({ loading: false, empty: false, sub: 'candidates' });
  });

  it('keeps published and draft graphs when a saved workflow exists', () => {
    expect(sopTabView(2, 3, 'auto')).toEqual({ loading: false, empty: false, sub: 'flows' });
    expect(sopTabView(1, 0, 'auto')).toEqual({ loading: false, empty: false, sub: 'flows' });
  });

  it('marks a true empty state when there is neither a saved workflow nor a candidate', () => {
    expect(sopTabView(0, 0, 'auto')).toEqual({ loading: false, empty: true, sub: 'candidates' });
  });

  it('keeps an explicit sub= choice', () => {
    expect(sopTabView(0, 1, 'flows').sub).toBe('flows');
    expect(sopTabView(2, 0, 'candidates').sub).toBe('candidates');
  });
});
