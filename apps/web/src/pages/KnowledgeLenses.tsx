import { useId } from 'react';
import { useT } from '../i18n';
import './KnowledgeLenses.css';

/**
 * The knowledge page's shared lenses (prototype v12): a two-date view (business date / platform-known cutoff),
 * the key-rule card, the ten content dimensions and the merged timeline. Everything here is derived from what the
 * knowledge overview already returns; nothing is invented. Where a source does not state when a rule takes effect,
 * the platform record date is used and the page says so.
 */

export const DIMENSIONS = ['fact', 'rule', 'condition', 'process', 'role', 'decision', 'event', 'term', 'goal', 'exception'] as const;
export type Dimension = typeof DIMENSIONS[number];

export interface LensEvidence { locator: string; quote: string; retrievedAt?: string }
export interface LensDraft {
  id: string; kind: string; name: string; description: string; humanLocked?: boolean;
  evidence: LensEvidence[]; relation?: { from: string; to: string; label: string };
  recordedAt?: string; effectiveFrom?: string; effectiveTo?: string;
}
export interface LensRun { id: string; status: string; createdAt?: string }
export interface LensItem { id: string; title: string; version: string; confirmed: boolean; confirmedAt?: string }
export interface KnowledgeTime { at: string; known: string }
/** Object key -> display name, so relations read 订单 → 需审批 → 主管审批 rather than raw keys. */
export function objectNames(drafts: (LensDraft & { key?: string })[]): Map<string, string> {
  return new Map(drafts.filter(draft => draft.kind === 'object' && draft.key).map(draft => [draft.key!, draft.name]));
}
function relationText(draft: LensDraft, names: Map<string, string>) {
  const r = draft.relation;
  return r ? `${names.get(r.from) ?? r.from} → ${r.label} → ${names.get(r.to) ?? r.to}` : '';
}

const RULE = /必须|须|需要|需经|应当|不得|禁止|不超过|超过|以上|以下|上限|下限|阈值|审批|批准|must|shall|required?|requires|not allowed|threshold|approv|limit|exceed/i;
const CONDITION = /收到|当|一旦|如果|若|触发|到达|超过|满足|when|if |upon|trigger|once|receiv/i;
const DECISION = /决定|决策|承诺|同意|批准|签订|decid|commit|agree|sign/i;
const EVENT = /发生|事件|历史|曾经|记录了|已完成|event|history|happened|incident/i;
const GOAL = /目标|指标|评价|标准|考核|KPI|SLA|goal|target|metric|criteria|KPI/i;
const EXCEPTION = /例外|异常|特殊情况|经验|教训|除非|exception|unless|lesson|edge case/i;

/** Multi-label: one draft can be a fact, a rule and a condition at the same time (prototype v12 「多标签分类」). */
export function dimensionsOf(draft: Pick<LensDraft, 'kind' | 'name' | 'description' | 'relation'>): Dimension[] {
  const text = `${draft.name} ${draft.description} ${draft.relation?.label ?? ''}`;
  const out = new Set<Dimension>();
  if (draft.kind === 'employee') out.add('role');
  if (draft.kind === 'sop') out.add('process');
  if (draft.kind === 'tool') out.add('fact');
  if (draft.kind === 'object') { out.add('term'); out.add('fact'); }
  if (draft.kind === 'relation') out.add('fact');
  // Rules and conditions are statements (relations, workflows); a role, tool or object name is not one.
  const statement = !['employee', 'tool', 'object'].includes(draft.kind);
  if (statement && RULE.test(text)) out.add('rule');
  if (statement && CONDITION.test(text)) out.add('condition');
  if (DECISION.test(text) && draft.kind !== 'tool') out.add('decision');
  if (EVENT.test(text)) out.add('event');
  if (GOAL.test(text)) out.add('goal');
  if (EXCEPTION.test(text)) out.add('exception');
  return DIMENSIONS.filter(d => out.has(d));
}

export const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function timeFromParams(params: URLSearchParams): KnowledgeTime {
  const now = today();
  const at = params.get('at') ?? '', known = params.get('known') ?? '';
  return { at: DATE.test(at) ? at : now, known: DATE.test(known) ? known : now };
}
export function isNow(time: KnowledgeTime) { const now = today(); return time.at >= now && time.known >= now; }

/** When the platform learned a draft: recordedAt, else newest evidence read, else the newest completed analysis run. */
export function recordedOf(draft: LensDraft, runs: LensRun[]): string | undefined {
  if (draft.recordedAt) return draft.recordedAt;
  const read = draft.evidence.map(e => e.retrievedAt).filter((v): v is string => !!v).sort().at(-1);
  if (read) return read;
  return runs.filter(run => run.status === 'completed' && run.createdAt).map(run => run.createdAt!).sort().at(-1);
}
/** Without a stated effective date the record date stands in for it, so both cutoffs compare against it. */
export function visibleAt(recorded: string | undefined, time: KnowledgeTime) {
  if (!recorded) return true;
  const day = recorded.slice(0, 10);
  return day <= time.at && day <= time.known;
}
/** Known-by filters recordedAt; business date filters effectiveFrom/To when the source stated them. */
export function visibleDraft(draft: LensDraft, runs: LensRun[], time: KnowledgeTime) {
  const recorded = recordedOf(draft, runs);
  if (recorded && recorded.slice(0, 10) > time.known) return false;
  if (draft.effectiveFrom || draft.effectiveTo) {
    if (draft.effectiveFrom && time.at < draft.effectiveFrom) return false;
    if (draft.effectiveTo && time.at > draft.effectiveTo) return false;
    return true;
  }
  return visibleAt(recorded, time);
}
const day = (iso?: string) => iso ? iso.slice(0, 10) : '';

const TEXT = {
  en: {
    timeAria: 'Knowledge time view', atLabel: 'Business date to view', knownLabel: 'Known to the platform by',
    timeSummary: 'Knowledge view: business date {at} · known to the platform by {known}. The library keeps every source version; assertions are queried at the dates you choose.',
    timeFallback: 'Where a source does not state when something takes effect, the date the platform recorded it is used.',
    presetNow: 'Today', presetLastRun: 'As known at the last analysis ({date})', hidden: '{n} items were recorded after these dates and are hidden.',
    ruleTitle: 'Key rule', ruleConfirmed: 'Confirmed', rulePending: 'Pending review', ruleRecorded: 'Platform record: {date}', ruleEffective: 'Business effect: not stated in the source — counted from {date}',
    ruleSource: 'Source: {source}', ruleMore: '{n} more rules', ruleEmpty: 'No rule found yet. Rules from analysed materials, such as approval thresholds, appear here with their source.',
    ruleEffectiveStated: 'Business effect: {date}', factTimeStated: 'Effective {from}{to}; recorded {date}', factTimeUntil: ' to {to}',
    ruleSeeAll: 'View all rules',
    factDims: 'Dimensions', factEntity: 'Entity / relation', factSource: 'Source evidence', factTime: 'Time', factStatus: 'Status',
    factSourceMore: '{source} and {n} more', factNoSource: 'No locatable source', factTimeValue: 'Recorded {date}; business effect not stated',
    factConfirmed: 'Confirmed by a person', factPending: 'Extracted candidate, pending review', factStale: 'Source changed, citations withdrawn',
    dimAll: 'All dimensions', dimAria: 'Content dimensions',
    dim_fact: 'Facts & status', dim_rule: 'Rules & policies', dim_condition: 'Triggers & constraints', dim_process: 'Processes & methods',
    dim_role: 'Roles & responsibilities', dim_decision: 'Decisions & commitments', dim_event: 'Events & history', dim_term: 'Terms & concepts',
    dim_goal: 'Goals & criteria', dim_exception: 'Exceptions & lessons',
    dimHint: 'Ten content dimensions, multi-label: one draft can be a fact, a rule and a condition at once.',
    timelineTitle: 'Timeline', timelineHint: 'Every change the platform recorded, newest first. Business effect dates appear when a source states them.',
    timelineEmpty: 'Nothing recorded yet. Confirm a material to start the timeline.',
    evMaterial: 'Material confirmed', evMaterialBody: '{title} · version {version}', evRun: 'Analysis', evRunBody: 'Status: {status}',
    evOrg: 'Organization confirmed', evOrgBody: 'Digital employees and tool placeholders created from the reviewed draft.',
    evDrafts: 'Knowledge recorded', evDraftsBody: '{n} drafts from this analysis', recordAxis: 'Platform record', effectAxis: 'Business effect',
    effectUnknown: 'not stated', later: 'Recorded after the chosen dates',
    run_completed: 'completed', run_failed: 'failed', run_running: 'running', run_queued: 'queued', run_stale: 'source changed', run_outcome_unknown: 'outcome unknown',
  },
  zh: {
    timeAria: '知识时间视图', atLabel: '查看哪个业务日期', knownLabel: '截至哪天平台已知',
    timeSummary: '当前知识视图：业务日期 {at} · 平台已知截至 {known}。资料库保留全部来源版本，断言按所选时间查询。',
    timeFallback: '资料没有写明生效日期的，按平台记录时间计。',
    presetNow: '今天', presetLastRun: '上次分析时所知（{date}）', hidden: '有 {n} 条在所选日期之后才记录，已隐藏。',
    ruleTitle: '关键规则', ruleConfirmed: '已确认', rulePending: '待核对', ruleRecorded: '平台记录：{date} 起', ruleEffective: '业务有效：资料未写明，按 {date} 计',
    ruleSource: '来源：{source}', ruleMore: '另有 {n} 条规则', ruleEmpty: '还没有找到规则。分析资料后，审批阈值这类规则会带着来源显示在这里。',
    ruleEffectiveStated: '业务有效：{date}', factTimeStated: '业务有效 {from}{to}；平台记录 {date}', factTimeUntil: ' 至 {to}',
    ruleSeeAll: '查看全部规则',
    factDims: '内容维度', factEntity: '实体/关系', factSource: '来源证据', factTime: '时间', factStatus: '状态',
    factSourceMore: '{source} 等 {n} 处', factNoSource: '没有可定位的来源', factTimeValue: '平台记录 {date}；业务有效期资料未写明',
    factConfirmed: '已人工确认', factPending: '新资料提取候选，待核对', factStale: '来源已变化，引用已撤回',
    dimAll: '全部维度', dimAria: '内容维度',
    dim_fact: '企业事实与状态', dim_rule: '业务规则与政策', dim_condition: '触发条件与约束', dim_process: '流程与工作方法',
    dim_role: '组织角色与责任', dim_decision: '决策与承诺', dim_event: '业务事件与历史', dim_term: '术语与概念',
    dim_goal: '目标与评价标准', dim_exception: '例外与经验',
    dimHint: '十个内容维度，多标签分类：同一条知识可以同时是事实、规则和条件。',
    timelineTitle: '时间线', timelineHint: '平台记录的每一次变化，最新的在前。资料写明了生效日期时，会同时显示业务有效时间。',
    timelineEmpty: '还没有记录。确认一份资料后，时间线就会开始。',
    evMaterial: '确认资料', evMaterialBody: '{title} · 版本 {version}', evRun: '知识分析', evRunBody: '状态：{status}',
    evOrg: '确认组织', evOrgBody: '按审阅后的草案创建了数字员工和工具占位。',
    evDrafts: '记录知识', evDraftsBody: '本次分析得到 {n} 条草案', recordAxis: '平台记录', effectAxis: '业务有效',
    effectUnknown: '未写明', later: '在所选日期之后记录',
    run_completed: '已完成', run_failed: '失败', run_running: '进行中', run_queued: '排队中', run_stale: '来源已变化', run_outcome_unknown: '结果未知',
  },
};

export function TimeBar({ time, onChange, lastRun, hidden }: { time: KnowledgeTime; onChange: (next: KnowledgeTime) => void; lastRun?: string; hidden: number }) {
  const t = useT(TEXT);
  const id = useId();
  const now = today();
  return <section className="lens-time" aria-label={t('timeAria')}>
    <p className="lens-time-summary">{t('timeSummary', { at: time.at, known: time.known })}</p>
    <div className="lens-time-controls">
      <label className="lens-date" htmlFor={`${id}-at`}><span>{t('atLabel')}</span>
        <input id={`${id}-at`} type="date" value={time.at} max={now} onChange={event => event.target.value && onChange({ ...time, at: event.target.value })} /></label>
      <label className="lens-date" htmlFor={`${id}-known`}><span>{t('knownLabel')}</span>
        <input id={`${id}-known`} type="date" value={time.known} max={now} onChange={event => event.target.value && onChange({ ...time, known: event.target.value })} /></label>
      <div className="lens-presets">
        <button type="button" className="lens-chip" aria-pressed={isNow(time)} onClick={() => onChange({ at: now, known: now })}>{t('presetNow')}</button>
        {lastRun ? <button type="button" className="lens-chip" aria-pressed={time.known === day(lastRun) && time.at === now}
          onClick={() => onChange({ at: now, known: day(lastRun) })}>{t('presetLastRun', { date: day(lastRun) })}</button> : null}
      </div>
    </div>
    <p className="lens-time-note">{t('timeFallback')}{hidden ? ` ${t('hidden', { n: hidden })}` : ''}</p>
  </section>;
}

export function RuleCard({ drafts, runs, names, onSeeAll }: { drafts: LensDraft[]; runs: LensRun[]; names: Map<string, string>; onSeeAll?: () => void }) {
  const t = useT(TEXT);
  const rules = drafts.filter(draft => dimensionsOf(draft).includes('rule'))
    .sort((a, b) => Number(!!b.humanLocked) - Number(!!a.humanLocked) || Number(b.kind === 'relation') - Number(a.kind === 'relation'));
  const rule = rules[0];
  if (!rule) return <aside className="lens-rule is-empty" aria-label={t('ruleTitle')}><p>{t('ruleEmpty')}</p></aside>;
  const recorded = day(recordedOf(rule, runs));
  const source = rule.evidence[0]?.locator;
  const effect = rule.effectiveFrom;
  return <aside className="lens-rule" aria-label={t('ruleTitle')}>
    <div className="lens-rule-main">
      <span className="lens-eyebrow">{t('ruleTitle')}</span>
      <strong>{rule.description || rule.name}</strong>
      {rule.relation ? <p>{relationText(rule, names)}</p> : null}
      <p className="lens-rule-meta">
        {effect ? <span>{t('ruleEffectiveStated', { date: effect })}</span> : recorded ? <span>{t('ruleEffective', { date: recorded })}</span> : null}
        {recorded ? <span>{t('ruleRecorded', { date: recorded })}</span> : null}
        {source ? <span>{t('ruleSource', { source })}</span> : null}
      </p>
    </div>
    <div className="lens-rule-side">
      <span className={`lens-status ${rule.humanLocked ? 'is-ok' : ''}`}>{t(rule.humanLocked ? 'ruleConfirmed' : 'rulePending')}</span>
      {rules.length > 1 && onSeeAll ? <button type="button" className="lens-link" onClick={onSeeAll}>{t('ruleMore', { n: rules.length - 1 })}</button> : null}
    </div>
  </aside>;
}

export function DimensionChips({ drafts, value, onChange }: { drafts: LensDraft[]; value: Dimension | ''; onChange: (next: Dimension | '') => void }) {
  const t = useT(TEXT);
  const counts = new Map<Dimension, number>();
  for (const draft of drafts) for (const dim of dimensionsOf(draft)) counts.set(dim, (counts.get(dim) ?? 0) + 1);
  return <div className="lens-dims">
    <p className="lens-dim-hint">{t('dimHint')}</p>
    <div className="lens-dim-chips" role="group" aria-label={t('dimAria')}>
      <button type="button" className="lens-chip" aria-pressed={!value} onClick={() => onChange('')}>{t('dimAll')} <span>{drafts.length}</span></button>
      {DIMENSIONS.map(dim => <button key={dim} type="button" className="lens-chip" aria-pressed={value === dim} onClick={() => onChange(value === dim ? '' : dim)}>
        {t(`dim_${dim}` as keyof typeof TEXT.en)} <span>{counts.get(dim) ?? 0}</span></button>)}
    </div>
  </div>;
}

interface TimelineEvent { at: string; kind: 'material' | 'run' | 'org' | 'drafts'; title: string; body: string }

export function KnowledgeTimeline({ items, runs, drafts, organizationConfirmedAt, time }: {
  items: LensItem[]; runs: LensRun[]; drafts: LensDraft[]; organizationConfirmedAt?: string; time: KnowledgeTime;
}) {
  const t = useT(TEXT);
  const events: TimelineEvent[] = [];
  for (const item of items) if (item.confirmed && item.confirmedAt) events.push({ at: item.confirmedAt, kind: 'material', title: t('evMaterial'), body: t('evMaterialBody', { title: item.title, version: item.version }) });
  const completed = runs.filter(run => run.createdAt);
  const latestCompleted = completed.filter(run => run.status === 'completed').map(run => run.createdAt!).sort().at(-1);
  for (const run of completed) {
    events.push({ at: run.createdAt!, kind: 'run', title: t('evRun'), body: t('evRunBody', { status: t(`run_${run.status}` as keyof typeof TEXT.en) || run.status }) });
    if (run.createdAt === latestCompleted && drafts.length) events.push({ at: run.createdAt!, kind: 'drafts', title: t('evDrafts'), body: t('evDraftsBody', { n: drafts.length }) });
  }
  if (organizationConfirmedAt) events.push({ at: organizationConfirmedAt, kind: 'org', title: t('evOrg'), body: t('evOrgBody') });
  events.sort((a, b) => b.at.localeCompare(a.at));
  return <section className="lens-timeline" aria-labelledby="lens-timeline-heading">
    <div className="lens-section-head"><h2 id="lens-timeline-heading">{t('timelineTitle')}</h2><p className="helper">{t('timelineHint')}</p></div>
    {events.length ? <ol className="lens-events">{events.map((event, index) => {
      const later = !visibleAt(event.at, time);
      return <li key={`${event.kind}-${event.at}-${index}`} className={`lens-event is-${event.kind} ${later ? 'is-later' : ''}`}>
        <div className="lens-axes">
          <span><small>{t('recordAxis')}</small><time dateTime={event.at}>{event.at.slice(0, 16).replace('T', ' ')}</time></span>
          <span><small>{t('effectAxis')}</small>{event.kind === 'material' || event.kind === 'drafts' ? t('effectUnknown') : event.at.slice(0, 10)}</span>
        </div>
        <div className="lens-event-body"><strong>{event.title}</strong><p>{event.body}</p>{later ? <span className="lens-later">{t('later')}</span> : null}</div>
      </li>;
    })}</ol> : <p className="knowledge-empty">{t('timelineEmpty')}</p>}
  </section>;
}

/** The v12 assertion facts: dimensions, entity/relation, source, time and status, read off the draft itself. */
export function AssertionFacts({ draft, runs, names, stale }: { draft: LensDraft; runs: LensRun[]; names: Map<string, string>; stale?: boolean }) {
  const t = useT(TEXT);
  const recorded = day(recordedOf(draft, runs));
  const source = draft.evidence[0]?.locator;
  const dims = dimensionsOf(draft);
  return <dl className="lens-facts">
    <div><dt>{t('factDims')}</dt><dd className="lens-fact-dims">{dims.map(dim => <span key={dim}>{t(`dim_${dim}` as keyof typeof TEXT.en)}</span>)}</dd></div>
    <div><dt>{t('factEntity')}</dt><dd>{draft.relation ? relationText(draft, names) : draft.name}</dd></div>
    <div><dt>{t('factSource')}</dt><dd>{source ? draft.evidence.length > 1 ? t('factSourceMore', { source, n: draft.evidence.length }) : source : t('factNoSource')}</dd></div>
    {recorded ? <div><dt>{t('factTime')}</dt><dd>{draft.effectiveFrom
      ? t('factTimeStated', { from: draft.effectiveFrom, to: draft.effectiveTo ? t('factTimeUntil', { to: draft.effectiveTo }) : '', date: recorded })
      : t('factTimeValue', { date: recorded })}</dd></div> : null}
    <div><dt>{t('factStatus')}</dt><dd>{t(stale ? 'factStale' : draft.humanLocked ? 'factConfirmed' : 'factPending')}</dd></div>
  </dl>;
}
