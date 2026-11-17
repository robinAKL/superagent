import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORK_ENGLISH_KEYS, workText } from '../src/pages/work-inbox-copy';
import { KIND_LABEL, RENDERER_LABEL, decisionWhy } from '../src/pages/WorkInboxPage';

const source = readFileSync(fileURLToPath(new URL('../src/pages/WorkInboxPage.tsx', import.meta.url)), 'utf8');
const han = /[\u3400-\u9FFF]/;

describe('My work in English', () => {
  it('has an English entry for every Chinese string the page passes through w()', () => {
    const literals = [...source.matchAll(/\bw\('([^']*)'/g)].map(m => m[1]!).filter(s => han.test(s));
    expect(literals.length).toBeGreaterThan(80);
    const missing = literals.filter(s => !WORK_ENGLISH_KEYS.includes(s));
    expect(missing).toEqual([]);
  });

  it('translates the labels and reasons shared with the rest of the app', () => {
    for (const zh of [...Object.values(KIND_LABEL), ...Object.values(RENDERER_LABEL)]) expect(workText(zh, 'en')).not.toMatch(han);
    for (const reason of ['version_conflict', 'no_resubmit', 'retired', 'already_executed', 'invalid_amount', 'waiting_data_confirmation', 'conflict'])
      expect(workText(decisionWhy(reason, ''), 'en')).not.toMatch(han);
    // every English entry fills the same placeholders as its Chinese source
    for (const zh of WORK_ENGLISH_KEYS) {
      const names = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
      expect(names(workText(zh, 'en')), zh).toBe(names(zh));
    }
  });

  it('keeps the Chinese wording unchanged and fills placeholders', () => {
    expect(workText('截止 {due}', 'zh', { due: '周五' })).toBe('截止 周五');
    expect(workText('截止 {due}', 'en', { due: 'Friday' })).toBe('Due Friday');
    expect(workText('不在表里的文字', 'en')).toBe('不在表里的文字');
  });
});
