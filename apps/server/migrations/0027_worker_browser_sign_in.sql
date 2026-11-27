-- A new worker instruction: open the employees' browser visibly on the computer so the person signs in to a website.
ALTER TABLE worker_events DROP CONSTRAINT IF EXISTS worker_events_kind_check;
ALTER TABLE worker_events ADD CONSTRAINT worker_events_kind_check CHECK (kind IN ('wake', 'cancel', 'message', 'mcp_login', 'client_setup', 'browser_sign_in'));
