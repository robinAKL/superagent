/** Durable SOP rows. event_key is tenant|source|eventId|sopId and matches sopEventKey. */

export const UPSERT_VERSION_SQL = `
INSERT INTO sop_versions (
  id, sop_id, number, definition, status, report, revision, validated_revision, effective_at, tenant_id
) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)
ON CONFLICT (tenant_id, id) DO UPDATE SET
  definition = EXCLUDED.definition,
  status = EXCLUDED.status,
  report = EXCLUDED.report,
  revision = EXCLUDED.revision,
  validated_revision = EXCLUDED.validated_revision,
  effective_at = EXCLUDED.effective_at
`.trim();

export const UPSERT_INSTANCE_SQL = `
INSERT INTO sop_instances (
  id, tenant_id, sop_id, sop_version_id, version_number, event_key, status
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, id) DO UPDATE SET status = EXCLUDED.status
`.trim();

export const UPSERT_EVENT_SQL = `
INSERT INTO sop_events (tenant_id, source, event_id, sop_id, event_key, disposition)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, source, event_id, sop_id) DO UPDATE SET disposition = EXCLUDED.disposition
`.trim();

export const UPSERT_SEQ_SQL = `
INSERT INTO sop_runtime_seq (tenant_id, seq) VALUES ($2, $1)
ON CONFLICT (tenant_id) DO UPDATE SET seq = EXCLUDED.seq
`.trim();

export const LOAD_VERSIONS_SQL = `
SELECT id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
FROM sop_versions
WHERE tenant_id = $1
ORDER BY number
`.trim();

export const LOAD_INSTANCES_SQL = `
SELECT id, tenant_id, sop_id, sop_version_id, version_number, event_key, status
FROM sop_instances
WHERE tenant_id = $1
`.trim();

export const LOAD_EVENTS_SQL = `
SELECT event_key, disposition FROM sop_events WHERE tenant_id = $1
`.trim();

export const LOAD_SEQ_SQL = `SELECT seq FROM sop_runtime_seq WHERE tenant_id = $1`.trim();

/** Every company with saved workflow rows. */
export const LOAD_SOP_TENANTS_SQL = `
SELECT tenant_id FROM sop_versions UNION SELECT tenant_id FROM sop_instances UNION SELECT tenant_id FROM sop_events UNION SELECT tenant_id FROM sop_runtime_seq
`.trim();

/** Inserts the dedup row. A conflict means another process already claimed this event. */
export const CLAIM_EVENT_SQL = `
INSERT INTO sop_events (tenant_id, source, event_id, sop_id, event_key, disposition)
VALUES ($1, $2, $3, $4, $5, 'open')
ON CONFLICT (tenant_id, source, event_id, sop_id) DO NOTHING
RETURNING event_key
`.trim();

export const LOAD_PUBLISHED_SQL = `
SELECT id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
FROM sop_versions
WHERE tenant_id = $2 AND sop_id = $1 AND status = 'published'
ORDER BY number DESC
LIMIT 1
`.trim();
