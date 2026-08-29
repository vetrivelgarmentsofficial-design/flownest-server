import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import { listSales, recordSale, getSalesAnalytics } from './sales.controller';

const router = Router();

// Apply auth, check role (Client Owner only), and configure tenant scoping context
router.use(authMiddleware);
router.use(requireRoles(['client_owner']));
router.use(tenantScopeMiddleware);

// Endpoints
router.get('/', listSales);
router.post('/', recordSale);
router.get('/analytics', getSalesAnalytics);

export default router;
export { router as salesRouter };
