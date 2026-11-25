-- A new worker instruction: open the local clients window on the computer at one step (install, sign in, connect).
ALTER TABLE worker_events DROP CONSTRAINT IF EXISTS worker_events_kind_check;
ALTER TABLE worker_events ADD CONSTRAINT worker_events_kind_check CHECK (kind IN ('wake', 'cancel', 'message', 'mcp_login', 'client_setup'));
