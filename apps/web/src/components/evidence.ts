/** Shared helpers for showing source evidence as citations instead of raw dumps. */
export interface EvidenceLike { locator: string; quote: string; sourceId?: string; version?: string }

/** "WORKFLOW.md#L3" and "WORKFLOW.md#L40" are the same document; the anchor is only the position. */
export function sourceLabel(locator: string): string {
  const base = locator.replace(/#.*$/, '').trim();
  return base || locator;
}

export function sourceGroupKey(e: EvidenceLike): string {
  return e.sourceId || sourceLabel(e.locator);
}

export interface EvidenceGroup<T extends EvidenceLike> { key: string; label: string; items: { entry: T; index: number }[] }

/** Groups evidence by source document, keeping each entry's original (0-based) index for citations. */
export function groupEvidence<T extends EvidenceLike>(evidence: T[]): EvidenceGroup<T>[] {
  const groups = new Map<string, EvidenceGroup<T>>();
  evidence.forEach((entry, index) => {
    const key = sourceGroupKey(entry);
    const group = groups.get(key) ?? { key, label: sourceLabel(entry.locator), items: [] };
    group.items.push({ entry, index });
    groups.set(key, group);
  });
  return [...groups.values()];
}

/**
 * Tool output often arrives as a JSON fragment cut mid-object. Show it as readable "field: value · …" text
 * instead of braces and escaped quotes. Plain prose is returned unchanged apart from whitespace.
 */
export function readableQuote(quote: string): string {
  const text = quote.trim();
  const jsonish = /"[\w\s-]{1,40}"\s*:/.test(text) || /^[[{]/.test(text);
  if (!jsonish) return text.replace(/\s+/g, ' ');
  return text
    .replace(/\\n/g, ' ').replace(/\\"/g, '"')
    .replace(/"([\w\s-]{1,40})"\s*:\s*/g, (_, key: string) => `${key.replace(/_/g, ' ')}: `)
    .replace(/"\s*,\s*"/g, ' · ')
    .replace(/[{}[\]]/g, ' ')
    .replace(/",\s*/g, ' · ').replace(/,\s*(?=[a-z][\w ]{0,40}:)/gi, ' · ')
    .replace(/"/g, '')
    .replace(/\s*·\s*(·\s*)+/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·,]+|[\s·,]+$/g, '');
}
