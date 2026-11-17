import type { Queryable } from './pg-sop.js';

export interface CompanyContext {
  version: number;
  name: string;
  goal: string;
  boundaries: string;
  updatedBy: string;
  updatedAt: string;
}

type ContextFields = Pick<CompanyContext, 'name' | 'goal' | 'boundaries'>;
const columns = 'version, name, goal, boundaries, updated_by AS "updatedBy", updated_at AS "updatedAt"';

export function contextInput(input: unknown): (ContextFields & { expectedVersion: number }) | null {
  if (!input || typeof input !== 'object') return null;
  const { name, goal, boundaries, expectedVersion } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || name.length > 160 ||
      typeof goal !== 'string' || !goal.trim() || goal.length > 4000 ||
      typeof boundaries !== 'string' || boundaries.length > 4000 ||
      typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  return { name: name.trim(), goal: goal.trim(), boundaries: boundaries.trim(), expectedVersion };
}

export class CompanyContextStore {
  private readonly memory = new Map<string, CompanyContext>();
  constructor(private readonly db: Queryable | null) {}

  async read(tenantId: string): Promise<CompanyContext | null> {
    if (!this.db) return this.memory.get(tenantId) ?? null;
    const { rows } = await this.db.query<CompanyContext>(
      `SELECT ${columns} FROM sop_company_context WHERE tenant_id = $1`, [tenantId],
    );
    return rows[0] ?? null;
  }

  async save(tenantId: string, userId: string, fields: ContextFields, expectedVersion: number): Promise<CompanyContext | null> {
    if (!this.db) {
      if ((this.memory.get(tenantId)?.version ?? 0) !== expectedVersion) return null;
      const next = { ...fields, version: expectedVersion + 1, updatedBy: userId, updatedAt: new Date().toISOString() };
      this.memory.set(tenantId, next);
      return next;
    }
    const args = [tenantId, fields.name, fields.goal, fields.boundaries, userId];
    const { rows } = expectedVersion === 0
      ? await this.db.query<CompanyContext>(`
        INSERT INTO sop_company_context (tenant_id, version, name, goal, boundaries, updated_by)
        VALUES ($1, 1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING ${columns}`, args)
      : await this.db.query<CompanyContext>(`
        UPDATE sop_company_context SET version = version + 1, name = $2, goal = $3,
          boundaries = $4, updated_by = $5, updated_at = now()
        WHERE tenant_id = $1 AND version = $6 RETURNING ${columns}`, [...args, expectedVersion]);
    return rows[0] ?? null;
  }
}
