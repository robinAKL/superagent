export type SopTabSub = 'auto' | 'flows' | 'candidates';

/** Pick the Workflows / SOP pane. Do not open the empty editor while counts are still loading. */
export function sopTabView(saved: number | null, candidates: number | null, explicit: SopTabSub) {
  const loading = saved === null || candidates === null;
  const empty = saved === 0 && candidates === 0;
  const sub: SopTabSub = explicit !== 'auto' ? explicit : loading ? 'auto' : saved > 0 ? 'flows' : 'candidates';
  return { loading, empty, sub };
}
