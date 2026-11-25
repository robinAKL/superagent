-- A new worker instruction: open an MCP server's sign-in on the computer, for the person there to complete.
ALTER TABLE worker_events DROP CONSTRAINT IF EXISTS worker_events_kind_check;
ALTER TABLE worker_events ADD CONSTRAINT worker_events_kind_check CHECK (kind IN ('wake', 'cancel', 'message', 'mcp_login'));
