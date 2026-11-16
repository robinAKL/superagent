/**
 * Instant wake for held worker polls (room task T-07).
 *
 * A held poll registers interest in two keys before it checks the database: its tenant (queue work) and its own
 * worker id (addressed events). PostgreSQL triggers (migration 0015) send NOTIFY after the insert commits, and the
 * listener below turns each notification into notify(key). Registering before the check means a notification that
 * lands between "checked, found nothing" and "start waiting" is not lost.
 *
 * Notifications are only a hint. The poll always re-reads the database, and it still rescans on a timer, so a
 * dropped LISTEN connection or a missed notification delays work by at most one scan period; it never loses it.
 */
export const WORK_CHANNEL = 'superagent_work';
export const WORKER_EVENT_CHANNEL = 'superagent_worker_event';

export const tenantKey = (tenantId: string) => `tenant:${tenantId}`;
export const workerKey = (workerId: string) => `worker:${workerId}`;

export interface Waiter {
  promise: Promise<void>;
  cancel(): void;
}

export class WorkSignal {
  /** True while a LISTEN connection is up; polls then rescan less often because notifications cover the gap. */
  listening = false;
  private readonly waiters = new Map<string, Set<() => void>>();

  waitFor(keys: string[]): Waiter {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const fire = () => { cancel(); resolve(); };
    const cancel = () => {
      for (const key of keys) {
        const set = this.waiters.get(key);
        set?.delete(fire);
        if (set && set.size === 0) this.waiters.delete(key);
      }
    };
    for (const key of keys) {
      let set = this.waiters.get(key);
      if (!set) this.waiters.set(key, (set = new Set()));
      set.add(fire);
    }
    return { promise, cancel };
  }

  notify(key: string): void {
    const set = this.waiters.get(key);
    if (!set) return;
    for (const fire of [...set]) fire();
  }

  /** Every held poll rescans now (used when the listener connection drops, so nothing waits on a dead channel). */
  wakeAll(): void {
    for (const set of [...this.waiters.values()]) for (const fire of [...set]) fire();
  }

  /** Route one PostgreSQL notification to the waiting polls. Unknown channels and empty payloads are ignored. */
  onNotification(channel: string, payload: string | undefined): void {
    if (!payload) return;
    if (channel === WORK_CHANNEL) this.notify(tenantKey(payload));
    else if (channel === WORKER_EVENT_CHANNEL) this.notify(workerKey(payload));
  }
}

export const workSignal = new WorkSignal();

/** The subset of a pg client the listener needs. A pg.PoolClient fits. */
export interface ListenClient {
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error' | 'end', listener: (err?: Error) => void): unknown;
  release(destroy?: boolean | Error): void;
}

export interface ListenerOptions {
  signal?: WorkSignal;
  log?: (o: Record<string, unknown>) => void;
  /** Reconnect backoff: starts at minMs, doubles to maxMs, resets after a successful LISTEN. */
  minMs?: number;
  maxMs?: number;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Holds one dedicated connection with LISTEN on both channels and reconnects with backoff when it drops.
 * Returns stop(), which releases the connection and ends the loop.
 */
export function startPgListener(connect: () => Promise<ListenClient>, opts: ListenerOptions = {}): { stop: () => Promise<void>; done: Promise<void> } {
  const signal = opts.signal ?? workSignal;
  const log = opts.log ?? ((o) => console.log(JSON.stringify(o)));
  const minMs = opts.minMs ?? 1_000;
  const maxMs = opts.maxMs ?? 30_000;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  let stopped = false;
  let current: ListenClient | null = null;
  let wakeStop: () => void = () => undefined;
  const stopping = new Promise<void>((r) => { wakeStop = r; });

  const done = (async () => {
    let backoff = minMs;
    while (!stopped) {
      try {
        const client = await connect();
        if (stopped) { client.release(); break; }
        current = client;
        const lost = new Promise<void>((resolve) => {
          client.on('error', (err) => { log({ msg: 'worker listen connection error', error: err?.message }); resolve(); });
          client.on('end', () => resolve());
        });
        client.on('notification', (msg) => signal.onNotification(msg.channel, msg.payload));
        await client.query(`LISTEN ${WORK_CHANNEL}`);
        await client.query(`LISTEN ${WORKER_EVENT_CHANNEL}`);
        signal.listening = true;
        backoff = minMs;
        // Anything committed while we were not listening is picked up by this rescan.
        signal.wakeAll();
        await Promise.race([lost, stopping]);
        signal.listening = false;
        current = null;
        try { client.release(true); } catch { /* already gone */ }
        signal.wakeAll();
      } catch (error) {
        signal.listening = false;
        // A connection borrowed before the failure (e.g. LISTEN rejected) goes back destroyed, or the pool leaks it.
        if (current) { try { current.release(true); } catch { /* already gone */ } current = null; }
        if (stopped) break;
        log({ msg: 'worker listen connect failed; retrying', error: error instanceof Error ? error.message : String(error), backoffMs: backoff });
      }
      if (stopped) break;
      await Promise.race([delay(backoff), stopping]);
      backoff = Math.min(backoff * 2, maxMs);
    }
  })();

  return {
    done,
    stop: async () => {
      stopped = true;
      wakeStop(); // the loop sees it, releases its connection exactly once, and exits
      signal.listening = false;
      await done;
    },
  };
}
