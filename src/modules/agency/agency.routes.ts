import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  metaConnect,
  getAnalytics,
  getProfile,
  updateProfile,
  getClientAnalyticsForAgency,
  updateClientPassword,
  listTeammates,
  createTeammate,
  deleteTeammate,
  changePassword,
} from './agency.controller';
import {
  getMetaOAuthUrlForClient,
  getClientAdAccounts,
  getClientPages,
  saveClientMetaConfig,
  disconnectClientMeta,
} from '../meta/meta.controller';
import {
  connectGoogleForClient,
  getGoogleStatus,
  getSpreadsheets,
  getSheetsInSpreadsheet,
  getSheetHeaders,
  getConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  saveMappings,
  syncNow,
  getSyncHistory,
  disconnectGoogleForClient,
  connectByUrl,
} from './agencyGoogleSheets.controller';

const router = Router();

// Apply auth middleware, check roles (Agency Admin only), and configure tenant scoping context
router.use(authMiddleware);
router.use(requireRoles(['agency_admin']));
router.use(tenantScopeMiddleware);

// Endpoints
router.get('/me', getProfile);
router.put('/me', updateProfile);
router.put('/change-password', changePassword);

// Teammates management endpoints
router.get('/teammates', listTeammates);
router.post('/teammates', createTeammate);
router.delete('/teammates/:id', deleteTeammate);

router.get('/clients', listClients);
router.post('/clients', createClient);
router.put('/clients/:id', updateClient);
router.put('/clients/:id/password', updateClientPassword);
router.delete('/clients/:id', deleteClient);
router.post('/clients/:id/meta-connect', metaConnect);
router.get('/clients/:id/meta-connect', getMetaOAuthUrlForClient);
router.get('/clients/:id/meta/ad-accounts', getClientAdAccounts);
router.get('/clients/:id/meta/pages', getClientPages);
router.post('/clients/:id/meta/config', saveClientMetaConfig);
router.delete('/clients/:id/meta', disconnectClientMeta);
router.get('/analytics', getAnalytics);
router.get('/clients/:clientId/analytics', getClientAnalyticsForAgency);

// Google Sheets endpoints for specific client under Agency management
router.get('/clients/:clientId/google/connect', connectGoogleForClient);
router.get('/clients/:clientId/google/status', getGoogleStatus);
router.get('/clients/:clientId/google/spreadsheets', getSpreadsheets);
router.get('/clients/:clientId/google/spreadsheets/:id/sheets', getSheetsInSpreadsheet);
router.get('/clients/:clientId/google/spreadsheets/:id/sheets/:sheetName/headers', getSheetHeaders);
router.get('/clients/:clientId/google/connections', getConnections);
router.post('/clients/:clientId/google/connections', createConnection);
router.delete('/clients/:clientId/google/connections/all', disconnectGoogleForClient);
router.patch('/clients/:clientId/google/connections/:id', updateConnection);
router.delete('/clients/:clientId/google/connections/:id', deleteConnection);
router.post('/clients/:clientId/google/mappings', saveMappings);
router.post('/clients/:clientId/google/sync-now', syncNow);
router.get('/clients/:clientId/google/history', getSyncHistory);
router.post('/clients/:clientId/google/connect-by-url', connectByUrl);

export default router;
export { router as agencyRouter };
