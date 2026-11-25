import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { useLang, useT } from '../i18n';
import './CalendarPage.css';

/**
 * The workflow calendar: which digital employee runs which workflow, on which day and at what time.
 * Schedules come from analysis (suggestions, with the source that states the cadence) or are added by an admin.
 * Nothing runs until an admin turns it on; members see only the employees they are responsible for.
 */
export interface Rule { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; weekdays?: number[]; monthDay?: number; month?: number; hour: number; minute: number; timezone: string }
type OccurrenceState = 'planned' | 'suggested' | 'ran' | 'skipped' | 'failed' | 'missed' | 'paused';
export interface CalendarSchedule {
  id: string; title: string; description: string; rule: Rule; ruleText: string; ruleTextEn: string;
  status: 'suggested' | 'active' | 'paused' | 'dismissed'; origin: 'analysis' | 'manual';
  employeeId: string | null; employeeName: string | null; participants: { id: string; name: string }[];
  evidence: { title: string; locator: string; quote: string } | null; skips: string[];
  next: string[]; occurrences: { stamp: string; at: string; state: OccurrenceState; taskId: string | null; note: string }[];
  employeeOnline: boolean;
}
interface CalendarData { canManage: boolean; employees: { id: string; name: string; status: string }[]; schedules: CalendarSchedule[] }

const TEXT = {
  en: {
    title: 'Calendar', lead: 'Which digital employee runs which workflow, on which day and at what time.',
    month: 'Month', week: 'Week', today: 'Today', prev: 'Previous', next: 'Next', add: 'New schedule',
    suggestions: 'Analysis suggested {n} scheduled workflows from your documents. Review them before they run.', review: 'Review',
    employees: 'Digital employees', all: 'All', unassigned: 'Not assigned', none: 'Nothing scheduled in this period.',
    empty: 'No schedules yet. When analysis finds a workflow your documents say runs on a cadence, it appears here as a suggestion.',
    more: '+{n} more', close: 'Close',
    s_suggested: 'Suggested', s_active: 'On', s_paused: 'Paused',
    o_planned: 'Planned', o_suggested: 'Suggested', o_ran: 'Started', o_skipped: 'Skipped', o_failed: 'Not started', o_missed: 'Missed', o_paused: 'Paused',
    when: 'When', who: 'Done by', with: 'Also involved', source: 'From', upcoming: 'Next runs', noneUpcoming: 'Not scheduled to run.',
    pick: 'Choose a digital employee', enable: 'Turn on', pause: 'Pause', resume: 'Turn on again', dismiss: 'Don’t use', runNow: 'Run now', edit: 'Change time',
    skip: 'Skip this one', unskip: 'Run this one', offline: 'This employee is not online; the run will wait for its computer.',
    needsEmployee: 'Choose who carries it out before turning it on.', save: 'Save', cancel: 'Cancel', saved: 'Saved.', error: 'That did not work. Try again.',
    started: 'Started. The task is in the command room.',
    f_daily: 'Every day', f_workdays: 'Every weekday', f_weekly: 'Weekly', f_monthly: 'Monthly', f_yearly: 'Yearly',
    weekdays: 'Days', monthDay: 'Day of month', lastDay: 'Last day', monthOf: 'Month', time: 'Time',
    name: 'Workflow', work: 'What to do (steps)', createHint: 'It runs at these times as a task for the employee you choose.',
    memberNote: 'You see the employees you are responsible for. Admins set the schedules.',
  },
  zh: {
    title: '日历', lead: '哪天什么时间，哪位数字员工按哪个流程开工。',
    month: '月', week: '周', today: '今天', prev: '上一段', next: '下一段', add: '新建日程',
    suggestions: '分析从你的资料里找到 {n} 个定时流程，确认后才会运行。', review: '去确认',
    employees: '数字员工', all: '全部', unassigned: '待指派', none: '这段时间没有安排。',
    empty: '还没有日程。分析发现资料里写明按时执行的流程时，会作为建议出现在这里。',
    more: '还有 {n} 个', close: '关闭',
    s_suggested: '建议', s_active: '已启用', s_paused: '已暂停',
    o_planned: '待运行', o_suggested: '建议', o_ran: '已启动', o_skipped: '已跳过', o_failed: '未启动', o_missed: '错过', o_paused: '暂停中',
    when: '时间', who: '由谁来做', with: '也参与', source: '依据', upcoming: '接下来', noneUpcoming: '目前不会运行。',
    pick: '选择数字员工', enable: '启用', pause: '暂停', resume: '重新启用', dismiss: '不采用', runNow: '立即运行', edit: '改时间',
    skip: '跳过这一次', unskip: '恢复这一次', offline: '这位员工现在不在线，到时任务会等它的电脑上线。',
    needsEmployee: '启用前请先选择由谁来做。', save: '保存', cancel: '取消', saved: '已保存。', error: '没有成功，请重试。',
    started: '已启动，任务在指挥室里。',
    f_daily: '每天', f_workdays: '每个工作日', f_weekly: '每周', f_monthly: '每月', f_yearly: '每年',
    weekdays: '星期', monthDay: '几号', lastDay: '最后一天', monthOf: '月份', time: '时间',
    name: '流程名称', work: '要做什么（步骤）', createHint: '到点会作为任务交给你选的数字员工。',
    memberNote: '你只能看到自己负责的数字员工。日程由管理员设置。',
  },
};

const DAY = 86_400_000;
const WEEK_ZH = ['一', '二', '三', '四', '五', '六', '日'];
const WEEK_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PALETTE = 6;

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfWeek = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

function hashQuery(): URLSearchParams { return new URLSearchParams(window.location.hash.split('?')[1] ?? ''); }

export function CalendarPage() {
  const t = useT(TEXT);
  const [lang] = useLang();
  const [view, setView] = useState<'month' | 'week'>(() => (window.matchMedia?.('(max-width: 720px)').matches ? 'week' : 'month'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const only = hashQuery().get('employee');
    return only ? new Set(['__only__' + only]) : new Set();
  });
  const [open, setOpen] = useState<{ id: string; stamp?: string } | 'new' | null>(null);
  const [onlySuggested, setOnlySuggested] = useState(false);

  const range = useMemo(() => {
    if (view === 'week') { const from = startOfWeek(anchor); return { from, to: new Date(from.getTime() + 7 * DAY), days: 7 }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const from = startOfWeek(first);
    return { from, to: new Date(from.getTime() + 42 * DAY), days: 42 };
  }, [view, anchor]);

  const load = useCallback(async () => {
    const r = await api<CalendarData>(`/api/v1/schedules?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`);
    if (r.status !== 200) { setFailed(true); return; }
    setFailed(false);
    setData(r.body);
  }, [range]);
  useEffect(() => { void load().catch(() => setFailed(true)); }, [load]);

  const employees = data?.employees ?? [];
  const colorOf = (employeeId: string | null) => employeeId === null ? 'none' : String(Math.max(0, employees.findIndex((item) => item.id === employeeId)) % PALETTE);
  const onlyId = [...hidden].find((key) => key.startsWith('__only__'))?.slice(8);
  const shown = (employeeId: string | null) => onlyId ? employeeId === onlyId : !hidden.has(employeeId ?? '__none__');
  const schedules = (data?.schedules ?? []).filter((item) => shown(item.employeeId) && (!onlySuggested || item.status === 'suggested'));
  const suggested = (data?.schedules ?? []).filter((item) => item.status === 'suggested').length;

  // Every occurrence, by local day.
  const byDay = new Map<string, { schedule: CalendarSchedule; at: Date; stamp: string; state: OccurrenceState }[]>();
  for (const schedule of schedules) {
    for (const occurrence of schedule.occurrences) {
      const at = new Date(occurrence.at);
      const key = dayKey(at);
      byDay.set(key, [...(byDay.get(key) ?? []), { schedule, at, stamp: occurrence.stamp, state: occurrence.state }]);
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());

  const step = (direction: -1 | 1) => setAnchor((current) => view === 'week'
    ? new Date(current.getTime() + direction * 7 * DAY)
    : new Date(current.getFullYear(), current.getMonth() + direction, 1));
  const toggle = (key: string) => setHidden((current) => {
    const next = new Set([...current].filter((item) => !item.startsWith('__only__')));
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const heading = view === 'month'
    ? (lang === 'zh' ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月` : anchor.toLocaleDateString('en', { year: 'numeric', month: 'long' }))
    : `${dayKey(range.from)} – ${dayKey(new Date(range.to.getTime() - DAY))}`;
  const today = dayKey(new Date());
  const days = Array.from({ length: range.days }, (_, i) => new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate() + i));
  const selected = open && open !== 'new' ? data?.schedules.find((item) => item.id === open.id) ?? null : null;
  const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  return <div className="cal-page">
    <header className="page-head cal-head">
      <div><h1>{t('title')}</h1><p>{t('lead')}</p></div>
      <div className="cal-tools">
        <span className="chip-row" role="group" aria-label={t('title')}>
          <button type="button" className="chip" aria-pressed={view === 'month'} onClick={() => setView('month')}>{t('month')}</button>
          <button type="button" className="chip" aria-pressed={view === 'week'} onClick={() => setView('week')}>{t('week')}</button>
        </span>
        <button type="button" className="btn quiet" aria-label={t('prev')} onClick={() => step(-1)}>‹</button>
        <button type="button" className="btn" onClick={() => setAnchor(new Date())}>{t('today')}</button>
        <button type="button" className="btn quiet" aria-label={t('next')} onClick={() => step(1)}>›</button>
        {data?.canManage ? <button type="button" className="btn primary" onClick={() => setOpen('new')}>{t('add')}</button> : null}
      </div>
    </header>
    {suggested > 0 && data?.canManage ? <p className="cal-banner" role="status">
      <span>{t('suggestions', { n: suggested })}</span>
      <button type="button" className="btn" aria-pressed={onlySuggested} onClick={() => setOnlySuggested((value) => !value)}>{onlySuggested ? t('all') : t('review')}</button>
    </p> : null}
    {failed ? <p className="warn" role="alert">{t('error')}</p> : null}
    <div className="cal-layout">
      <aside className="cal-side" aria-label={t('employees')}>
        <h2 className="cal-side-title">{t('employees')}</h2>
        <ul>
          {employees.map((employee) => <li key={employee.id}>
            <label className="cal-filter"><input type="checkbox" checked={shown(employee.id)} onChange={() => toggle(employee.id)} />
              <span className={`cal-dot c${colorOf(employee.id)}`} aria-hidden="true" />
              <span className="cal-filter-name">{employee.name}</span>
              <small>{(data?.schedules ?? []).filter((item) => item.employeeId === employee.id && item.status === 'active').length || ''}</small></label>
          </li>)}
          {data?.canManage ? <li><label className="cal-filter"><input type="checkbox" checked={shown(null)} onChange={() => toggle('__none__')} />
            <span className="cal-dot cnone" aria-hidden="true" /><span className="cal-filter-name">{t('unassigned')}</span></label></li> : null}
        </ul>
        {data && !data.canManage ? <p className="helper">{t('memberNote')}</p> : null}
      </aside>
      <section className="cal-main" aria-label={heading}>
        <h2 className="cal-heading">{heading}</h2>
        {data && data.schedules.length === 0 ? <p className="helper cal-empty">{t('empty')}</p> : null}
        <div className={`cal-grid ${view}`} role="grid">
          {(lang === 'zh' ? WEEK_ZH : WEEK_EN).map((name) => <div key={name} className="cal-weekday" role="columnheader">{name}</div>)}
          {days.map((day) => {
            const key = dayKey(day);
            const items = byDay.get(key) ?? [];
            const limit = view === 'month' ? 3 : 12;
            const outside = view === 'month' && day.getMonth() !== anchor.getMonth();
            return <div key={key} role="gridcell" className={`cal-day${outside ? ' outside' : ''}${key === today ? ' today' : ''}`}>
              <span className="cal-date">{view === 'week' ? `${day.getMonth() + 1}/${day.getDate()}` : day.getDate()}</span>
              {items.slice(0, limit).map((item) => (
                <button key={item.schedule.id + item.stamp} type="button" className={`cal-entry c${colorOf(item.schedule.employeeId)}`} data-state={item.state}
                  title={`${time(item.at)} ${item.schedule.title} · ${item.schedule.employeeName ?? t('unassigned')} · ${t(`o_${item.state}`)}`}
                  onClick={() => setOpen({ id: item.schedule.id, stamp: item.stamp })}>
                  <span className="cal-entry-time">{time(item.at)}</span>
                  <span className="cal-entry-title">{item.schedule.title}</span>
                  {view === 'week' ? <span className="cal-entry-who">@{item.schedule.employeeName ?? t('unassigned')}</span> : null}
                </button>
              ))}
              {items.length > limit ? <span className="cal-more">{t('more', { n: items.length - limit })}</span> : null}
            </div>;
          })}
        </div>
        {data && data.schedules.length > 0 && schedules.every((item) => item.occurrences.length === 0) ? <p className="helper">{t('none')}</p> : null}
      </section>
    </div>
    {open === 'new' ? <NewSchedule employees={employees} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); void load(); }} /> : null}
    {selected ? <ScheduleDrawer schedule={selected} stamp={open !== 'new' ? open?.stamp : undefined} employees={employees} canManage={!!data?.canManage}
      onClose={() => setOpen(null)} onChanged={() => void load()} /> : null}
  </div>;
}

function Drawer({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const t = useT(TEXT);
  useEffect(() => {
    const dialog = document.getElementById(id) as HTMLDialogElement | null;
    dialog?.showModal();
    return () => dialog?.close();
  }, [id]);
  return <dialog id={id} className="emp-drawer cal-drawer" aria-labelledby={id + '-title'} onClose={onClose}>
    <form method="dialog" className="emp-drawer-bar">
      <h2 id={id + '-title'}>{title}</h2>
      <button className="btn" value="close">{t('close')}</button>
    </form>
    {children}
  </dialog>;
}

function ScheduleDrawer({ schedule, stamp, employees, canManage, onClose, onChanged }: {
  schedule: CalendarSchedule; stamp?: string; employees: CalendarData['employees']; canManage: boolean; onClose: () => void; onChanged: () => void;
}) {
  const t = useT(TEXT);
  const [lang] = useLang();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [employeeId, setEmployeeId] = useState(schedule.employeeId ?? '');
  const [editing, setEditing] = useState(false);
  const occurrence = stamp ? schedule.occurrences.find((item) => item.stamp === stamp) : undefined;

  async function act(action: string, body: Record<string, unknown> = {}, done = t('saved')) {
    setBusy(true); setMessage(null);
    const r = await api<{ message?: string }>(`/api/v1/schedules/${schedule.id}/${action}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r || r.status !== 200) { setMessage({ text: r?.body.message ?? t('error'), error: true }); return false; }
    setMessage({ text: done });
    onChanged();
    return true;
  }

  const when = (iso: string) => new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-NZ', { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const skipped = stamp ? schedule.skips.includes(stamp) : false;
  return <Drawer id="cal-drawer" title={schedule.title} onClose={onClose}>
    <p className="cal-drawer-tags">
      <span className={`tag ${schedule.status === 'active' ? 'is-good' : schedule.status === 'suggested' ? 'is-accent' : 'is-warn'}`}>{t(`s_${schedule.status}` as 's_active')}</span>
      {occurrence ? <span className="tag">{when(occurrence.at)} · {t(`o_${occurrence.state}`)}</span> : null}
    </p>
    {message ? <p className={message.error ? 'warn' : 'accounts-done'} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    <dl className="emp-drawer-facts">
      <div><dt>{t('when')}</dt><dd>{lang === 'zh' ? schedule.ruleText : schedule.ruleTextEn}</dd></div>
      <div><dt>{t('who')}</dt><dd>{canManage
        ? <select value={employeeId} disabled={busy} aria-label={t('who')} onChange={(event) => {
            setEmployeeId(event.target.value);
            if (event.target.value && schedule.status !== 'suggested') void act('update', { employeeId: event.target.value });
          }}>
            <option value="">{t('pick')}</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        : schedule.employeeName ?? t('unassigned')}
        {schedule.employeeId && !schedule.employeeOnline && schedule.status === 'active' ? <p className="helper">{t('offline')}</p> : null}</dd></div>
      {schedule.participants.length ? <div><dt>{t('with')}</dt><dd>{schedule.participants.map((item) => '@' + item.name).join('、')}</dd></div> : null}
      {schedule.evidence ? <div><dt>{t('source')}</dt><dd><blockquote className="cal-quote">“{schedule.evidence.quote}”</blockquote>
        <small className="helper">{[schedule.evidence.title, schedule.evidence.locator].filter(Boolean).join(' · ')}</small></dd></div> : null}
      <div><dt>{t('upcoming')}</dt><dd>{schedule.next.length ? <ul className="cal-next">{schedule.next.map((iso) => <li key={iso}>{when(iso)}</li>)}</ul> : t('noneUpcoming')}</dd></div>
    </dl>
    {schedule.description ? <p className="helper">{schedule.description}</p> : null}
    {editing ? <RuleForm rule={schedule.rule} busy={busy} onCancel={() => setEditing(false)}
      onSave={async (rule) => { if (await act('update', { rule })) setEditing(false); }} /> : null}
    <div className="cal-actions">
      {canManage && schedule.status !== 'active' ? <button type="button" className="btn primary" disabled={busy || !employeeId}
        title={employeeId ? undefined : t('needsEmployee')} onClick={() => void act('enable', { employeeId })}>{schedule.status === 'paused' ? t('resume') : t('enable')}</button> : null}
      {canManage && schedule.status === 'active' ? <button type="button" className="btn" disabled={busy} onClick={() => void act('pause')}>{t('pause')}</button> : null}
      {stamp && schedule.status === 'active' && occurrence && ['planned', 'skipped'].includes(occurrence.state)
        ? <button type="button" className="btn" disabled={busy} onClick={() => void act(skipped ? 'unskip' : 'skip', { stamp })}>{skipped ? t('unskip') : t('skip')}</button> : null}
      {canManage ? <button type="button" className="btn" disabled={busy || !employeeId} onClick={() => void (async () => {
        setBusy(true); setMessage(null);
        const r = await api(`/api/v1/schedules/${schedule.id}/run-now`, { method: 'POST', body: '{}' }).catch(() => null);
        setBusy(false);
        setMessage(r && r.status === 200 ? { text: t('started') } : { text: t('error'), error: true });
        onChanged();
      })()}>{t('runNow')}</button> : null}
      {canManage && !editing ? <button type="button" className="btn quiet" disabled={busy} onClick={() => setEditing(true)}>{t('edit')}</button> : null}
      {canManage ? <button type="button" className="btn quiet" disabled={busy} onClick={() => void act('dismiss').then((ok) => { if (ok) onClose(); })}>{t('dismiss')}</button> : null}
    </div>
    {canManage && !employeeId && schedule.status !== 'active' ? <p className="helper">{t('needsEmployee')}</p> : null}
  </Drawer>;
}

function RuleForm({ rule, busy, onSave, onCancel }: { rule: Rule; busy: boolean; onSave: (rule: Rule) => void | Promise<void>; onCancel?: () => void }) {
  const t = useT(TEXT);
  const [lang] = useLang();
  const workdays = rule.weekdays?.join(',') === '1,2,3,4,5';
  const [kind, setKind] = useState<'daily' | 'workdays' | 'weekly' | 'monthly' | 'yearly'>(rule.freq === 'daily' && workdays ? 'workdays' : rule.freq);
  const [weekdays, setWeekdays] = useState<number[]>(rule.weekdays ?? [1]);
  const [monthDay, setMonthDay] = useState(rule.monthDay ?? 1);
  const [month, setMonth] = useState(rule.month ?? 1);
  const [clock, setClock] = useState(`${pad(rule.hour)}:${pad(rule.minute)}`);
  function submit(event: FormEvent) {
    event.preventDefault();
    const [hour, minute] = clock.split(':').map(Number);
    const base = { hour: hour ?? 9, minute: minute ?? 0, timezone: rule.timezone };
    void onSave(kind === 'workdays' ? { ...base, freq: 'daily', weekdays: [1, 2, 3, 4, 5] }
      : kind === 'daily' ? { ...base, freq: 'daily' }
      : kind === 'weekly' ? { ...base, freq: 'weekly', weekdays: weekdays.length ? weekdays : [1] }
      : kind === 'monthly' ? { ...base, freq: 'monthly', monthDay }
      : { ...base, freq: 'yearly', monthDay, month });
  }
  return <form className="cal-rule" onSubmit={submit}>
    <span className="chip-row" role="group">
      {(['daily', 'workdays', 'weekly', 'monthly', 'yearly'] as const).map((value) =>
        <button key={value} type="button" className="chip chip-small" aria-pressed={kind === value} onClick={() => setKind(value)}>{t(`f_${value}`)}</button>)}
    </span>
    {kind === 'weekly' ? <span className="chip-row" role="group" aria-label={t('weekdays')}>
      {(lang === 'zh' ? WEEK_ZH : WEEK_EN).map((name, index) => <button key={name} type="button" className="chip chip-small" aria-pressed={weekdays.includes(index + 1)}
        onClick={() => setWeekdays((current) => current.includes(index + 1) ? current.filter((d) => d !== index + 1) : [...current, index + 1].sort())}>{name}</button>)}
    </span> : null}
    <div className="cal-rule-row">
      {kind === 'yearly' ? <label className="field"><span>{t('monthOf')}</span>
        <select value={month} onChange={(event) => setMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label> : null}
      {kind === 'monthly' || kind === 'yearly' ? <label className="field"><span>{t('monthDay')}</span>
        <select value={monthDay} onChange={(event) => setMonthDay(Number(event.target.value))}>
          {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}<option value={-1}>{t('lastDay')}</option></select></label> : null}
      <label className="field"><span>{t('time')}</span><input type="time" value={clock} onChange={(event) => setClock(event.target.value)} required /></label>
    </div>
    <div className="cal-actions">
      <button className="btn primary" disabled={busy}>{t('save')}</button>
      {onCancel ? <button type="button" className="btn quiet" onClick={onCancel}>{t('cancel')}</button> : null}
    </div>
  </form>;
}

function NewSchedule({ employees, onClose, onSaved }: { employees: CalendarData['employees']; onClose: () => void; onSaved: () => void }) {
  const t = useT(TEXT);
  const [title, setTitle] = useState('');
  const [work, setWork] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Pacific/Auckland';
  return <Drawer id="cal-new" title={t('add')} onClose={onClose}>
    <div className="stack">
      <label className="field"><span>{t('name')}</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field"><span>{t('work')}</span><textarea rows={4} value={work} maxLength={4000} onChange={(event) => setWork(event.target.value)} /></label>
      <label className="field"><span>{t('who')}</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
        <option value="">{t('pick')}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
      <p className="helper">{t('createHint')}</p>
      {error ? <p className="warn" role="alert">{error}</p> : null}
    </div>
    <RuleForm rule={{ freq: 'weekly', weekdays: [1], hour: 9, minute: 0, timezone: zone }} busy={busy || !title.trim() || !employeeId} onSave={async (rule) => {
      setBusy(true); setError('');
      const r = await api<{ message?: string }>('/api/v1/schedules', { method: 'POST', body: JSON.stringify({ title, work, employeeId, rule }) }).catch(() => null);
      setBusy(false);
      if (!r || r.status !== 200) { setError(r?.body.message ?? t('error')); return; }
      onSaved();
    }} />
  </Drawer>;
}

/** The employee drawer's "日程" section: this employee's next scheduled runs. */
export function EmployeeSchedule({ employeeId }: { employeeId: string }) {
  const [lang] = useLang();
  const [items, setItems] = useState<{ at: string; title: string; state: OccurrenceState }[] | null>(null);
  useEffect(() => {
    let stop = false;
    const from = new Date(), to = new Date(from.getTime() + 31 * DAY);
    void api<CalendarData>(`/api/v1/schedules?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`).then((r) => {
      if (stop) return;
      const list = r.status === 200 ? r.body.schedules.filter((item) => item.employeeId === employeeId && item.status === 'active')
        .flatMap((item) => item.occurrences.filter((o) => o.state === 'planned').map((o) => ({ at: o.at, title: item.title, state: o.state }))) : [];
      setItems(list.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5));
    }).catch(() => { if (!stop) setItems([]); });
    return () => { stop = true; };
  }, [employeeId]);
  const zh = lang === 'zh';
  const when = (iso: string) => new Date(iso).toLocaleString(zh ? 'zh-CN' : 'en-NZ', { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <div className="emp-schedule">
    {items === null ? <p className="helper">…</p> : items.length === 0
      ? <p className="helper">{zh ? '未来 30 天没有安排。' : 'Nothing scheduled in the next 30 days.'}</p>
      : <ul className="cal-next">{items.map((item) => <li key={item.at + item.title}><span>{when(item.at)}</span> · {item.title}</li>)}</ul>}
    <a href={`#calendar?employee=${encodeURIComponent(employeeId)}`}>{zh ? '在日历中查看' : 'Open in calendar'}</a>
  </div>;
}
