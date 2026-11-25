-- Mail and calendar accounts (phase 1). Each account belongs to exactly one owner: an administrator (the account
-- controls Super Agent) or one digital employee (the account is that employee's own). Tokens live in Key Vault;
-- grant_ref names the secret version only.
CREATE TABLE IF NOT EXISTS account_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('admin', 'employee')),
  owner_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('microsoft')),
  address text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  scopes text NOT NULL DEFAULT '',
  mail_trigger boolean NOT NULL DEFAULT false,
  calendar_trigger boolean NOT NULL DEFAULT false,
  send_rule text NOT NULL DEFAULT 'ask' CHECK (send_rule IN ('ask', 'allow', 'deny')),
  status text NOT NULL CHECK (status IN ('connected', 'reauthorize')),
  grant_ref jsonb,
  grant_deadline timestamptz,
  connected_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One row per mailbox per owner: connecting the same mailbox again replaces its grant.
CREATE UNIQUE INDEX IF NOT EXISTS account_connections_owner_address
  ON account_connections (tenant_id, owner_kind, owner_id, provider, lower(address));

-- A sign-in in progress: the PKCE verifier is in Key Vault; the row only lives for ten minutes.
CREATE TABLE IF NOT EXISTS account_oauth_attempts (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('admin', 'employee')),
  owner_id text NOT NULL,
  verifier_ref jsonb NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON account_connections TO superagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_oauth_attempts TO superagent_app;
