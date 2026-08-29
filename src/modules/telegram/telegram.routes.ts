import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import {
  connectBot,
  getBotStatus,
  disconnectBot,
  clientConnect,
  getClientStatus,
  clientDisconnect,
  processWebhook,
  removeClientRecipient,
  getClientLogs,
  sendTestAlert,
  testConnection
} from './telegram.controller';

const telegramRouter = Router();

// Public Webhook (no auth/tenant scoping)
telegramRouter.post('/webhook/:integrationId', processWebhook);

// Protected Agency endpoints
telegramRouter.post('/connect', authMiddleware, requireRoles(['agency_admin']), tenantScopeMiddleware, connectBot);
telegramRouter.get('/status', authMiddleware, requireRoles(['agency_admin']), tenantScopeMiddleware, getBotStatus);
telegramRouter.delete('/disconnect', authMiddleware, requireRoles(['agency_admin']), tenantScopeMiddleware, disconnectBot);

const clientTelegramRouter = Router();

// Protected Client endpoints
clientTelegramRouter.use(authMiddleware);
clientTelegramRouter.use(requireRoles(['client_owner', 'agency_admin']));
clientTelegramRouter.use(tenantScopeMiddleware);

clientTelegramRouter.post('/connect', clientConnect);
clientTelegramRouter.get('/status', getClientStatus);
clientTelegramRouter.get('/logs', getClientLogs);
clientTelegramRouter.post('/test-alert', sendTestAlert);
clientTelegramRouter.post('/test-connection', testConnection);
clientTelegramRouter.delete('/disconnect/:integrationId', clientDisconnect);
clientTelegramRouter.delete('/recipients/:id', removeClientRecipient);

export { telegramRouter, clientTelegramRouter };

