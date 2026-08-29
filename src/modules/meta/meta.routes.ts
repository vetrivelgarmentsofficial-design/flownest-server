import express, { Router } from 'express';
import {
  verifyMetaWebhook,
  handleMetaWebhook,
  handleMetaCallback,
  getMetaHealthReport,
  getMetaDashboard,
} from './meta.controller';
import { webhookLimiter } from '../../middleware/rateLimiter';
import { authMiddleware } from '../../middleware/auth';

const router = Router();

// Webhook GET endpoint handles verification when hub.mode === 'subscribe'
// and handles the OAuth Callback flow otherwise
router.get('/callback', webhookLimiter, (req, res, next) => {
  if (req.query['hub.mode'] === 'subscribe') {
    return verifyMetaWebhook(req, res, next);
  } else {
    return handleMetaCallback(req, res, next);
  }
});

// Webhook POST endpoint handles lead generation webhook events
// Mounted with express.raw to preserve raw buffer for HMAC verification
router.post(
  '/callback',
  webhookLimiter,
  express.raw({ type: 'application/json' }),
  handleMetaWebhook
);

// Meta connection health check endpoint
router.get('/health/:clientId', webhookLimiter, getMetaHealthReport);

// Unified Meta Dashboard intelligence endpoint
router.get('/dashboard', authMiddleware, getMetaDashboard);

export default router;
export { router as metaRouter };
