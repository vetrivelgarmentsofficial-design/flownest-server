import { Request, Response, NextFunction } from 'express';
import prisma from '../../config/db';
import { runWithTenantContext } from '../../utils/tenant-context';
import { generateGoogleOAuthUrl } from '../google-sheets/googleOAuth.service';
import * as googleController from '../google-sheets/googleSheets.controller';

const db = prisma as any;

/**
 * Middleware wrapper to run a Google Sheets controller handler in the target client's tenant context.
 * Authenticates that the target client belongs to the agency admin's agency,
 * then maps the req.user.tenantId and runs with client's tenant scope context.
 */
function runInClientContext(handler: Function) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = req.params.clientId; // from route parameter :clientId
      const agencyId = req.user?.tenantId;

      if (!agencyId) {
        res.status(403).json({ success: false, error: 'Agency context missing.' });
        return;
      }

      // Verify client belongs to this agency
      const client = await db.client.findFirst({
        where: { id: clientId, agencyId },
      });

      if (!client) {
        res.status(403).json({ success: false, error: 'Access denied: Client does not belong to this agency.' });
        return;
      }

      // Temporarily override req.user details so controller reads target client ID
      const originalUser = req.user;
      req.user = {
        ...originalUser,
        tenantId: clientId,
        tenantType: 'client',
      } as any;

      // Run within the target client's context
      await runWithTenantContext({ clientId }, async () => {
        await handler(req, res, next);
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Custom handler to connect Google account for client, passing 'agency' role to OAuth URL state.
 */
export async function connectGoogleForClient(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.params.clientId;
    const agencyId = req.user?.tenantId;

    if (!agencyId) {
      res.status(403).json({ success: false, error: 'Agency context missing.' });
      return;
    }

    const client = await db.client.findFirst({
      where: { id: clientId, agencyId },
    });

    if (!client) {
      res.status(403).json({ success: false, error: 'Access denied: Client does not belong to this agency.' });
      return;
    }

    const oauthUrl = await generateGoogleOAuthUrl(clientId, 'agency');
    res.status(200).json({
      success: true,
      data: { oauthUrl },
    });
  } catch (error) {
    next(error);
  }
}

// Export wrapped versions of the standard client-scoped controller functions
export const getSpreadsheets = runInClientContext(googleController.getSpreadsheets);
export const getSheetsInSpreadsheet = runInClientContext(googleController.getSheetsInSpreadsheet);
export const getSheetHeaders = runInClientContext(googleController.getSheetHeaders);
export const getConnections = runInClientContext(googleController.getConnections);
export const createConnection = runInClientContext(googleController.createConnection);
export const updateConnection = runInClientContext(googleController.updateConnection);
export const deleteConnection = runInClientContext(googleController.deleteConnection);
export const saveMappings = runInClientContext(googleController.saveMappings);
export const syncNow = runInClientContext(googleController.syncNow);
export const getSyncHistory = runInClientContext(googleController.getSyncHistory);
export const getGoogleStatus = runInClientContext(googleController.getGoogleStatus);
export const connectByUrl = runInClientContext(googleController.connectByUrl);
export const disconnectGoogleForClient = runInClientContext(googleController.disconnectGoogle);
