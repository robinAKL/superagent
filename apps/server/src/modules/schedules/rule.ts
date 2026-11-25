import { formatInTimeZone, localStamp, pad, zonedTimeToUtc, type LocalDateTime } from '../sop/zoned-time.js';

/**
 * When a workflow runs: a calendar cadence at a local time. weekdays are ISO (1 = Monday … 7 = Sunday); monthDay -1
 * is the last day of the month, and a day past the month's end (31 in April) runs on its last day.
 */
export interface ScheduleRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  weekdays?: number[];
  monthDay?: number;
  month?: number;
  hour: number;
  minute: number;
  timezone: string;
}

export const DEFAULT_TIMEZONE = 'Pacific/Auckland';
const FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly']);

function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** A rule from untrusted input (the model, a request), or null when it is not one. "time" may stand for hour:minute. */
export function parseRule(input: unknown, fallbackZone = DEFAULT_TIMEZONE): ScheduleRule | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (!FREQS.has(value.freq as string)) return null;
  const time = typeof value.time === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.time.trim()) : null;
  const hour = time ? Number(time[1]) : value.hour === undefined ? 9 : Number(value.hour);
  const minute = time ? Number(time[2]) : value.minute === undefined ? 0 : Number(value.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const rule: ScheduleRule = { freq: value.freq as ScheduleRule['freq'], hour, minute, timezone: validZone(value.timezone) ? value.timezone : fallbackZone };
  if (value.weekdays !== undefined) {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return null;
    rule.weekdays = [...new Set(value.weekdays as number[])].sort((a, b) => a - b);
  }
  if (value.monthDay !== undefined) {
    const day = Number(value.monthDay);
    if (!Number.isInteger(day) || !(day === -1 || (day >= 1 && day <= 31))) return null;
    rule.monthDay = day;
  }
  if (value.month !== undefined) {
    const month = Number(value.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    rule.month = month;
  }
  if (rule.freq === 'weekly' && !rule.weekdays) return null;
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && rule.monthDay === undefined) return null;
  if (rule.freq === 'yearly' && rule.month === undefined) return null;
  if (rule.freq !== 'daily' && rule.freq !== 'weekly') delete rule.weekdays;
  if (rule.freq === 'daily' || rule.freq === 'weekly') { delete rule.monthDay; delete rule.month; }
  if (rule.freq === 'monthly') delete rule.month;
  return rule;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const isoWeekday = (year: number, month: number, day: number) => ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;

function matches(rule: ScheduleRule, year: number, month: number, day: number): boolean {
  const weekday = isoWeekday(year, month, day);
  const last = daysIn(year, month);
  const monthDay = rule.monthDay === -1 || (rule.monthDay ?? 0) > last ? last : rule.monthDay;
  switch (rule.freq) {
    case 'daily': return !rule.weekdays || rule.weekdays.includes(weekday);
    case 'weekly': return rule.weekdays!.includes(weekday);
    case 'monthly': return day === monthDay;
    case 'yearly': return month === rule.month && day === monthDay;
  }
}

export interface Occurrence { stamp: string; at: number }

/** Occurrences with from <= at < to, oldest first (at most `limit`). stamp is the local time, the run's identity. */
export function occurrences(rule: ScheduleRule, from: number, to: number, limit = 500): Occurrence[] {
  const result: Occurrence[] = [];
  const start = formatInTimeZone(from - 36 * 3600_000, rule.timezone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  const end = to + 36 * 3600_000;
  while (cursor <= end && result.length < limit) {
    const date = new Date(cursor);
    const local: LocalDateTime = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: rule.hour, minute: rule.minute };
    if (matches(rule, local.year, local.month, local.day)) {
      const at = zonedTimeToUtc(local, rule.timezone).utcMs;
      if (at >= from && at < to) result.push({ stamp: localStamp(local), at });
    }
    cursor += 86_400_000;
  }
  return result;
}

export function nextOccurrences(rule: ScheduleRule, after: number, count: number): Occurrence[] {
  return occurrences(rule, after, after + 400 * 86_400_000, count);
}

const WEEKDAYS_ZH = ['', '一', '二', '三', '四', '五', '六', '日'];
const WEEKDAYS_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "每周一、三 09:00", "每月最后一天 17:30", "Every weekday 09:00". */
export function describeRule(rule: ScheduleRule, lang: 'zh' | 'en' = 'zh'): string {
  const time = `${pad(rule.hour)}:${pad(rule.minute)}`;
  const workdays = rule.weekdays?.join(',') === '1,2,3,4,5';
  const day = rule.monthDay === -1 ? (lang === 'zh' ? '最后一天' : 'last day') : lang === 'zh' ? `${rule.monthDay} 日` : `day ${rule.monthDay}`;
  if (lang === 'zh') {
    switch (rule.freq) {
      case 'daily': return `${workdays ? '每个工作日' : rule.weekdays ? '每周' + rule.weekdays.map((d) => WEEKDAYS_ZH[d]).join('、') : '每天'} ${time}`;
      case 'weekly': return `${workdays ? '每个工作日' : '每周' + rule.weekdays!.map((d) => WEEKDAYS_ZH[d]).join('、')} ${time}`;
      case 'monthly': return `每月${day} ${time}`;
      case 'yearly': return `每年 ${rule.month} 月${day} ${time}`;
    }
  }
  switch (rule.freq) {
    case 'daily': return `${workdays ? 'Every weekday' : rule.weekdays ? 'Every ' + rule.weekdays.map((d) => WEEKDAYS_EN[d]).join(', ') : 'Every day'} ${time}`;
    case 'weekly': return `${workdays ? 'Every weekday' : 'Every ' + rule.weekdays!.map((d) => WEEKDAYS_EN[d]).join(', ')} ${time}`;
    case 'monthly': return `Monthly, ${day}, ${time}`;
    case 'yearly': return `Yearly, ${rule.month}/${rule.monthDay === -1 ? 'last' : rule.monthDay}, ${time}`;
  }
}
