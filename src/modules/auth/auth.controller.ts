import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { loginUser, rotateRefreshToken, invalidateRefreshToken, requestPasswordReset, resetPassword as resetPasswordService, createSupportTicketService } from './auth.service';
import { changeAgencyUserPassword } from '../agency/agency.service';

// Validation Schemas
export const loginBodySchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  rememberMe: z.boolean().optional(),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required').optional(),
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required').optional(),
});

/**
 * Controller endpoint to handle user login.
 */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, rememberMe } = loginBodySchema.parse(req.body);
    
    const authData = await loginUser(email, password, rememberMe);

    // Set the refresh token as an httpOnly cookie
    res.cookie('refreshToken', authData.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: (authData.expiresInDays ?? 7) * 24 * 60 * 60 * 1000,
    });
    
    res.status(200).json({
      success: true,
      data: authData,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to handle token rotation.
 */
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    // Attempt to extract refresh token from cookie or body
    let refreshToken = req.cookies?.refreshToken;
    if (!refreshToken && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';');
      for (let c of cookies) {
        const [key, val] = c.trim().split('=');
        if (key === 'refreshToken') {
          refreshToken = decodeURIComponent(val);
          break;
        }
      }
    }
    if (!refreshToken) {
      refreshToken = req.body.refreshToken;
    }

    if (!refreshToken) {
      res.status(400).json({
        success: false,
        data: null,
        error: { message: 'Refresh token is required.', code: 'BAD_REQUEST' },
        meta: {}
      });
      return;
    }
    
    const newTokens = await rotateRefreshToken(refreshToken);

    // Set the new refresh token in the httpOnly cookie
    res.cookie('refreshToken', newTokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: (newTokens.expiresInDays ?? 7) * 24 * 60 * 60 * 1000,
    });
    
    res.status(200).json({
      success: true,
      data: newTokens,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to handle user logout.
 */
export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    // Attempt to extract refresh token from cookie or body
    let refreshToken = req.cookies?.refreshToken;
    if (!refreshToken && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';');
      for (let c of cookies) {
        const [key, val] = c.trim().split('=');
        if (key === 'refreshToken') {
          refreshToken = decodeURIComponent(val);
          break;
        }
      }
    }
    if (!refreshToken) {
      refreshToken = req.body.refreshToken;
    }

    if (refreshToken) {
      await invalidateRefreshToken(refreshToken);
    }

    // Clear the httpOnly cookie
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    });
    
    res.status(200).json({
      success: true,
      data: { message: 'Logged out successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

// Additional validation schemas
export const forgotPasswordBodySchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

/**
 * Controller endpoint to request password reset.
 */
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = forgotPasswordBodySchema.parse(req.body);
    await requestPasswordReset(email);
    res.status(200).json({
      success: true,
      data: { message: 'Password reset link sent successfully.' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to reset password.
 */
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = resetPasswordBodySchema.parse(req.body);
    await resetPasswordService(token, password);
    res.status(200).json({
      success: true,
      data: { message: 'Password reset successfully.' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to change currently logged in user's password.
 */
export async function changeUserPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }
    const { password } = z.object({
      password: z.string().min(6, 'Password must be at least 6 characters long'),
    }).parse(req.body);
    
    await changeAgencyUserPassword(userId, password);
    
    res.status(200).json({
      success: true,
      data: { message: 'Password updated successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to submit a support ticket.
 */
export async function createSupportTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.role || 'user';
    const tenantId = req.user?.tenantId || 'unknown';

    if (!userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized access', code: 'UNAUTHORIZED' } });
      return;
    }

    const { subject, message } = z.object({
      subject: z.string().min(1, 'Please enter a ticket subject').max(100),
      message: z.string().min(1, 'Please enter detailed description for the support request'),
    }).parse(req.body);

    await createSupportTicketService(userId, userRole, tenantId, subject, message);

    res.status(200).json({
      success: true,
      data: { message: 'Support ticket submitted successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

