import { OFFLINE_AFTER_MS } from './registry.js';

/**
 * Which digital employees have a bound Link computer that is online, from Link heartbeats (every ~15 s).
 * The employee registry never hears from Link, so without this a bound, connected employee reads "unconnected".
 * Process-local: the web role runs one replica (see infra/main.bicep).
 */
const lastSeen = new Map<string, number>();
let startedAt = Date.now();

export function markLinkPresence(employeeIds: Iterable<string>, at: number): void {
  for (const id of employeeIds) lastSeen.set(id, Math.max(at, lastSeen.get(id) ?? 0));
}

/** A computer bound to this employee sent a heartbeat within the offline window. */
export function linkOnline(employeeId: string, now: number): boolean {
  const at = lastSeen.get(employeeId);
  return at !== undefined && now - at <= OFFLINE_AFTER_MS;
}

/**
 * Right after a restart nothing has been seen yet. Until one offline window has passed, an employee that has not
 * been seen may still have a computer working on its task, so it is not treated as disconnected.
 */
export function linkMayBeOnline(employeeId: string, now: number): boolean {
  return linkOnline(employeeId, now) || (!lastSeen.has(employeeId) && now >= startedAt && now - startedAt < OFFLINE_AFTER_MS);
}

export function resetLinkPresence(now: number): void {
  lastSeen.clear();
  startedAt = now;
}
