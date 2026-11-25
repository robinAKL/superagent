-- Mail automation: where each mailbox has read up to, and the replies digital employees drafted.
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS mail_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A reply an employee drafted from a task that came in by mail. Sent at once ("send directly"), or held here until a
-- person sends, edits or drops it ("ask me first").
CREATE TABLE IF NOT EXISTS mail_drafts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'discarded', 'failed')),
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_drafts_tenant ON mail_drafts (tenant_id, status, created_at DESC);
-- One draft per task.
CREATE UNIQUE INDEX IF NOT EXISTS mail_drafts_task ON mail_drafts (tenant_id, (doc->>'taskId'));

GRANT SELECT, INSERT, UPDATE ON mail_drafts TO superagent_app;
