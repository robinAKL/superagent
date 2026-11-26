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
UPDATE room_members SET tenant_id = coalesce(nullif(current_setting('app.platform_tenant', true), ''), 'default') WHERE tenant_id IS NULL;
ALTER TABLE room_members ALTER COLUMN tenant_id SET NOT NULL;
DROP INDEX IF EXISTS room_members_pk;
CREATE UNIQUE INDEX room_members_pk ON room_members (tenant_id, room_id, user_id);
