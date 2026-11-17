import { describe, expect, it } from 'vitest';
import { sopTabView, type LoadCount } from '../src/pages/knowledge-sop-tab';

const loading: LoadCount = { status: 'loading' };
const error: LoadCount = { status: 'error' };
const n = (count: number): LoadCount => ({ status: 'ready', count });

describe('sopTabView', () => {
  it('waits until both counts are known instead of opening an empty editor', () => {
    expect(sopTabView(loading, loading, 'auto')).toEqual({ waiting: true, empty: false, sub: 'auto' });
    expect(sopTabView(n(0), loading, 'auto')).toEqual({ waiting: true, empty: false, sub: 'auto' });
    expect(sopTabView(loading, n(1), 'auto')).toEqual({ waiting: false, empty: false, sub: 'candidates' });
  });

  it('opens extracted SOP candidates when nothing is saved yet', () => {
    expect(sopTabView(n(0), n(1), 'auto')).toEqual({ waiting: false, empty: false, sub: 'candidates' });
  });

  it('keeps published and draft graphs when a saved workflow exists', () => {
    expect(sopTabView(n(2), n(3), 'auto')).toEqual({ waiting: false, empty: false, sub: 'flows' });
    expect(sopTabView(n(1), n(0), 'auto')).toEqual({ waiting: false, empty: false, sub: 'flows' });
    expect(sopTabView(n(1), error, 'auto')).toEqual({ waiting: false, empty: false, sub: 'flows' });
    expect(sopTabView(n(1), loading, 'auto')).toEqual({ waiting: false, empty: false, sub: 'flows' });
  });

  it('marks a true empty state only when both lists loaded as zero', () => {
    expect(sopTabView(n(0), n(0), 'auto')).toEqual({ waiting: false, empty: true, sub: 'candidates' });
  });

  it('does not treat a failed read as zero or as still loading', () => {
    expect(sopTabView(error, n(0), 'auto')).toEqual({ waiting: false, empty: false, sub: 'candidates' });
    expect(sopTabView(n(0), error, 'auto')).toEqual({ waiting: false, empty: false, sub: 'candidates' });
    expect(sopTabView(error, error, 'auto')).toEqual({ waiting: false, empty: false, sub: 'flows' });
    expect(sopTabView(error, loading, 'auto')).toEqual({ waiting: true, empty: false, sub: 'auto' });
  });

  it('keeps an explicit sub= choice', () => {
    expect(sopTabView(n(0), n(1), 'flows').sub).toBe('flows');
    expect(sopTabView(n(2), n(0), 'candidates').sub).toBe('candidates');
  });
});
