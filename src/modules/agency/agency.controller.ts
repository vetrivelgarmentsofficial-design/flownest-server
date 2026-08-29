import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getAgencyClients,
  createAgencyClient,
  updateAgencyClient,
  deleteAgencyClient,
  hardDeleteAgencyClient,
  saveClientMetaToken,
  generateMetaOAuthUrl,
  getAgencyAnalytics,
  getAgencyProfile,
  updateAgencyProfile,
  getClientAnalyticsForAgencyService,
  updateAgencyClientPassword,
  getAgencyTeammates,
  createAgencyTeammate,
  deleteAgencyTeammate,
  changeAgencyUserPassword,
} from './agency.service';

// Validation Schemas
export const getClientsQuerySchema = z.object({
  page: z.preprocess((val) => Number(val || 1), z.number().int().min(1).default(1)),
  limit: z.preprocess((val) => Number(val || 20), z.number().int().min(1).max(1000).default(20)),
  isDeleted: z.preprocess(
    (val) => (val === undefined ? undefined : val === 'true'),
    z.boolean().optional()
  ),
  includeDeleted: z.preprocess(
    (val) => val === 'true',
    z.boolean().default(false)
  ),
});

export const createClientBodySchema = z.object({
  businessName: z.string().min(2, 'Business name must be at least 2 characters').max(255),
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

export const updateClientBodySchema = z.object({
  businessName: z.string().min(2).max(255).optional(),
  email: z.string().email().trim().toLowerCase().optional(),
  metaAdSpend: z.preprocess(
    (val) => (val !== undefined ? Number(val) : undefined),
    z.number().nonnegative('Ad spend must be a non-negative number').optional()
  ),
});

export const metaConnectBodySchema = z.object({
  metaAccessToken: z.string().min(1, 'Token cannot be empty').optional(),
  metaAdAccountId: z.string().min(1).max(100).optional(),
  metaPageId: z.string().min(1).max(100).optional(),
  metaBusinessId: z.string().min(1).max(100).optional(),
  tokenExpiresAt: z.preprocess((val) => (val ? new Date(val as string) : undefined), z.date().optional()),
});

/**
 * Lists all clients for the calling agency (paginated).
 */
export async function listClients(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const { page, limit, isDeleted, includeDeleted } = getClientsQuerySchema.parse(req.query);
    const { clients, total } = await getAgencyClients(agencyId, page, limit, { isDeleted, includeDeleted });
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: clients,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Creates a new client and owner account.
 */
export async function createClient(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const { businessName, email, password } = createClientBodySchema.parse(req.body);
    const result = await createAgencyClient(agencyId, businessName, email, password);

    res.status(201).json({
      success: true,
      data: {
        client: result.client,
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
        },
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Modifies an existing client.
 */
export async function updateClient(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const clientId = req.params.id;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const body = updateClientBodySchema.parse(req.body);
    const client = await updateAgencyClient(agencyId, clientId, body.businessName, body.email, body.metaAdSpend);

    res.status(200).json({
      success: true,
      data: client,
      meta: {},
    });
  } catch (error: any) {
    if (error.message.includes('Client not found')) {
      res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Access denied: Client does not belong to this agency', code: 'FORBIDDEN' },
      });
      return;
    }
    next(error);
  }
}

/**
 * Soft deletes a client account.
 */
export async function deleteClient(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const clientId = req.params.id;
    const permanent = req.query.permanent === 'true';

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    if (permanent) {
      await hardDeleteAgencyClient(agencyId, clientId);
    } else {
      await deleteAgencyClient(agencyId, clientId);
    }

    res.status(200).json({
      success: true,
      data: { message: permanent ? 'Client account permanently deleted' : 'Client account deleted successfully' },
      meta: {},
    });
  } catch (error: any) {
    if (error.message.includes('Client not found')) {
      res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Access denied: Client does not belong to this agency or is already deleted', code: 'FORBIDDEN' },
      });
      return;
    }
    next(error);
  }
}


/**
 * Initiates or saves Meta OAuth connections.
 */
export async function metaConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const clientId = req.params.id;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const body = metaConnectBodySchema.parse(req.body);

    if (body.metaAccessToken) {
      // Save credentials with full connection metadata
      const updatedClient = await saveClientMetaToken(
        agencyId,
        clientId,
        body.metaAccessToken,
        {
          metaAdAccountId: body.metaAdAccountId,
          metaPageId: body.metaPageId,
          metaBusinessId: body.metaBusinessId,
          tokenExpiresAt: body.tokenExpiresAt,
          metaTokenStatus: 'CONNECTED',
        }
      );

      res.status(200).json({
        success: true,
        data: {
          clientId: updatedClient.id,
          businessName: updatedClient.businessName,
          metaConnected: true,
          metaTokenStatus: updatedClient.metaTokenStatus,
        },
        meta: {},
      });
    } else {
      // Initiate OAuth flow
      const oauthUrl = await generateMetaOAuthUrl(clientId);
      res.status(200).json({
        success: true,
        data: { oauthUrl },
        meta: {},
      });
    }
  } catch (error: any) {
    if (error.message.includes('Client not found')) {
      res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Access denied: Client does not belong to this agency', code: 'FORBIDDEN' },
      });
      return;
    }
    next(error);
  }
}

/**
 * Returns aggregated agency statistics across all clients.
 */
export async function getAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const analytics = await getAgencyAnalytics(agencyId);

    res.status(200).json({
      success: true,
      data: analytics,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

export const updateAgencyProfileBodySchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(255).optional(),
  email: z.string().email('Please enter a valid email address').trim().toLowerCase().optional(),
});

/**
 * Retrieves the authenticated agency's profile.
 */
export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const agency = await getAgencyProfile(agencyId);

    res.status(200).json({
      success: true,
      data: agency,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Updates the authenticated agency's profile.
 */
export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const body = updateAgencyProfileBodySchema.parse(req.body);
    const updatedAgency = await updateAgencyProfile(agencyId, body.name, body.email);

    res.status(200).json({
      success: true,
      data: updatedAgency,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns analytics for a specific client managed by the calling agency.
 */
export async function getClientAnalyticsForAgency(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const clientId = req.params.clientId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const analytics = await getClientAnalyticsForAgencyService(agencyId, clientId);

    res.status(200).json({
      success: true,
      data: analytics,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

export const updateClientPasswordBodySchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

/**
 * Controller endpoint for Agency Admin to change a client owner's password.
 */
export async function updateClientPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const clientId = req.params.id;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const { password } = updateClientPasswordBodySchema.parse(req.body);
    const result = await updateAgencyClientPassword(agencyId, clientId, password);

    res.status(200).json({
      success: true,
      data: result,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

// Teammate & Password Update Schemas
export const createTeammateBodySchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  role: z.enum(['agency_admin', 'sales_manager', 'sales_executive']),
});

export const changePasswordBodySchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

/**
 * Lists all teammates for the calling agency.
 */
export async function listTeammates(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const teammates = await getAgencyTeammates(agencyId);

    res.status(200).json({
      success: true,
      data: teammates,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Creates a new teammate under the agency.
 */
export async function createTeammate(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    const { email, password, role } = createTeammateBodySchema.parse(req.body);
    const teammate = await createAgencyTeammate(agencyId, email, password, role);

    res.status(201).json({
      success: true,
      data: teammate,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Deletes / Revokes a teammate's access.
 */
export async function deleteTeammate(req: Request, res: Response, next: NextFunction) {
  try {
    const agencyId = req.user?.tenantId;
    const userId = req.params.id;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Agency context missing', code: 'FORBIDDEN' } });
      return;
    }

    await deleteAgencyTeammate(agencyId, userId);

    res.status(200).json({
      success: true,
      data: { message: 'Teammate access revoked successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Updates the calling agency user's own password.
 */
export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized access', code: 'UNAUTHORIZED' } });
      return;
    }

    const { password } = changePasswordBodySchema.parse(req.body);
    await changeAgencyUserPassword(userId, password);

    res.status(200).json({
      success: true,
      data: { message: 'Password updated successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}
