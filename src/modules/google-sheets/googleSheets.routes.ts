import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import { generalLimiter } from '../../middleware/rateLimiter';
import {
  connectGoogle,
  googleCallback,
  getSpreadsheets,
  getSheetsInSpreadsheet,
  createConnection,
  saveMappings,
  syncNow,
  getSyncHistory,
  updateConnection,
  deleteConnection,
  getConnections,
  getGoogleStatus,
  getSheetHeaders,
  connectByUrl,
  disconnectGoogle,
} from './googleSheets.controller';

const router = Router();

// 1. Google OAuth Callback (Public, rate limited)
router.get('/callback', generalLimiter, googleCallback);

// Apply auth middleware, restrict roles, and apply tenant scoping context to all connection endpoints
router.use(authMiddleware);
router.use(requireRoles(['agency_admin', 'client_owner']));
router.use(tenantScopeMiddleware);

// 2. Integrations & OAuth Initiate
router.get('/connect', connectGoogle);
router.get('/status', getGoogleStatus);
router.post('/connect-by-url', connectByUrl);

// 3. Drive & Sheets fetch options
router.get('/spreadsheets', getSpreadsheets);
router.get('/spreadsheets/:id/sheets', getSheetsInSpreadsheet);
router.get('/spreadsheets/:id/sheets/:sheetName/headers', getSheetHeaders);

// 4. Connection CRUD
router.get('/connections', getConnections);
router.post('/connections', createConnection);
router.patch('/connections/:id', updateConnection);
router.delete('/connections/all', disconnectGoogle);
router.delete('/connections/:id', deleteConnection);

// 5. Column Mappings
router.post('/mappings', saveMappings);

// 6. Manual Sync
router.post('/sync-now', syncNow);

// 7. Sync History
router.get('/history', getSyncHistory);

export default router;
export { router as googleSheetsRouter };
