ALTER TABLE worker_events ADD COLUMN IF NOT EXISTS room_task_id text;
CREATE UNIQUE INDEX IF NOT EXISTS worker_events_room_dispatch
  ON worker_events (tenant_id, room_task_id);
