import { Request, Response, NextFunction } from 'express';
import { runWithTenantContext } from '../utils/tenant-context';

/**
 * Middleware that takes the authenticated tenant details from `req.user`
 * and applies them to the request execution thread context via AsyncLocalStorage.
 * This guarantees that all downstream database calls automatically inherit the correct scope.
 */
export function tenantScopeMiddleware(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  
  if (!user) {
    res.status(401).json({
      success: false,
      data: null,
      error: {
        message: 'Authentication context is missing. Cannot apply tenant scope.',
        code: 'UNAUTHORIZED'
      },
      meta: {}
    });
    return;
  }

  const { tenantId, tenantType, role } = user;

  // Build the tenant context based on the user's tenant type
  const context = {
    agencyId: tenantType === 'agency' ? tenantId : undefined,
    clientId: tenantType === 'client' ? tenantId : undefined,
    bypass: role === 'super_admin' ? true : undefined
  };

  // Run the remaining middlewares and request handler in this tenant context
  runWithTenantContext(context, () => {
    next();
  });
}
