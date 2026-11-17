import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import './AnalysisDraftIndex.css';

const TEXT = {
  en: { list: 'Drafts', kind: 'Draft type', all: 'All types', sop: 'Workflows', object: 'Business objects', relation: 'Relationships', employee: 'Roles', tool: 'Tools' },
  zh: { list: '草案列表', kind: '草案类型', all: '全部类型', sop: '流程', object: '业务对象', relation: '关系', employee: '角色', tool: '工具' },
};
const KINDS = ['sop', 'object', 'relation', 'employee', 'tool'] as const;

export function AnalysisDraftIndex<T extends { id: string; name: string; kind: string }>({
  drafts, renderDraft, initialKind = '',
}: {
  drafts: T[];
  renderDraft: (draft: T) => ReactNode;
  initialKind?: string;
}) {
  const t = useT(TEXT);
  const detailId = useId();
  const [kind, setKind] = useState(initialKind);
  const [selected, setSelected] = useState('');
  const counts = new Map<string, number>();
  for (const draft of drafts) counts.set(draft.kind, (counts.get(draft.kind) ?? 0) + 1);
  const filter = counts.has(kind) ? kind : '';
  const visible = filter ? drafts.filter(draft => draft.kind === filter) : drafts;
  const active = visible.find(draft => draft.id === selected) ?? visible[0];
  const draftLabel = (value: string) => KINDS.find(key => key === value);
  if (!active) return null;

  return <div className="analysis-draft-index">
    <div className="analysis-draft-sidebar">
      <label className="field">
        <span>{t('kind')}</span>
        <select value={filter} onChange={event => { setKind(event.target.value); setSelected(''); }}>
          <option value="">{t('all')} ({drafts.length})</option>
          {KINDS.filter(key => counts.has(key)).map(key => <option key={key} value={key}>{t(key)} ({counts.get(key)})</option>)}
        </select>
      </label>
      <ul className="analysis-draft-nav" aria-label={t('list')}>
        {visible.map(draft => {
          const label = draftLabel(draft.kind);
          return <li key={draft.id}>
            <button type="button" aria-pressed={draft.id === active.id} aria-controls={detailId} onClick={() => setSelected(draft.id)}>
              <strong>{draft.name}</strong>
              {label ? <small>{t(label)}</small> : null}
            </button>
          </li>;
        })}
      </ul>
    </div>
    <div id={detailId} className="analysis-draft-detail">{renderDraft(active)}</div>
  </div>;
}
