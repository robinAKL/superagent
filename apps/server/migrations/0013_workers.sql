-- Worker presence (T-01 / room T-03). One row per registered worker: a hosted replica, a SuperAgent Link
-- device, or a webhook endpoint. Identity is permanent; presence is derived from last_heartbeat_at at read
-- time, so nothing has to sweep rows to mark them offline. Only a SHA-256 of the worker token is stored.

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hosted', 'link', 'webhook')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_hash text NOT NULL,
  last_heartbeat_at timestamptz,
  busy boolean NOT NULL DEFAULT false,
  waiting_auth_reason text,
  revoked_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workers_token_hash ON workers (token_hash);
CREATE INDEX IF NOT EXISTS workers_tenant ON workers (tenant_id);

-- Instructions addressed to one worker (wake / cancel / message). seq is the poll cursor, per worker: a
-- reconnecting worker asks for everything after the last seq it saw. seq is max+1 under the primary key, so two
-- concurrent appends cannot both take the same number and a row can never commit "behind" a cursor already read
-- (a global bigserial could: a lower value may commit after a higher one was delivered). Append-only for the app.
CREATE TABLE IF NOT EXISTS worker_events (
  worker_id uuid NOT NULL REFERENCES workers (id),
  seq bigint NOT NULL,
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wake', 'cancel', 'message')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, seq)
);

GRANT SELECT, INSERT, UPDATE ON workers TO superagent_app;
GRANT SELECT, INSERT ON worker_events TO superagent_app;
