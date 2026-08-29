import { Request, Response, NextFunction } from 'express';
import { runWithTenantContext } from '../utils/tenant-context';

/**
 * Express middleware to extract tenant IDs from headers and set the active tenant context.
 * Expected headers:
 * - 'x-agency-id': Active Agency UUID
 * - 'x-client-id': Active Client UUID (if client scope is active)
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  const agencyId = req.headers['x-agency-id'] as string | undefined;
  const clientId = req.headers['x-client-id'] as string | undefined;

  // We run the next middlewares/controllers within the AsyncLocalStorage zone
  runWithTenantContext({ agencyId, clientId }, () => {
    next();
  });
}
