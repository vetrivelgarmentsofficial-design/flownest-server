import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import {
  listLeads,
  getLead,
  patchLeadStage,
  postLeadNote,
  deleteLead,
  bulkDeleteLeads,
  postCreateLead,
  listLeadActivities,
} from './leads.controller';
import { postFollowUp } from '../follow-ups/follow-ups.controller';

const router = Router();

// Secure all lead endpoints with auth and tenant scopes
router.use(authMiddleware);
router.use(tenantScopeMiddleware);

// Endpoints
router.get('/', requireRoles(['super_admin', 'agency_admin', 'client_owner']), listLeads);
router.post('/', requireRoles(['agency_admin', 'client_owner']), postCreateLead);
router.post('/bulk-delete', requireRoles(['super_admin']), bulkDeleteLeads);
router.get('/:id', requireRoles(['super_admin', 'agency_admin', 'client_owner']), getLead);
router.patch('/:id/stage', requireRoles(['agency_admin', 'client_owner']), patchLeadStage);
router.post('/:id/notes', requireRoles(['agency_admin', 'client_owner']), postLeadNote);
router.get('/:id/activities', requireRoles(['super_admin', 'agency_admin', 'client_owner']), listLeadActivities);
router.delete('/:id', requireRoles(['super_admin']), deleteLead);

// Nested follow-up scheduler route
router.post('/:id/follow-ups', requireRoles(['agency_admin', 'client_owner']), postFollowUp);

export default router;
export { router as leadsRouter };
