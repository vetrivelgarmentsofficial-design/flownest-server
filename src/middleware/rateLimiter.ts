import rateLimit from 'express-rate-limit';

/**
 * Rate limiting for authentication endpoints (/v1/auth/*)
 * Limit: 10 requests per 15 minutes per IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

/**
 * Rate limiting for public webhook endpoints (/v1/webhooks/*)
 * Limit: 100 requests per 1 minute per IP
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
  message: {
    success: false,
    error: 'Too many webhook requests. Please try again after a minute.',
  },
});

/**
 * Rate limiting for general API requests
 * Limit: 200 requests per 1 minute per User ID (falls back to IP if unauthenticated)
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 200,
  keyGenerator: (req: any) => {
    return req.user?.userId || req.ip || 'unknown-ip';
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
  message: {
    success: false,
    error: 'Too many requests. Please try again after a minute.',
  },
});
