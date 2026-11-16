/**
 * Material profiles: a reviewable title, category and summary for each parsed source version, plus a pointer to a
 * likely duplicate or earlier revision. Profiles are labels for human review only — they never confirm a version,
 * grant access, or enter evidence. Rules produce a profile immediately; a configured model may refine it later.
 */
export const CATEGORIES = ['policy', 'process', 'product', 'contract', 'finance', 'meeting', 'training', 'data', 'other'] as const;
export type Category = typeof CATEGORIES[number];

export interface ProfileRelation { sourceId: string; kind: 'duplicate' | 'similar' | 'update' }
export interface ItemProfile {
  version: string; title: string; category: Category; summary: string;
  origin: 'rules' | 'model' | 'human';
  /** pending: waiting for the model worker; done/failed/skipped: final for this version. */
  refine: 'pending' | 'done' | 'failed' | 'skipped';
  related: ProfileRelation | null;
  /** Bounded character-shingle signature used for similarity; never shown to users. */
  shingles: string[];
}

const RULES: [Category, RegExp][] = [
  ['contract', /合同|协议|甲方|乙方|条款|contract|agreement|terms and conditions|NDA/i],
  ['meeting', /会议纪要|会议记录|纪要|参会|议题|meeting minutes|attendees|agenda/i],
  ['finance', /报销|发票|预算|财务|费用|成本|利润|收入|invoice|budget|expense|revenue|reimburse/i],
  ['policy', /制度|规定|管理办法|规范|守则|政策|条例|policy|regulation|code of conduct|compliance/i],
  ['process', /流程|步骤|操作手册|作业指导|SOP|审批|how to|procedure|workflow|step \d/i],
  ['training', /培训|课程|学习|考试|入职|onboarding|training|course|lesson/i],
  ['product', /产品|功能|规格|参数|说明书|版本说明|product|feature|specification|release notes|datasheet/i],
];

const clean = (line: string) => line.replace(/^#{1,6}\s+/, '').replace(/[*_`>|]/g, '').replace(/\s+/g, ' ').trim();
export const baseName = (name: string) => name.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').trim() || name;

export function ruleProfile(name: string, text: string): Pick<ItemProfile, 'title' | 'category' | 'summary'> {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const heading = lines.find(l => /^#{1,3}\s+\S/.test(l));
  const first = lines.find(l => clean(l).length >= 2 && clean(l).length <= 80 && !/[,，;；]\s*\S+[,，;；]/.test(l));
  const isCsv = /\.csv$/i.test(name);
  const title = (heading ? clean(heading) : !isCsv && first ? clean(first) : baseName(name)).slice(0, 120);
  const sample = `${name}\n${text.slice(0, 8000)}`;
  // The title names the subject; body keywords only break ties when the title says nothing.
  const category: Category = isCsv ? 'data' : (RULES.find(([, re]) => re.test(`${title} ${baseName(name)}`)) ?? RULES.find(([, re]) => re.test(sample)))?.[0] ?? 'other';
  if (isCsv) {
    const columns = (lines[0] ?? '').split(',').map(c => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const shown = columns.slice(0, 8).join('、') + (columns.length > 8 ? ` 等 ${columns.length} 列` : '');
    return { title, category, summary: `数据表，${Math.max(lines.length - 1, 0)} 行${shown ? `；列：${shown}` : ''}。`.slice(0, 160) };
  }
  const body = lines.filter(l => !/^#{1,6}\s/.test(l) && clean(l) !== title).map(clean).join(' ');
  const sentences = body.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [];
  let summary = '';
  for (const s of sentences) { if ((summary + s).length > 160) break; summary += s; }
  summary = (summary || body.slice(0, 160)).replace(/([。！？；])\s+/g, '$1').trim();
  return { title, category, summary: summary || title };
}

const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const SKETCH = 256;
/** Bottom-k MinHash sketch of character 3-grams: a fixed ~2 KB per version regardless of document size. */
export function shingles(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, '').slice(0, 200_000), hashes = new Set<number>();
  for (let i = 0; i + 3 <= norm.length; i++) hashes.add(fnv(norm.slice(i, i + 3)));
  return [...hashes].sort((a, b) => a - b).slice(0, SKETCH).map(h => h.toString(36));
}
/** Estimated Jaccard similarity of two bottom-k sketches. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const as = new Set(a), bs = new Set(b);
  const union = [...new Set([...a, ...b])].map(h => parseInt(h, 36)).sort((x, y) => x - y).slice(0, SKETCH);
  let shared = 0; for (const h of union) { const k = h.toString(36); if (as.has(k) && bs.has(k)) shared++; }
  return shared / union.length;
}
export const SIMILAR_THRESHOLD = 0.5;

/** Validates model labels; anything outside the contract is rejected and the rule profile stays. */
export function validateProfile(value: unknown): Pick<ItemProfile, 'title' | 'category' | 'summary'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 120) return null;
  if (typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 400) return null;
  if (!CATEGORIES.includes(v.category as Category)) return null;
  return { title: v.title.trim(), category: v.category as Category, summary: v.summary.trim() };
}
