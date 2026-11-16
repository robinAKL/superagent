-- Instant wake for held worker polls (room task T-07). NOTIFY is delivered only when the inserting transaction
-- commits, so a woken poll always finds the committed row. Notifications are a hint: polls still rescan on a timer.

-- Queue work becomes claimable: payload is the tenant id (polls wait on their tenant).
CREATE OR REPLACE FUNCTION superagent_notify_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'assigned' AND NEW.lease_owner IS NULL AND NEW.dead_letter = false THEN
    PERFORM pg_notify('superagent_work', NEW.tenant_id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tasks_notify_work ON tasks;
CREATE TRIGGER tasks_notify_work
  AFTER INSERT OR UPDATE OF status, lease_owner, not_before ON tasks
  FOR EACH ROW EXECUTE FUNCTION superagent_notify_work();

-- An event addressed to one worker: payload is the worker id.
CREATE OR REPLACE FUNCTION superagent_notify_worker_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('superagent_worker_event', NEW.worker_id::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS worker_events_notify ON worker_events;
CREATE TRIGGER worker_events_notify
  AFTER INSERT ON worker_events
  FOR EACH ROW EXECUTE FUNCTION superagent_notify_worker_event();
