import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that restricts route access to specific user roles.
 */
export function requireRoles(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    
    if (!user) {
      res.status(401).json({
        success: false,
        data: null,
        error: {
          message: 'Authentication context is missing.',
          code: 'UNAUTHORIZED'
        },
        meta: {}
      });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        success: false,
        data: null,
        error: {
          message: `Forbidden: Access requires one of the following roles: ${allowedRoles.join(', ')}`,
          code: 'FORBIDDEN'
        },
        meta: {}
      });
      return;
    }

    next();
  };
}
