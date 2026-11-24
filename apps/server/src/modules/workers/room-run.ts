/**
 * The id a computer sees for one run of a room task. The first run uses the task id itself; a re-send adds "~r<n>",
 * so a Link that remembers every task id it has run (v0.1.4 and earlier) still takes the re-send as new work.
 * Whatever the computer reports under a run id belongs to the task.
 */
export function roomRunId(taskId: string, send: number): string {
  return send > 0 ? `${taskId}~r${send}` : taskId;
}

export function roomTaskOfRun(runId: string): string {
  return runId.replace(/~r\d+$/u, '');
}
