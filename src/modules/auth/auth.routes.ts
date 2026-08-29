import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, refresh, logout, forgotPassword, resetPassword, changeUserPassword, createSupportTicket } from './auth.controller';
import { authMiddleware } from '../../middleware/auth';
import { register, verifyEmail, resendVerification } from './register.controller';

const router = Router();

// Configure Rate Limiter (10 requests per 15 minutes per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // Limit each IP to 10 requests per window
  standardHeaders: 'draft-7', // standard draft-7 headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: () => process.env.NODE_ENV === 'development',
  message: {
    success: false,
    data: null,
    error: {
      message: 'Too many authentication attempts. Please try again after 15 minutes.',
      code: 'TOO_MANY_REQUESTS',
    },
    meta: {},
  },
});

// Apply rate limiting to all auth endpoints (Disabled)
router.post('/register', register);
router.get('/verify-email', verifyEmail);
router.post('/verify-email/resend', resendVerification);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.put('/change-password', authMiddleware, changeUserPassword);
router.post('/support', authMiddleware, createSupportTicket);

export default router;
export { router as authRouter };
