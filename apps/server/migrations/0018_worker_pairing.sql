-- Device-code pairing for SuperAgent Link (T-30). The plaintext worker token lives on the
-- session row only until the Link client polls it once; then issued_token is cleared.
CREATE TABLE IF NOT EXISTS worker_pair_sessions (
  device_code text PRIMARY KEY,
  user_code text NOT NULL,
  hostname text NOT NULL,
  agents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'allowed', 'denied')),
  tenant_id uuid,
  worker_id uuid,
  issued_token text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_pair_sessions_user_code ON worker_pair_sessions (user_code);

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_pair_sessions TO superagent_app;
