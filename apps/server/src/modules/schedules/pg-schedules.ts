import type { Schedule, ScheduleRun, ScheduleStore } from './schedules.js';

export interface SchedulesDb {
  query<T>(text: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface RunRow { id: string; tenant_id: string; schedule_id: string; stamp: string; at: Date | string; status: ScheduleRun['status']; task_id: string | null; note: string }
const run = (r: RunRow): ScheduleRun => ({ id: r.id, tenantId: r.tenant_id, scheduleId: r.schedule_id, stamp: r.stamp, at: new Date(r.at).toISOString(), status: r.status, taskId: r.task_id, note: r.note });

export class PgScheduleStore implements ScheduleStore {
  constructor(private readonly db: SchedulesDb) {}
  async list(tenantId: string) {
    const { rows } = await this.db.query<{ doc: Schedule }>('SELECT doc FROM workflow_schedules WHERE tenant_id = $1::uuid ORDER BY updated_at', [tenantId]);
    return rows.map((row) => row.doc);
  }
  async active() {
    const { rows } = await this.db.query<{ doc: Schedule }>("SELECT doc FROM workflow_schedules WHERE status = 'active'", []);
    return rows.map((row) => row.doc);
  }
  async save(s: Schedule) {
    await this.db.query(
      `INSERT INTO workflow_schedules (id, tenant_id, workflow_key, doc, status, updated_at) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO UPDATE SET workflow_key = EXCLUDED.workflow_key, doc = EXCLUDED.doc, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [s.id, s.tenantId, s.workflowKey, JSON.stringify(s), s.status, s.updatedAt],
    );
  }
  async remove(tenantId: string, id: string) {
    await this.db.query('DELETE FROM workflow_schedules WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, id]);
  }
  async claimRun(r: ScheduleRun) {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO workflow_schedule_runs (id, tenant_id, schedule_id, stamp, at, status, task_id, note) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)
       ON CONFLICT (schedule_id, stamp) DO NOTHING RETURNING id`,
      [r.id, r.tenantId, r.scheduleId, r.stamp, r.at, r.status, r.taskId, r.note],
    );
    return rows.length === 1;
  }
  async finishRun(r: ScheduleRun) {
    await this.db.query('UPDATE workflow_schedule_runs SET status = $3, task_id = $4, note = $5 WHERE schedule_id = $1::uuid AND stamp = $2', [r.scheduleId, r.stamp, r.status, r.taskId, r.note]);
  }
  async runs(tenantId: string, from: string, to: string) {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM workflow_schedule_runs WHERE tenant_id = $1::uuid AND at >= $2 AND at < $3', [tenantId, from, to]);
    return rows.map(run);
  }
}
