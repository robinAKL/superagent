import { sopEventKey, type SopSnapshot, type SopVersion, type WorkflowInstance } from './sop.js';
import {
  CLAIM_EVENT_SQL,
  LOAD_EVENTS_SQL,
  LOAD_INSTANCES_SQL,
  LOAD_PUBLISHED_SQL,
  LOAD_SEQ_SQL,
  LOAD_SOP_TENANTS_SQL,
  LOAD_VERSIONS_SQL,
  UPSERT_EVENT_SQL,
  UPSERT_INSTANCE_SQL,
  UPSERT_SEQ_SQL,
  UPSERT_VERSION_SQL,
} from './sql.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface VersionRow {
  id: string;
  sop_id: string;
  number: number;
  definition: SopVersion['definition'];
  status: SopVersion['status'];
  report: SopVersion['report'];
  revision: number;
  validated_revision: number | null;
  effective_at: string | null;
}

interface InstanceRow {
  id: string;
  tenant_id: string;
  sop_id: string;
  sop_version_id: string;
  version_number: number;
  event_key: string;
  status: WorkflowInstance['status'];
}

interface EventRow {
  event_key: string;
  disposition: string;
}

function fromVersionRow(row: VersionRow): SopVersion {
  return {
    id: row.id,
    sopId: row.sop_id,
    number: Number(row.number),
    definition: row.definition,
    status: row.status,
    report: row.report,
    revision: Number(row.revision),
    validatedRevision: row.validated_revision === null ? null : Number(row.validated_revision),
    effectiveAt: row.effective_at,
  };
}

function fromInstanceRow(row: InstanceRow): WorkflowInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sopId: row.sop_id,
    sopVersionId: row.sop_version_id,
    versionNumber: Number(row.version_number),
    eventKey: row.event_key,
    status: row.status,
  };
}

/** The key is tenant|source|eventId|sopId. A sop id may contain the separator; the first three parts may not. */
export function parseSopEventKey(key: string): { tenantId: string; source: string; eventId: string; sopId: string } {
  const parts = key.split('|');
  if (parts.length < 4 || parts.slice(0, 3).some((part) => part.length === 0)) throw new Error('bad_event_key');
  return { tenantId: parts[0]!, source: parts[1]!, eventId: parts[2]!, sopId: parts.slice(3).join('|') };
}

export async function saveSopSnapshot(db: Queryable, snapshot: SopSnapshot, tenantId: string): Promise<void> {
  await db.query(UPSERT_SEQ_SQL, [snapshot.seq, tenantId]);
  for (const version of snapshot.versions) {
    await db.query(UPSERT_VERSION_SQL, [
      version.id,
      version.sopId,
      version.number,
      JSON.stringify(version.definition),
      version.status,
      version.report ? JSON.stringify(version.report) : null,
      version.revision,
      version.validatedRevision,
      version.effectiveAt,
      tenantId,
    ]);
  }
  for (const instance of snapshot.instances) {
    // Command room instances have their own durable lifecycle; a cached snapshot can be older.
    if (instance.id.startsWith('cmd_')) continue;
    await db.query(UPSERT_INSTANCE_SQL, [
      instance.id,
      instance.tenantId,
      instance.sopId,
      instance.sopVersionId,
      instance.versionNumber,
      instance.eventKey,
      instance.status,
    ]);
  }
  const missed = new Set(snapshot.missed);
  const skipped = new Set(snapshot.skipped);
  for (const key of snapshot.eventKeys) {
    const parts = parseSopEventKey(key);
    if (parts.source === 'command') continue;
    const disposition = missed.has(key) ? 'missed' : skipped.has(key) ? 'skipped' : 'open';
    await db.query(UPSERT_EVENT_SQL, [parts.tenantId, parts.source, parts.eventId, parts.sopId, key, disposition]);
  }
}

/** Every company with saved workflow rows. */
export async function loadSopTenants(db: Queryable): Promise<string[]> {
  return (await db.query<{ tenant_id: string }>(LOAD_SOP_TENANTS_SQL, [])).rows.map((row) => row.tenant_id);
}

export async function loadSopSnapshot(db: Queryable, tenantId: string): Promise<SopSnapshot> {
  const versions = await db.query<VersionRow>(LOAD_VERSIONS_SQL, [tenantId]);
  const instances = await db.query<InstanceRow>(LOAD_INSTANCES_SQL, [tenantId]);
  const events = await db.query<EventRow>(LOAD_EVENTS_SQL, [tenantId]);
  const seq = await db.query<{ seq: number }>(LOAD_SEQ_SQL, [tenantId]);
  const missed: string[] = [];
  const skipped: string[] = [];
  for (const event of events.rows) {
    if (event.disposition === 'missed') missed.push(event.event_key);
    else if (event.disposition === 'skipped') skipped.push(event.event_key);
  }
  return {
    seq: Number(seq.rows[0]?.seq ?? 0),
    versions: versions.rows.map(fromVersionRow),
    instances: instances.rows.map(fromInstanceRow),
    eventKeys: events.rows.map((event) => event.event_key),
    missed,
    skipped,
  };
}

/** Latest published version of one SOP. Another process reads this instead of the web process memory. */
export async function loadPublishedVersion(db: Queryable, tenantId: string, sopId: string): Promise<SopVersion | null> {
  const result = await db.query<VersionRow>(LOAD_PUBLISHED_SQL, [sopId, tenantId]);
  const row = result.rows[0];
  return row ? fromVersionRow(row) : null;
}

/** The version id pinned on an instance. This is not the latest published version. */
export async function loadVersionById(db: Queryable, tenantId: string, id: string): Promise<SopVersion | null> {
  const result = await db.query<VersionRow>(
    `SELECT id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
     FROM sop_versions WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  const row = result.rows[0];
  return row ? fromVersionRow(row) : null;
}

/**
 * Claims tenant+source+event_id+sop_id. Returns false when the row already exists,
 * including when this process is not the one that published the SOP.
 */
export async function claimSopEvent(
  db: Queryable,
  input: { tenantId: string; source: string; eventId: string; sopId: string },
): Promise<boolean> {
  const key = sopEventKey(input.tenantId, input.source, input.eventId, input.sopId);
  const result = await db.query<{ event_key: string }>(CLAIM_EVENT_SQL, [
    input.tenantId,
    input.source,
    input.eventId,
    input.sopId,
    key,
  ]);
  return result.rows.length === 1;
}

/** Active versions from the shared store, independently of any process's editor cache. */
export async function loadActiveWorkflows(db: Queryable, tenantId: string, sopId?: string): Promise<SopVersion[]> {
  const result = await db.query<VersionRow>(`
    SELECT DISTINCT ON (sop_id) id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
    FROM sop_versions
    WHERE tenant_id = $2 AND status = 'published' AND ($1::text IS NULL OR sop_id = $1)
      AND (effective_at IS NULL OR effective_at::timestamptz <= now())
    ORDER BY sop_id, number DESC
  `, [sopId ?? null, tenantId]);
  return result.rows.map(fromVersionRow);
}

export async function countRunningSopInstances(db: Queryable, sopId: string, tenantId: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ sop_version_id: string; count: string | number }>(`
    SELECT sop_version_id, count(*) FROM sop_instances
    WHERE sop_id = $1 AND status = 'running' AND tenant_id = $2
    GROUP BY sop_version_id
  `, [sopId, tenantId]);
  return new Map(rows.map(row => [row.sop_version_id, Number(row.count)]));
}
