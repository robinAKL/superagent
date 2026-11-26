-- SaaS step 1b: the company directory. A company (tenant) is a customer organisation, not an email domain.
-- A Microsoft 365 company is recognised by its Entra directory id (the token's tid); people belong to a company
-- through a membership row in users, with roles kept here rather than in the identity provider.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS entra_tenant_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by text;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_entra_directory ON tenants (entra_tenant_id) WHERE entra_tenant_id IS NOT NULL;

-- The platform company of a single-company deployment keeps working: it is registered for its own directory.
INSERT INTO tenants (id, name, entra_tenant_id)
SELECT current_setting('app.platform_tenant')::uuid, 'INNOPRO', nullif(current_setting('app.platform_entra_tenant', true), '')
WHERE current_setting('app.platform_tenant') ~ '^[0-9a-fA-F-]{36}$'
ON CONFLICT (id) DO UPDATE SET entra_tenant_id = coalesce(tenants.entra_tenant_id, EXCLUDED.entra_tenant_id);

-- Memberships: one row per person per company.
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_tid text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS users_identity ON users (entra_oid);

-- Invitations by email address; accepted by a person signed in with that address.
CREATE TABLE IF NOT EXISTS tenant_invites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  email text NOT NULL,
  roles jsonb NOT NULL DEFAULT '["employee"]'::jsonb,
  invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  accepted_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invites_open ON tenant_invites (tenant_id, lower(email)) WHERE accepted_at IS NULL;

-- Colleagues from the same directory ask to join; an administrator approves (or auto-join, when the company allows it).
CREATE TABLE IF NOT EXISTS tenant_join_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  entra_tid text NOT NULL,
  entra_oid text NOT NULL,
  email text,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_join_requests_pending ON tenant_join_requests (tenant_id, entra_oid) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, tenant_invites, tenant_join_requests TO superagent_app;
