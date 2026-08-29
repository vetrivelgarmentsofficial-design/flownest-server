import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { tenantScopeMiddleware } from '../../middleware/tenantScope';
import prisma from '../../config/db';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles(['super_admin']));
router.use(tenantScopeMiddleware);

// List all clients across all agencies for super admin
router.get('/clients', async (req, res, next) => {
  try {
    const clients = await prisma.client.findMany({
      where: { isDeleted: false },
      orderBy: { businessName: 'asc' },
      include: {
        agency: {
          select: { name: true },
        },
      },
    });

    res.status(200).json({
      success: true,
      data: clients,
    });
  } catch (error) {
    next(error);
  }
});

// List all agencies
router.get('/', async (req, res, next) => {
  try {
    const agencies = await prisma.agency.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { clients: true, users: true },
        },
      },
    });

    res.status(200).json({
      success: true,
      data: agencies,
    });
  } catch (error) {
    next(error);
  }
});

// Suspend / activate an agency
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body; // boolean

    if (typeof isActive !== 'boolean') {
      res.status(400).json({ success: false, error: 'isActive must be a boolean' });
      return;
    }

    const updated = await prisma.agency.update({
      where: { id },
      data: { isActive },
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

export { router as superAdminAgenciesRouter };
