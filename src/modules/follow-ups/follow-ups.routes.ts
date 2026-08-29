import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import { listFollowUps, patchCompleteFollowUp } from './follow-ups.controller';

const router = Router();

// Configure auth, RBAC (Agency Admin OR Client Owner) and tenant context mapping
router.use(authMiddleware);
router.use(requireRoles(['agency_admin', 'client_owner']));
router.use(tenantScopeMiddleware);

// Routes
router.get('/', listFollowUps);
router.patch('/:id/complete', patchCompleteFollowUp);

export default router;
export { router as followUpsRouter };
