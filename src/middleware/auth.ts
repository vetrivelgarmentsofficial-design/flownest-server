import { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';

// Extend Express Request interface to include the user payload
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: string;
        tenantId: string;
        tenantType: 'agency' | 'client';
      };
    }
  }
}

/**
 * Authentication middleware to verify JWT tokens using the jose library.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    let token = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query.token && typeof req.query.token === 'string') {
      token = req.query.token;
    }

    if (!token) {
      res.status(401).json({
        success: false,
        data: null,
        error: {
          message: 'Access token is missing or invalid.',
          code: 'UNAUTHORIZED'
        },
        meta: {}
      });
      return;
    }
    const secretStr = process.env.JWT_ACCESS_SECRET;
    if (!secretStr) {
      throw new Error('JWT_ACCESS_SECRET is not configured in the environment.');
    }

    const secret = new TextEncoder().encode(secretStr);
    
    // Verify the JWT
    const { payload } = await jose.jwtVerify(token, secret);
    
    // Validate required fields in the JWT payload
    if (!payload.userId || !payload.role || !payload.tenantId || !payload.tenantType) {
      res.status(401).json({
        success: false,
        data: null,
        error: {
          message: 'Invalid token payload schema.',
          code: 'UNAUTHORIZED'
        },
        meta: {}
      });
      return;
    }

    req.user = {
      userId: payload.userId as string,
      role: payload.role as string,
      tenantId: payload.tenantId as string,
      tenantType: payload.tenantType as 'agency' | 'client'
    };

    next();
  } catch (error: any) {
    res.status(401).json({
      success: false,
      data: null,
      error: {
        message: 'Invalid or expired access token.',
        code: 'UNAUTHORIZED',
        details: error.message
      },
      meta: {}
    });
  }
}
