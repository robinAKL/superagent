-- SaaS step 1: every workflow row is keyed by its company. Rows written before this migration belong to the platform
-- company (the migration runner sets app.platform_tenant; a test applying this file alone gets 'default').

-- Workflows: versions gain their company; ids, version numbers and the sequence are per company.
ALTER TABLE sop_versions ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE sop_versions v SET tenant_id = coalesce(
  (SELECT i.tenant_id FROM sop_instances i WHERE i.sop_version_id = v.id LIMIT 1),
  coalesce(nullif(current_setting('app.platform_tenant', true), ''), 'default')
) WHERE tenant_id IS NULL;
ALTER TABLE sop_versions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sop_versions DROP CONSTRAINT IF EXISTS sop_versions_pkey;
ALTER TABLE sop_versions DROP CONSTRAINT IF EXISTS sop_versions_sop_id_number_key;
ALTER TABLE sop_versions ADD PRIMARY KEY (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sop_versions_number ON sop_versions (tenant_id, sop_id, number);

ALTER TABLE sop_instances DROP CONSTRAINT IF EXISTS sop_instances_pkey;
ALTER TABLE sop_instances ADD PRIMARY KEY (tenant_id, id);

ALTER TABLE sop_runtime_seq ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE sop_runtime_seq SET tenant_id = coalesce(nullif(current_setting('app.platform_tenant', true), ''), 'default') WHERE tenant_id IS NULL;
ALTER TABLE sop_runtime_seq DROP CONSTRAINT IF EXISTS sop_runtime_seq_pkey;
ALTER TABLE sop_runtime_seq DROP CONSTRAINT IF EXISTS sop_runtime_seq_id_check;
ALTER TABLE sop_runtime_seq DROP COLUMN IF EXISTS id;
ALTER TABLE sop_runtime_seq ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sop_runtime_seq ADD PRIMARY KEY (tenant_id);
