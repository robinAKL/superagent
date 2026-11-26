/**
 * Tenant context. Every request runs inside one tenant (set by the auth hook from the verified identity, never from
 * the request body); background work runs inside one tenant at a time through runAsTenant. State that lives in
 * process memory is kept per tenant with tenantScoped(), so one company's room, employees or tools can never be read
 * through another company's request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore { tenantId: string | null }
const als = new AsyncLocalStorage<TenantStore>();

/**
 * The tenant used when code runs outside any tenant context: local development, unit tests and the single-tenant
 * deployment's own start-up. Production request and background paths always set a tenant explicitly.
 */
let fallback = 'default';
export function setFallbackTenant(tenantId: string): void { fallback = tenantId; }
export function fallbackTenant(): string { return fallback; }

/** The tenant the current request or background job runs in. */
export function currentTenant(): string {
  return als.getStore()?.tenantId ?? fallback;
}

/** True when a request or job has set a tenant (not the fallback). */
export function hasTenantContext(): boolean {
  return Boolean(als.getStore()?.tenantId);
}

/** Runs `work` inside `tenantId`. Everything it awaits stays in that tenant. */
export function runAsTenant<T>(tenantId: string, work: () => T): T {
  return als.run({ tenantId }, work);
}

/** Opens an empty context for one request; the auth hook fills in the tenant once the identity is verified. */
export function openRequestContext(done: () => void): void {
  als.run({ tenantId: null }, done);
}

/**
 * Sets the tenant of the current request context (auth hook only). Outside a request context (routes mounted without
 * the app's onRequest hook, as some unit tests do) it does nothing and the fallback applies.
 */
export function enterTenant(tenantId: string): void {
  const store = als.getStore();
  if (store) store.tenantId = tenantId;
}

export interface TenantScoped<T> {
  /** The instance for the current tenant, created on first use. Assigning replaces the current tenant's instance. */
  current: T;
  /** The instance for a named tenant. */
  of(tenantId: string): T;
  /** Replaces a named tenant's instance. */
  set(tenantId: string, value: T): void;
  /** Tenants that have an instance in this process. */
  tenants(): string[];
  /** Drops every tenant's instance (tests and full reloads). */
  clear(): void;
}

/** Per-tenant process state with the `.current` shape the modules already use. */
export function tenantScoped<T>(make: (tenantId: string) => T): TenantScoped<T> {
  const byTenant = new Map<string, T>();
  const of = (tenantId: string): T => {
    let value = byTenant.get(tenantId);
    if (value === undefined) { value = make(tenantId); byTenant.set(tenantId, value); }
    return value;
  };
  return {
    get current() { return of(currentTenant()); },
    set current(value: T) { byTenant.set(currentTenant(), value); },
    of,
    set: (tenantId, value) => { byTenant.set(tenantId, value); },
    tenants: () => [...byTenant.keys()],
    clear: () => byTenant.clear(),
  };
}

/** Runs `work` once per tenant, one after another; one tenant's failure does not stop the others. */
export async function forEachTenant(tenantIds: Iterable<string>, work: (tenantId: string) => Promise<unknown>, onError?: (tenantId: string, error: unknown) => void): Promise<void> {
  for (const tenantId of new Set(tenantIds)) {
    try { await runAsTenant(tenantId, () => work(tenantId)); } catch (error) { onError?.(tenantId, error); }
  }
}

/** A stand-in that always forwards to the current tenant's instance (for plugins that keep a service reference). */
export function liveCurrent<T extends object>(holder: { current: T }): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const instance = holder.current as Record<string | symbol, unknown>;
      const value = instance[key];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
    },
    has: (_target, key) => key in (holder.current as object),
  });
}
