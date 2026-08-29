// Trigger IDE type cache recheck
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  exchangeCodeForLongLivedToken,
  fetchClientAdAccounts,
  fetchClientPages,
  saveMetaConfig,
  getMetaDashboardService,
  disconnectMetaForClient,
} from './meta.service';
import { MetaDiagnosticsService } from './meta-diagnostics.service';
import { generateMetaOAuthUrl, verifyMetaOAuthState } from '../agency/agency.service';
import { metaLeadsQueue } from '../../queues/metaLeadsQueue';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';

// Validation Schemas
export const verifyWebhookQuerySchema = z.object({
  'hub.mode': z.string().min(1, 'hub.mode is required'),
  'hub.verify_token': z.string().min(1, 'hub.verify_token is required'),
  'hub.challenge': z.string().min(1, 'hub.challenge is required'),
});

export const callbackQuerySchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

export const clientParamSchema = z.object({
  id: z.string().uuid('Invalid client ID format'),
});

/**
 * Validates the Facebook Hub Verification token challenge.
 */
export function verifyMetaWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } =
      verifyWebhookQuerySchema.parse(req.query);

    const localVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'FlowNest_verify_token';

    if (mode === 'subscribe' && token === localVerifyToken) {
      logger.info('MetaWebhook', 'Hub challenge verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('MetaWebhook', 'Hub challenge verification failed: token mismatch', {
        receivedToken: token,
        expectedToken: localVerifyToken,
      });
      res.status(403).send('Forbidden: Token mismatch');
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Handles incoming lead gen events, validates HMAC-SHA256 signatures,
 * routes by page_id (with metaAdAccountId fallback), and enqueues BullMQ jobs.
 */
export async function handleMetaWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signatureHeader) {
      logger.warn('MetaWebhook', 'Signature header missing. Rejecting with 403.');
      res.status(403).send('Forbidden: Signature missing');
      return;
    }

    const appSecret = process.env.META_APP_SECRET || 'mock_app_secret';
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      logger.warn('MetaWebhook', 'Body is not raw buffer. Rejecting with 403.');
      res.status(403).send('Forbidden: Body must be raw payload');
      return;
    }

    // 1. Validate HMAC-SHA256 signature
    const hmac = crypto.createHmac('sha256', appSecret);
    hmac.update(rawBody);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;

    if (signatureHeader !== expectedSignature) {
      logger.warn('MetaWebhook', 'HMAC signature mismatch. Rejecting with 403.');
      res.status(403).send('Forbidden: Signature mismatch');
      return;
    }

    // 2. Respond 200 OK immediately after validating signature (required by Facebook)
    res.status(200).send('OK');

    // 3. Parse payload
    const payload = JSON.parse(rawBody.toString('utf8'));
    logger.info('MetaWebhook', 'Webhook signature verified. Processing event.');

    // 4. Route by page_id → client, then enqueue
    if (payload.object === 'page' && payload.entry) {
      for (const entry of payload.entry) {
        if (!entry.changes) continue;

        for (const change of entry.changes) {
          if (change.field === 'leadgen' && change.value) {
            const { leadgen_id, form_id, page_id } = change.value;

            await runBypassingTenant(async () => {
              // Primary routing: match by metaPageId (page/form based)
              let client = await prisma.client.findFirst({
                where: { metaPageId: page_id },
              });

              // Legacy fallback: match by metaAdAccountId
              if (!client) {
                client = await prisma.client.findFirst({
                  where: { metaAdAccountId: page_id },
                });
                if (client) {
                  logger.warn('MetaWebhook', 'Routed via legacy metaAdAccountId fallback', {
                    pageId: page_id,
                    clientId: client.id,
                  });
                }
              }

              if (client) {
                if (metaLeadsQueue) {
                  await metaLeadsQueue.add('process-lead', {
                    leadgenId: leadgen_id,
                    clientId: client.id,
                    formId: form_id,
                    pageId: page_id,
                  });
                  logger.info('MetaWebhook', 'Enqueued process-lead job', {
                    clientId: client.id,
                    pageId: page_id,
                    formId: form_id,
                    leadgenId: leadgen_id,
                  });
                } else {
                  logger.warn('MetaWebhook', 'Received Facebook webhook lead event, but Meta Leads queue is disabled.', {
                    leadgenId: leadgen_id,
                    clientId: client.id,
                  });
                }

                // Emit webhook:received event
                try {
                  const { getIo } = require('../../sockets');
                  const io = getIo();
                  io.to(`client:${client.id}`).emit('webhook:received', {
                    leadgenId: leadgen_id,
                    formId: form_id,
                    pageId: page_id,
                    timestamp: new Date().toISOString()
                  });
                } catch (socketError: any) {
                  logger.warn('MetaWebhook', 'Failed to emit webhook:received socket event', { error: socketError.message });
                }
              } else {
                logger.warn('MetaWebhook', 'No client matched for incoming webhook event', {
                  pageId: page_id,
                  formId: form_id,
                  leadgenId: leadgen_id,
                });
              }
            });
          }
        }
      }
    }
  } catch (error: any) {
    logger.error('MetaWebhook', 'Failed to process webhook event', { error: error.message });
  }
}

/**
 * Handles the Facebook OAuth callback exchange.
 * Verifies the signed JWT state before processing the authorization code.
 */
export async function handleMetaCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, state } = callbackQuerySchema.parse(req.query);

    console.log('--- OAUTH CALLBACK QUERY PARAMETERS ---');
    console.log('Code:', code);
    console.log('State:', state);
    console.log('---------------------------------------');

    // Verify JWT state (CSRF protection) — throws if expired or tampered
    let clientId: string;
    try {
      clientId = await verifyMetaOAuthState(state);
    } catch (stateError: any) {
      logger.warn('MetaCallback', 'OAuth state verification failed', { error: stateError.message });
      res.status(400).json({
        success: false,
        error: {
          message: 'Invalid or expired OAuth state. Please initiate the connection again.',
          code: 'INVALID_OAUTH_STATE',
        },
      });
      return;
    }

    logger.info('MetaCallback', 'OAuth state verified. Exchanging code for token.', { clientId });
    await exchangeCodeForLongLivedToken(code, clientId);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    res.redirect(`${frontendUrl}/agency/clients/${clientId}?meta_connected=true`);
  } catch (error) {
    next(error);
  }
}

/**
 * Returns Meta OAuth URL for a specific client (agency admin use).
 */
export async function getMetaOAuthUrlForClient(req: Request, res: Response, next: NextFunction) {
  try {
    const { id: clientId } = clientParamSchema.parse(req.params);

    const agencyId = req.user?.tenantId;
    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: 'Agency context missing' });
      return;
    }

    await runBypassingTenant(async () => {
      const client = await prisma.client.findUnique({
        where: { id: clientId },
      });

      if (!client || client.agencyId !== agencyId) {
        res.status(403).json({
          success: false,
          error: 'Access denied: Client does not belong to this agency',
        });
        return;
      }

      const oauthUrl = await generateMetaOAuthUrl(clientId);

      res.status(200).json({
        success: true,
        data: { oauthUrl },
        meta: {},
      });
    });
  } catch (error) {
    next(error);
  }
}

export const saveMetaConfigSchema = z.object({
  metaAdAccountId: z.string().min(1, 'Ad Account ID is required'),
  metaAdAccountName: z.string().min(1, 'Ad Account Name is required'),
  metaPageId: z.string().min(1, 'Page ID is required'),
  metaPageName: z.string().min(1, 'Page Name is required'),
  metaPageAccessToken: z.string().min(1, 'Page Access Token is required'),
});

/**
 * Fetches accessible Meta Ad Accounts for the given client.
 */
export async function getClientAdAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { id: clientId } = clientParamSchema.parse(req.params);
    const agencyId = req.user?.tenantId;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: 'Agency context missing' });
      return;
    }

    const adAccounts = await fetchClientAdAccounts(agencyId, clientId);

    res.status(200).json({
      success: true,
      data: adAccounts,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Fetches accessible Facebook Pages for the given client.
 */
export async function getClientPages(req: Request, res: Response, next: NextFunction) {
  try {
    const { id: clientId } = clientParamSchema.parse(req.params);
    const agencyId = req.user?.tenantId;

    if (!agencyId) {
      res.status(403).json({ success: false, data: null, error: 'Agency context missing' });
      return;
    }

    const pages = await fetchClientPages(agencyId, clientId);

    res.status(200).json({
      success: true,
      data: pages,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Saves configuration choice of Ad Account and Page, then triggers webhook setup.
 */
export async function saveClientMetaConfig(req: Request, res: Response, next: NextFunction) {
  const { id: clientId } = clientParamSchema.parse(req.params);
  const agencyId = req.user?.tenantId;

  logger.info('MetaController', 'Received request to save Client Meta configuration', {
    clientId,
    agencyId,
    body: {
      metaAdAccountId: req.body?.metaAdAccountId,
      metaAdAccountName: req.body?.metaAdAccountName,
      metaPageId: req.body?.metaPageId,
      metaPageName: req.body?.metaPageName,
      metaPageAccessToken: req.body?.metaPageAccessToken ? `${req.body.metaPageAccessToken.substring(0, 10)}...` : undefined,
    },
  });

  try {
    if (!agencyId) {
      logger.warn('MetaController', 'Save Client Meta config failed: Agency context missing', { clientId });
      res.status(403).json({
        success: false,
        error: {
          message: 'Agency context missing',
        },
      });
      return;
    }

    const config = saveMetaConfigSchema.parse(req.body);
    const updatedClient = await saveMetaConfig(agencyId, clientId, config);

    logger.info('MetaController', 'Client Meta config saved successfully', {
      clientId,
      agencyId,
      metaAdAccountId: updatedClient.metaAdAccountId,
      metaPageId: updatedClient.metaPageId,
    });

    res.status(200).json({
      success: true,
      data: {
        clientId: updatedClient.id,
        businessName: updatedClient.businessName,
        metaAdAccountId: updatedClient.metaAdAccountId,
        metaAdAccountName: updatedClient.metaAdAccountName,
        metaPageId: updatedClient.metaPageId,
        metaPageName: updatedClient.metaPageName,
        metaTokenStatus: updatedClient.metaTokenStatus,
      },
      meta: {},
    });
  } catch (error: any) {
    logger.error('MetaController', 'Error saving Meta client config', {
      clientId,
      agencyId,
      error: error.message,
      stack: error.stack,
    });

    res.status(400).json({
      success: false,
      error: {
        message: error.message || 'Failed to save Meta configuration',
      },
    });
  }
}

/**
 * Disconnects the Meta integration configuration for a client.
 */
export async function disconnectClientMeta(req: Request, res: Response, next: NextFunction) {
  const { id: clientId } = clientParamSchema.parse(req.params);
  const agencyId = req.user?.tenantId;

  logger.info('MetaController', 'Received request to disconnect Client Meta integration', {
    clientId,
    agencyId,
  });

  try {
    if (!agencyId) {
      logger.warn('MetaController', 'Disconnect Client Meta failed: Agency context missing', { clientId });
      res.status(403).json({
        success: false,
        error: {
          message: 'Agency context missing',
        },
      });
      return;
    }

    const updatedClient = await disconnectMetaForClient(agencyId, clientId);

    logger.info('MetaController', 'Client Meta integration disconnected successfully', {
      clientId,
      agencyId,
    });

    res.status(200).json({
      success: true,
      data: {
        clientId: updatedClient.id,
        businessName: updatedClient.businessName,
        metaTokenStatus: updatedClient.metaTokenStatus,
      },
      meta: {},
    });
  } catch (error: any) {
    logger.error('MetaController', 'Error disconnecting Meta client integration', {
      clientId,
      agencyId,
      error: error.message,
      stack: error.stack,
    });

    res.status(400).json({
      success: false,
      error: {
        message: error.message || 'Failed to disconnect Meta integration',
      },
    });
  }
}


/**
 * Returns the structured Meta health diagnostics report for a specific client.
 */
export async function getMetaHealthReport(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.params.clientId;
    const report = await MetaDiagnosticsService.generateMetaDiagnosticsReport(clientId);
    res.status(200).json({
      success: true,
      data: report,
      meta: {},
    });
  } catch (error: any) {
    logger.error('MetaController', 'Error generating Meta health report', {
      clientId: req.params.clientId,
      error: error.message,
    });
    res.status(400).json({
      success: false,
      error: {
        message: error.message || 'Failed to generate Meta health report',
      },
    });
  }
}

/**
 * Controller that returns the Meta intelligence dashboard dataset for the client context.
 */
export async function getMetaDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const role = req.user?.role;
    const userTenantId = req.user?.tenantId;
    let clientId = userTenantId;

    // If super admin or agency admin, they can pass clientId in query params to view client's dashboard
    if (role === 'super_admin' || role === 'agency_admin') {
      const qClientId = req.query.clientId as string | undefined;
      if (qClientId) {
        clientId = qClientId;
      }
    }

    if (!clientId) {
      res.status(400).json({
        success: false,
        error: { message: 'Client context (clientId) is missing or unresolved.', code: 'CLIENT_CONTEXT_MISSING' },
      });
      return;
    }

    const dashboardData = await getMetaDashboardService(clientId);

    res.status(200).json({
      success: true,
      data: dashboardData,
      meta: {},
    });
  } catch (error: any) {
    logger.error('MetaController', 'Failed to retrieve Meta Ads dashboard analytics', { error: error.message });
    res.status(400).json({
      success: false,
      error: {
        message: error.message || 'Failed to retrieve Meta Ads dashboard analytics',
        code: 'DASHBOARD_RETRIEVAL_FAILED',
      },
    });
  }
}
