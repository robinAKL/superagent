CREATE TABLE IF NOT EXISTS sop_company_context (
  tenant_id text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  goal text NOT NULL,
  boundaries text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON sop_company_context TO superagent_app;
