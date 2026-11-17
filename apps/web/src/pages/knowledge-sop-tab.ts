export type SopTabSub = 'auto' | 'flows' | 'candidates';
export type LoadCount = { status: 'loading' } | { status: 'error' } | { status: 'ready'; count: number };

/** Pick the Workflows / SOP pane. Empty only when both lists loaded as zero; a failed read is not zero. */
export function sopTabView(saved: LoadCount, candidates: LoadCount, explicit: SopTabSub) {
  const empty = saved.status === 'ready' && saved.count === 0 && candidates.status === 'ready' && candidates.count === 0;
  if (explicit !== 'auto') return { empty, sub: explicit, waiting: false };
  if (saved.status === 'loading') return { empty: false, sub: 'auto' as const, waiting: true };
  if (saved.status === 'ready' && saved.count > 0) return { empty: false, sub: 'flows' as const, waiting: false };
  if (candidates.status === 'ready' && candidates.count > 0) return { empty: false, sub: 'candidates' as const, waiting: false };
  if (candidates.status === 'loading') return { empty: false, sub: 'auto' as const, waiting: true };
  return { empty, sub: (saved.status === 'error' && candidates.status !== 'ready' ? 'flows' : 'candidates') as SopTabSub, waiting: false };
}
