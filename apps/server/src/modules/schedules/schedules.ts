import { randomUUID } from 'node:crypto';
import { describeRule, nextOccurrences, occurrences, parseRule, type Occurrence, type ScheduleRule } from './rule.js';

/**
 * The workflow calendar. A schedule says when a workflow runs and which digital employee carries it out.
 * Analysis proposes schedules (status "suggested") from what the company's own documents say; nothing runs until an
 * owner or admin turns one on, and a schedule cannot be turned on without an employee.
 */
export type ScheduleStatus = 'suggested' | 'active' | 'paused' | 'dismissed';
export interface ScheduleEvidence { title: string; locator: string; quote: string }

export interface Schedule {
  id: string;
  tenantId: string;
  /** The workflow (its analysis draft key, or "manual:<id>"). One schedule per workflow. */
  workflowKey: string;
  title: string;
  description: string;
  /** What the employee is asked to do each time (the workflow's steps). */
  work: string;
  rule: ScheduleRule;
  status: ScheduleStatus;
  origin: 'analysis' | 'manual';
  /** The digital employee who carries it out; null until someone is assigned. */
  employeeId: string | null;
  /** Other employees with a step in the workflow. */
  participants: string[];
  evidence: ScheduleEvidence | null;
  /** Local stamps of single runs someone skipped. */
  skips: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export type RunStatus = 'started' | 'skipped' | 'no_employee';
export interface ScheduleRun {
  id: string;
  tenantId: string;
  scheduleId: string;
  stamp: string;
  at: string;
  status: RunStatus;
  taskId: string | null;
  note: string;
}

/** What analysis found: a workflow its sources say runs on a cadence, and who does it. */
export interface SuggestedSchedule {
  workflowKey: string;
  title: string;
  description: string;
  work: string;
  rule: ScheduleRule;
  employeeId: string | null;
  participants: string[];
  evidence: ScheduleEvidence | null;
}

export interface ScheduleStore {
  list(tenantId: string): Promise<Schedule[]>;
  /** Every active schedule of every tenant: what the timer looks at. */
  active(): Promise<Schedule[]>;
  save(schedule: Schedule): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
  /** Records a run; false when this schedule already has a run for this stamp (another process took it). */
  claimRun(run: ScheduleRun): Promise<boolean>;
  finishRun(run: ScheduleRun): Promise<void>;
  runs(tenantId: string, from: string, to: string): Promise<ScheduleRun[]>;
}

export class MemoryScheduleStore implements ScheduleStore {
  private rows = new Map<string, Schedule>();
  private runRows = new Map<string, ScheduleRun>();
  async list(tenantId: string) { return [...this.rows.values()].filter((row) => row.tenantId === tenantId).map((row) => structuredClone(row)); }
  async active() { return [...this.rows.values()].filter((row) => row.status === 'active').map((row) => structuredClone(row)); }
  async save(schedule: Schedule) { this.rows.set(schedule.id, structuredClone(schedule)); }
  async remove(tenantId: string, id: string) { if (this.rows.get(id)?.tenantId === tenantId) this.rows.delete(id); }
  async claimRun(run: ScheduleRun) {
    const key = run.scheduleId + '|' + run.stamp;
    if (this.runRows.has(key)) return false;
    this.runRows.set(key, { ...run });
    return true;
  }
  async finishRun(run: ScheduleRun) { this.runRows.set(run.scheduleId + '|' + run.stamp, { ...run }); }
  async runs(tenantId: string, from: string, to: string) {
    return [...this.runRows.values()].filter((run) => run.tenantId === tenantId && run.at >= from && run.at < to);
  }
}

export interface Viewer { tenantId: string; userId: string; roles: readonly string[] }
export interface EmployeeInfo { id: string; name: string; ownerUserId: string | null; status: string }

export class ScheduleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

/** A run is started late only within this window (a restart, a slow tick); older ones are not run at all. */
export const CATCH_UP_MS = 30 * 60_000;

export const isManager = (viewer: Viewer) => viewer.roles.includes('owner') || viewer.roles.includes('admin');

export class ScheduleService {
  constructor(private readonly store: ScheduleStore, private readonly now: () => number = Date.now) {}

  listFor(tenantId: string) { return this.store.list(tenantId); }

  /** Brings analysis suggestions in. Suggestions follow the latest analysis; schedules someone acted on are kept. */
  async sync(tenantId: string, suggestions: SuggestedSchedule[]): Promise<void> {
    const rows = await this.store.list(tenantId);
    const at = new Date(this.now()).toISOString();
    const keys = new Set(suggestions.map((item) => item.workflowKey));
    for (const item of suggestions) {
      const existing = rows.find((row) => row.workflowKey === item.workflowKey);
      if (existing && existing.status !== 'suggested') continue;
      const next: Schedule = existing
        ? { ...existing, title: item.title, description: item.description, work: item.work, rule: item.rule, employeeId: existing.updatedBy !== 'analysis' ? existing.employeeId ?? item.employeeId : item.employeeId, participants: item.participants, evidence: item.evidence }
        : {
          id: randomUUID(), tenantId, workflowKey: item.workflowKey, title: item.title, description: item.description, work: item.work, rule: item.rule,
          status: 'suggested', origin: 'analysis', employeeId: item.employeeId, participants: item.participants, evidence: item.evidence,
          skips: [], createdAt: at, updatedAt: at, updatedBy: 'analysis',
        };
      if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) await this.store.save(next);
    }
    // A suggestion the latest analysis no longer makes goes away; nobody had acted on it.
    for (const row of rows) if (row.origin === 'analysis' && row.status === 'suggested' && !keys.has(row.workflowKey)) await this.store.remove(tenantId, row.id);
  }

  /**
   * The calendar a person sees: owners and admins see every schedule; anyone else only those carried out by employees
   * they are responsible for (never suggestions, which are for managers to decide).
   */
  async calendar(viewer: Viewer, employees: EmployeeInfo[], from: number, to: number) {
    const rows = (await this.store.list(viewer.tenantId)).filter((row) => row.status !== 'dismissed' && this.visible(viewer, employees, row));
    const runs = await this.store.runs(viewer.tenantId, new Date(from).toISOString(), new Date(to).toISOString());
    const now = this.now();
    return rows.map((row) => {
      const employee = employees.find((item) => item.id === row.employeeId) ?? null;
      // Times before the schedule existed are not part of it (they were never missed).
      const since = Date.parse(row.createdAt);
      const planned = occurrences(row.rule, from, to, 400).flatMap((occurrence) => {
        const run = runs.find((item) => item.scheduleId === row.id && item.stamp === occurrence.stamp);
        if (!run && occurrence.at < since) return [];
        return [{ stamp: occurrence.stamp, at: new Date(occurrence.at).toISOString(), state: this.occurrenceState(row, occurrence, run, now), taskId: run?.taskId ?? null, note: run?.note ?? '' }];
      });
      return {
        ...this.view(row, employees),
        next: row.status === 'active' ? nextOccurrences(row.rule, now, 5).filter((item) => !row.skips.includes(item.stamp)).map((item) => new Date(item.at).toISOString()) : [],
        occurrences: planned,
        employeeOnline: employee ? !['paused', 'offline', 'unconnected'].includes(employee.status) : false,
      };
    });
  }

  view(row: Schedule, employees: EmployeeInfo[]) {
    const name = (id: string | null) => employees.find((item) => item.id === id)?.name ?? null;
    return {
      id: row.id, workflowKey: row.workflowKey, title: row.title, description: row.description, rule: row.rule,
      ruleText: describeRule(row.rule, 'zh'), ruleTextEn: describeRule(row.rule, 'en'), status: row.status, origin: row.origin,
      employeeId: row.employeeId, employeeName: name(row.employeeId),
      participants: row.participants.map((id) => ({ id, name: name(id) })).filter((item) => item.name),
      evidence: row.evidence, skips: row.skips,
    };
  }

  /** Changes a schedule. Managers may change anything; the employee's responsible person may skip or run once. */
  async act(viewer: Viewer, employees: EmployeeInfo[], id: string, action: string, input: Record<string, unknown>): Promise<Schedule> {
    const row = (await this.store.list(viewer.tenantId)).find((item) => item.id === id);
    if (!row || row.status === 'dismissed' || !this.visible(viewer, employees, row)) throw new ScheduleError('not_found', '找不到这个日程。', 404);
    const manager = isManager(viewer);
    if (!manager && !['skip', 'unskip'].includes(action)) throw new ScheduleError('forbidden', '只有管理员可以修改日程。', 403);
    const next: Schedule = { ...row, updatedAt: new Date(this.now()).toISOString(), updatedBy: viewer.userId };
    switch (action) {
      case 'enable': {
        const employeeId = input.employeeId === undefined ? row.employeeId : input.employeeId;
        if (typeof employeeId !== 'string' || !employees.some((item) => item.id === employeeId)) throw new ScheduleError('needs_employee', '请先选择由哪位数字员工来做。');
        next.employeeId = employeeId;
        next.status = 'active';
        break;
      }
      case 'pause': next.status = 'paused'; break;
      case 'dismiss':
        if (row.origin === 'manual') { await this.store.remove(viewer.tenantId, row.id); return { ...row, status: 'dismissed' }; }
        next.status = 'dismissed';
        break;
      case 'update': {
        if (input.rule !== undefined) {
          const rule = parseRule(input.rule, row.rule.timezone);
          if (!rule) throw new ScheduleError('invalid_rule', '时间规则无效。');
          next.rule = rule;
          next.skips = [];
        }
        if (input.employeeId !== undefined) {
          if (input.employeeId === null && row.status === 'active') throw new ScheduleError('needs_employee', '启用中的日程必须有数字员工。');
          if (input.employeeId !== null && (typeof input.employeeId !== 'string' || !employees.some((item) => item.id === input.employeeId))) throw new ScheduleError('needs_employee', '请选择一位数字员工。');
          next.employeeId = input.employeeId as string | null;
        }
        break;
      }
      case 'skip':
      case 'unskip': {
        const stamp = input.stamp;
        if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stamp)) throw new ScheduleError('invalid_input', '请选择要跳过的那一次。');
        next.skips = action === 'skip' ? [...new Set([...row.skips, stamp])].slice(-100) : row.skips.filter((item) => item !== stamp);
        break;
      }
      default: throw new ScheduleError('invalid_input', '不支持这个操作。');
    }
    await this.store.save(next);
    return next;
  }

  /** A schedule an admin adds by hand for a workflow and an employee. */
  async create(viewer: Viewer, employees: EmployeeInfo[], input: Record<string, unknown>): Promise<Schedule> {
    if (!isManager(viewer)) throw new ScheduleError('forbidden', '只有管理员可以新建日程。', 403);
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
    const work = typeof input.work === 'string' ? input.work.trim().slice(0, 4000) : '';
    const rule = parseRule(input.rule);
    if (!title || !rule) throw new ScheduleError('invalid_input', '请填写流程名称和时间。');
    if (typeof input.employeeId !== 'string' || !employees.some((item) => item.id === input.employeeId)) throw new ScheduleError('needs_employee', '请选择由哪位数字员工来做。');
    const at = new Date(this.now()).toISOString();
    const id = randomUUID();
    const row: Schedule = {
      id, tenantId: viewer.tenantId, workflowKey: typeof input.workflowKey === 'string' && input.workflowKey ? input.workflowKey.slice(0, 160) : 'manual:' + id,
      title, description: '', work: work || title, rule, status: 'active', origin: 'manual', employeeId: input.employeeId,
      participants: [], evidence: null, skips: [], createdAt: at, updatedAt: at, updatedBy: viewer.userId,
    };
    await this.store.save(row);
    return row;
  }

  /**
   * One timer pass: every active schedule's runs that fell due since the catch-up window opened, each claimed once
   * (across processes) and handed to start(). A skipped run is recorded as skipped and not started.
   */
  async due(start: (schedule: Schedule, occurrence: Occurrence) => Promise<{ taskId: string | null; note: string; status?: RunStatus }>): Promise<ScheduleRun[]> {
    const now = this.now();
    const done: ScheduleRun[] = [];
    for (const row of await this.store.active()) {
      for (const occurrence of occurrences(row.rule, now - CATCH_UP_MS, now + 1)) {
        const run: ScheduleRun = { id: randomUUID(), tenantId: row.tenantId, scheduleId: row.id, stamp: occurrence.stamp, at: new Date(occurrence.at).toISOString(), status: 'started', taskId: null, note: '' };
        if (row.skips.includes(occurrence.stamp)) run.status = 'skipped';
        if (!(await this.store.claimRun(run))) continue;
        if (run.status === 'started') {
          try {
            const result = await start(row, occurrence);
            Object.assign(run, { taskId: result.taskId, note: result.note, status: result.status ?? 'started' });
          } catch (error) {
            run.note = error instanceof Error ? error.message.slice(0, 300) : String(error);
            run.status = 'no_employee';
          }
          await this.store.finishRun(run);
        }
        done.push(run);
      }
    }
    return done;
  }

  private visible(viewer: Viewer, employees: EmployeeInfo[], row: Schedule) {
    if (isManager(viewer)) return true;
    if (row.status === 'suggested') return false;
    return employees.some((item) => item.id === row.employeeId && item.ownerUserId === viewer.userId);
  }

  private occurrenceState(row: Schedule, occurrence: Occurrence, run: ScheduleRun | undefined, now: number) {
    if (run) return run.status === 'started' ? 'ran' : run.status === 'skipped' ? 'skipped' : 'failed';
    if (row.skips.includes(occurrence.stamp)) return 'skipped';
    if (row.status === 'suggested') return 'suggested';
    if (row.status === 'paused') return 'paused';
    return occurrence.at <= now ? 'missed' : 'planned';
  }
}
