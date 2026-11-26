-- SaaS step 1: every command-room and workflow row is keyed by its company, so two companies' rows can never meet.
-- Rows written before this migration (single-company deployments) belong to the platform company.

-- Command room: ids and message dedup are per company; room members gain their company.
ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_pkey;
ALTER TABLE room_messages ADD PRIMARY KEY (tenant_id, id);
DROP INDEX IF EXISTS room_messages_dedup;
CREATE UNIQUE INDEX room_messages_dedup ON room_messages (tenant_id, room_id, client_message_id);

ALTER TABLE room_tasks DROP CONSTRAINT IF EXISTS room_tasks_pkey;
ALTER TABLE room_tasks ADD PRIMARY KEY (tenant_id, id);

ALTER TABLE room_members ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE room_members SET tenant_id = current_setting('app.platform_tenant') WHERE tenant_id IS NULL;
ALTER TABLE room_members ALTER COLUMN tenant_id SET NOT NULL;
DROP INDEX IF EXISTS room_members_pk;
CREATE UNIQUE INDEX room_members_pk ON room_members (tenant_id, room_id, user_id);

-- Workflows: versions gain their company; ids, version numbers and the sequence are per company.
ALTER TABLE sop_versions ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE sop_versions v SET tenant_id = coalesce(
  (SELECT i.tenant_id FROM sop_instances i WHERE i.sop_version_id = v.id LIMIT 1),
  current_setting('app.platform_tenant')
) WHERE tenant_id IS NULL;
ALTER TABLE sop_versions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sop_versions DROP CONSTRAINT IF EXISTS sop_versions_pkey;
ALTER TABLE sop_versions DROP CONSTRAINT IF EXISTS sop_versions_sop_id_number_key;
ALTER TABLE sop_versions ADD PRIMARY KEY (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sop_versions_number ON sop_versions (tenant_id, sop_id, number);

ALTER TABLE sop_instances DROP CONSTRAINT IF EXISTS sop_instances_pkey;
ALTER TABLE sop_instances ADD PRIMARY KEY (tenant_id, id);

ALTER TABLE sop_runtime_seq ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE sop_runtime_seq SET tenant_id = current_setting('app.platform_tenant') WHERE tenant_id IS NULL;
ALTER TABLE sop_runtime_seq DROP CONSTRAINT IF EXISTS sop_runtime_seq_pkey;
ALTER TABLE sop_runtime_seq DROP CONSTRAINT IF EXISTS sop_runtime_seq_id_check;
ALTER TABLE sop_runtime_seq DROP COLUMN IF EXISTS id;
ALTER TABLE sop_runtime_seq ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sop_runtime_seq ADD PRIMARY KEY (tenant_id);
