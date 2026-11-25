-- The workflow calendar: when each workflow runs and which digital employee carries it out. Analysis proposes
-- schedules (status 'suggested'); an owner or admin turns them on. One schedule per workflow per tenant.
CREATE TABLE IF NOT EXISTS workflow_schedules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_key text NOT NULL,
  doc jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('suggested', 'active', 'paused', 'dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_schedules_workflow ON workflow_schedules (tenant_id, workflow_key);
CREATE INDEX IF NOT EXISTS workflow_schedules_active ON workflow_schedules (status) WHERE status = 'active';

-- One row per run: the unique key is how two web processes never start the same run twice.
CREATE TABLE IF NOT EXISTS workflow_schedule_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  stamp text NOT NULL,
  at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'skipped', 'no_employee')),
  task_id text,
  note text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_schedule_runs_once ON workflow_schedule_runs (schedule_id, stamp);
CREATE INDEX IF NOT EXISTS workflow_schedule_runs_tenant ON workflow_schedule_runs (tenant_id, at);

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_schedules TO superagent_app;
GRANT SELECT, INSERT, UPDATE ON workflow_schedule_runs TO superagent_app;
