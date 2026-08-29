import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  agencyId?: string;
  clientId?: string;
  bypass?: boolean; // Set to true to bypass tenant checking for system tasks
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs a function within a specified tenant context.
 */
export function runWithTenantContext<T>(context: TenantContext, callback: () => T): T {
  return tenantStorage.run(context, callback);
}

/**
 * Gets the current active tenant context.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Runs a function bypassing the tenant isolation middleware (for system/admin use).
 */
export function runBypassingTenant<T>(callback: () => T): T {
  return tenantStorage.run({ bypass: true }, callback);
}
