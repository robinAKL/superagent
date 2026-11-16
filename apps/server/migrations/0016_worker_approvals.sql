-- Agent permission prompts relayed to the command room (room task T-13). A Link files a request, a room owner
-- allows or denies it once, and the Link's held wait is woken by the NOTIFY below. A pending row past expires_at
-- reads as expired (denied); nothing sweeps it.
CREATE TABLE IF NOT EXISTS worker_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  worker_id uuid NOT NULL REFERENCES workers (id),
  room_task_id text,
  tool text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'allowed', 'denied')),
  reason text,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_approvals_tenant ON worker_approvals (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS worker_approvals_worker_pending ON worker_approvals (worker_id) WHERE status = 'pending';

-- A decision wakes the waiting Link on the same channel as its events (payload: worker id).
CREATE OR REPLACE FUNCTION superagent_notify_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    PERFORM pg_notify('superagent_worker_event', NEW.worker_id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS worker_approvals_notify ON worker_approvals;
CREATE TRIGGER worker_approvals_notify
  AFTER UPDATE OF status ON worker_approvals
  FOR EACH ROW EXECUTE FUNCTION superagent_notify_approval();

GRANT SELECT, INSERT, UPDATE ON worker_approvals TO superagent_app;
