import { useMemo, useState, type ReactNode } from 'react';
import { useLang, useT, type Dict } from '../i18n';
import './MaterialReview.css';

export const CATEGORIES = ['policy', 'process', 'product', 'contract', 'finance', 'meeting', 'training', 'data', 'other'] as const;
export type Category = typeof CATEGORIES[number];
export interface MaterialProfile {
  title: string; category: Category; summary: string; origin: 'rules' | 'model' | 'human'; refining: boolean;
  related: { id: string; kind: 'duplicate' | 'similar' | 'update'; title: string; confirmed: boolean } | null;
}
export interface Material { id: string; title: string; version: string; status: string; confirmed: boolean; confirmedAt?: string; locator: string; pluginId: string; profile?: MaterialProfile | null }

const UNAVAILABLE = ['deleted', 'revoked', 'parse_failed'];
const PAGE_SIZE = 12;

const TEXT = {
  en: {
    tabAll: 'All ({n})', tabPending: 'To confirm ({n})', tabFlagged: 'Duplicates & versions ({n})',
    categoryAll: 'All categories', categoryLabel: 'Category', titleLabel: 'Title',
    clearSelection: 'Clear selection',
    confirmSelected: 'Confirm selected ({n})', confirmPage: 'Confirm this page ({n})', confirmAnalyze: 'Confirm and analyze ({n})',
    confirming: 'Confirming…', confirmOne: 'Confirm this version',
    pagination: 'Material pages', range: '{from}–{to} of {total}', previous: 'Previous', next: 'Next',
    confirmResult: '{n} version(s) confirmed.', confirmPartial: '{n} confirmed, {failed} could not be confirmed. {reason}',
    originHuman: 'Edited', refining: 'AI is organizing…',
    relDuplicate: 'Same content as “{title}”.',
    relSimilar: 'Very similar to “{title}”. Possibly a newer version of it.',
    relUpdate: 'Replaces an earlier version of this file.',
    fileMeta: '{file} · {source} · version {version}',
    editBtn: 'Edit', saveBtn: 'Save', cancelBtn: 'Cancel',
    searchable: 'Searchable', unavailable: 'Unavailable',
    emptyFiltered: 'Nothing in this view.',
    cat_policy: 'Policy', cat_process: 'Process / SOP', cat_product: 'Product', cat_contract: 'Contract', cat_finance: 'Finance',
    cat_meeting: 'Meeting notes', cat_training: 'Training', cat_data: 'Data table', cat_other: 'Other',
  },
  zh: {
    tabAll: '全部（{n}）', tabPending: '待确认（{n}）', tabFlagged: '重复与新版本（{n}）',
    categoryAll: '全部分类', categoryLabel: '分类', titleLabel: '标题',
    clearSelection: '清空选择',
    confirmSelected: '确认选中（{n}）', confirmPage: '确认本页（{n}）', confirmAnalyze: '确认并分析（{n}）',
    confirming: '确认中…', confirmOne: '确认此版本',
    pagination: '资料分页', range: '第 {from}–{to} 项，共 {total} 项', previous: '上一页', next: '下一页',
    confirmResult: '已确认 {n} 个版本。', confirmPartial: '已确认 {n} 个，{failed} 个未能确认。{reason}',
    originHuman: '已人工修改', refining: 'AI 正在整理…',
    relDuplicate: '与《{title}》内容完全相同。',
    relSimilar: '与《{title}》高度相似，可能是它的新版本。',
    relUpdate: '替换了这个文件之前的版本。',
    fileMeta: '{file} · {source} · 版本 {version}',
    editBtn: '修改', saveBtn: '保存', cancelBtn: '取消',
    searchable: '可搜索', unavailable: '不可用',
    emptyFiltered: '这个视图下没有资料。',
    cat_policy: '制度规范', cat_process: '流程手册', cat_product: '产品资料', cat_contract: '合同协议', cat_finance: '财务',
    cat_meeting: '会议纪要', cat_training: '培训资料', cat_data: '数据表格', cat_other: '其他',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;

export function MaterialReview({ items, canManage, request, errorMessage, onChanged, onAnalyze, renderPreview, sourceName, disabled }: {
  items: Material[];
  canManage: boolean;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  errorMessage: (error: unknown) => string;
  onChanged: (notice?: string, error?: string) => Promise<void>;
  onAnalyze?: () => Promise<boolean>;
  renderPreview: (item: Material) => ReactNode;
  sourceName: (pluginId: string) => string;
  disabled: boolean;
}) {
  const t = useT(TEXT);
  const [lang] = useLang();
  const [tab, setTab] = useState<'all' | 'pending' | 'flagged'>('all');
  const [category, setCategory] = useState<Category | ''>('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string; category: Category } | null>(null);
  const busy = disabled || saving;

  const pending = items.filter(i => !i.confirmed && !UNAVAILABLE.includes(i.status));
  const flagged = items.filter(i => i.profile?.related);
  const activeTab = tab === 'pending' && !pending.length || tab === 'flagged' && !flagged.length ? 'all' : tab;
  const scoped = activeTab === 'pending' ? pending : activeTab === 'flagged' ? flagged : items;
  const counts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const item of scoped) { const c = item.profile?.category ?? 'other'; map.set(c, (map.get(c) ?? 0) + 1); }
    return CATEGORIES.filter(c => map.has(c)).map(c => [c, map.get(c)!] as const);
  }, [scoped]);
  const activeCategory = category && counts.some(([c]) => c === category) ? category : '';
  const visible = activeCategory ? scoped.filter(i => (i.profile?.category ?? 'other') === activeCategory) : scoped;
  const pageCount = Math.ceil(visible.length / PAGE_SIZE);
  const activePage = Math.min(page, Math.max(0, pageCount - 1));
  const offset = activePage * PAGE_SIZE;
  const pageItems = visible.slice(offset, offset + PAGE_SIZE);
  const selectable = (i: Material) => canManage && !i.confirmed && !UNAVAILABLE.includes(i.status);
  const selectableVisible = pageItems.filter(selectable);
  const chosen = selectableVisible.filter(i => selected.has(i.id));
  const confirmTarget = chosen.length ? chosen : selectableVisible;

  async function confirm(list: Material[], analyze = false) {
    if (!list.length || busy) return;
    setSaving(true);
    try {
      const result = await request<{ confirmed: number; failed: { id: string; error: string }[] }>('/items/confirm', { method: 'POST', body: JSON.stringify({ items: list.map(i => ({ id: i.id, version: i.version })) }) });
      setSelected(new Set());
      await onChanged(result.failed.length ? undefined : t('confirmResult', { n: result.confirmed }), result.failed.length ? t('confirmPartial', { n: result.confirmed, failed: result.failed.length, reason: lang === 'zh' ? result.failed[0]!.error : '' }) : undefined);
      if (analyze && result.confirmed === list.length && !result.failed.length) await onAnalyze?.();
    } catch (caught) { await onChanged(undefined, errorMessage(caught)); }
    finally { setSaving(false); }
  }
  async function saveEdit() {
    if (!editing || !editing.title.trim() || busy) return;
    setSaving(true);
    try { await request(`/items/${encodeURIComponent(editing.id)}/profile`, { method: 'POST', body: JSON.stringify({ title: editing.title.trim(), category: editing.category }) }); setEditing(null); await onChanged(); }
    catch (caught) { await onChanged(undefined, errorMessage(caught)); }
    finally { setSaving(false); }
  }
  const toggle = (id: string, on: boolean) => setSelected(s => { const next = new Set(s); if (on) next.add(id); else next.delete(id); return next; });
  const catLabel = (c: Category) => t(`cat_${c}` as Key);
  const tabs = ([['all', items.length], ['pending', pending.length], ['flagged', flagged.length]] as const).filter(([key, n]) => key === 'all' || n > 0);
  function changePage(next: number) {
    setPage(next);
    setSelected(new Set());
  }

  return <div className="mr-review" id="knowledge-items-list">
    <div className="mr-controls">
      <div className="mr-head">
        {tabs.length > 1 ? <div className="mr-tabs">
          {tabs.map(([key, n]) => <button key={key} type="button" aria-pressed={activeTab === key} className={`mr-pill ${activeTab === key ? 'is-active' : ''}`} onClick={() => { setTab(key); setCategory(''); changePage(0); }}>
            {t(key === 'all' ? 'tabAll' : key === 'pending' ? 'tabPending' : 'tabFlagged', { n })}
          </button>)}
        </div> : null}
        {counts.length > 1 ? <label className="mr-category field">
          <span>{t('categoryLabel')}</span>
          <select value={activeCategory} onChange={event => { setCategory(event.target.value as Category | ''); changePage(0); }}>
            <option value="">{t('categoryAll')}</option>
            {counts.map(([c, n]) => <option key={c} value={c}>{catLabel(c)} ({n})</option>)}
          </select>
        </label> : null}
      </div>

      {confirmTarget.length && (onAnalyze || selectableVisible.length > 1) ? <div className="mr-toolbar">
        {chosen.length ? <button type="button" className="btn mr-link" disabled={busy} onClick={() => setSelected(new Set())}>{t('clearSelection')}</button> : null}
        {selectableVisible.length > 1 ? <button type="button" className={onAnalyze ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void confirm(confirmTarget)}>
          {t(chosen.length ? 'confirmSelected' : 'confirmPage', { n: confirmTarget.length })}
        </button> : null}
        {onAnalyze ? <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm(confirmTarget, true)}>
          {saving ? t('confirming') : t('confirmAnalyze', { n: confirmTarget.length })}
        </button> : null}
      </div> : null}
    </div>

    {pageItems.length ? <ul className="mr-list">
      {pageItems.map(item => {
        const p = item.profile, rel = p?.related, isEditing = editing?.id === item.id;
        return <li key={item.id} className={`mr-item knowledge-item ${rel?.kind === 'duplicate' ? 'is-duplicate' : ''}`}>
          {selectableVisible.length > 1 && selectable(item) ? <input type="checkbox" className="mr-check" aria-label={p?.title ?? item.title} checked={selected.has(item.id)} disabled={busy} onChange={event => toggle(item.id, event.target.checked)} /> : <span className="mr-check" />}
          <div className="mr-body">
            {isEditing ? <div className="mr-edit">
              <label className="field"><span>{t('titleLabel')}</span><input maxLength={120} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
              <label className="field"><span>{t('categoryLabel')}</span><select value={editing.category} onChange={event => setEditing({ ...editing, category: event.target.value as Category })}>{CATEGORIES.map(c => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
              <div className="mr-edit-actions"><button type="button" className="btn primary" disabled={busy || !editing.title.trim()} onClick={() => void saveEdit()}>{t('saveBtn')}</button><button type="button" className="btn" onClick={() => setEditing(null)}>{t('cancelBtn')}</button></div>
            </div> : <>
              <div className="mr-title-row">
                <strong>{p?.title ?? item.title}</strong>
                {p ? <span className="knowledge-badge is-gold">{catLabel(p.category)}</span> : null}
                {p?.refining ? <span className="mr-origin mr-refining">{t('refining')}</span> :
                  p?.origin === 'human' ? <span className="mr-origin">{t('originHuman')}</span> : null}
              </div>
              {p?.summary ? <p className="mr-summary">{p.summary}</p> : null}
            </>}
            {rel ? <p className={`mr-related is-${rel.kind}`}>{rel.kind === 'duplicate' ? t('relDuplicate', { title: rel.title }) : rel.kind === 'similar' ? t('relSimilar', { title: rel.title }) : t('relUpdate')}</p> : null}
            <small className="mr-meta">{t('fileMeta', { file: item.title, source: sourceName(item.pluginId), version: item.version.slice(0, 8) })}</small>
            {renderPreview(item)}
          </div>
          <div className="mr-actions">
            {item.confirmed ? <span className="knowledge-badge is-green">{t('searchable')}</span> : UNAVAILABLE.includes(item.status) ? <span className="knowledge-badge">{t('unavailable')}</span> : canManage && selectableVisible.length === 1 ? <button type="button" className="btn" disabled={busy} onClick={() => void confirm([item])}>{t('confirmOne')}</button> : null}
            {canManage && p && !isEditing ? <button type="button" className="btn mr-link" disabled={busy} onClick={() => setEditing({ id: item.id, title: p.title, category: p.category })}>{t('editBtn')}</button> : null}
          </div>
        </li>;
      })}
    </ul> : <p className="knowledge-empty">{t('emptyFiltered')}</p>}
    {pageCount > 1 ? <nav className="mr-pagination" aria-label={t('pagination')}>
      <span className="helper">{t('range', { from: offset + 1, to: offset + pageItems.length, total: visible.length })}</span>
      <button type="button" className="btn" disabled={busy || activePage === 0} onClick={() => changePage(activePage - 1)}>{t('previous')}</button>
      <button type="button" className="btn" disabled={busy || activePage >= pageCount - 1} onClick={() => changePage(activePage + 1)}>{t('next')}</button>
    </nav> : null}
  </div>;
}
