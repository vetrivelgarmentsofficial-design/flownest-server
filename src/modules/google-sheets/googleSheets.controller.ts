import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/db';
import {
  generateGoogleOAuthUrl,
  verifyGoogleOAuthState,
  exchangeCodeForTokens,
  refreshGoogleToken,
} from './googleOAuth.service';
import { fetchUserSpreadsheets } from './googleDrive.service';
import { fetchSpreadsheetTabs, fetchSheetValues, fetchSpreadsheetMetadata } from './spreadsheet.service';
import { saveColumnMappings, getMappingsForConnection } from './spreadsheetMapping.service';
import { syncSpreadsheetLeads } from './spreadsheetSync.service';
import { logger } from '../../utils/logger';
import { extractSpreadsheetId } from './spreadsheetUrl.utils';

const db = prisma as any;

// --- Zod Validation Schemas ---
const createConnectionSchema = z.object({
  spreadsheetId: z.string().min(1, 'Spreadsheet ID is required'),
  spreadsheetName: z.string().min(1, 'Spreadsheet Name is required'),
  sheetName: z.string().min(1, 'Sheet Name is required'),
  syncInterval: z.number().int().min(30).max(86400).default(300),
  sheetUrl: z.string().url('Invalid URL format').optional().nullable(),
});

const saveMappingsSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
  mappings: z.array(
    z.object({
      crmField: z.string().min(1),
      sheetColumn: z.string().min(1),
    })
  ),
});

const syncNowSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
});

const updateConnectionSchema = z.object({
  syncEnabled: z.boolean().optional(),
  syncInterval: z.number().int().min(30).max(86400).optional(),
  sheetName: z.string().min(1).optional(),
});

/**
 * Initiates the Google OAuth flow by redirecting the user to the consent screen.
 */
export async function connectGoogle(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const oauthUrl = await generateGoogleOAuthUrl(clientId);
    res.status(200).json({
      success: true,
      data: { oauthUrl },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Public endpoint handling the Google OAuth callback.
 * Decodes the state JWT token to retrieve tenant context.
 */
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code || !state) {
      res.status(400).json({ success: false, error: 'Callback missing code or state parameter.' });
      return;
    }

    // Resolve tenant clientId and role using JWT state verification
    const { clientId, role } = await verifyGoogleOAuthState(state);

    await exchangeCodeForTokens(code, clientId);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    
    // Redirect based on the initiating user's role
    if (role === 'agency') {
      res.redirect(`${frontendUrl}/agency/clients/${clientId}?google_connected=true`);
    } else {
      res.redirect(`${frontendUrl}/client/integrations/google-sheets?google_connected=true`);
    }
  } catch (error) {
    logger.error('GoogleSheetsController', 'OAuth Callback Failed', { error });
    next(error);
  }
}

/**
 * Returns the list of Spreadsheets from user's Google Drive.
 */
export async function getSpreadsheets(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const connection = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (!connection) {
      res.status(400).json({ success: false, error: 'Google Account not connected.' });
      return;
    }

    let spreadsheets;
    try {
      spreadsheets = await fetchUserSpreadsheets(connection.accessToken);
    } catch (err: any) {
      const isAuthError =
        err.status === 401 ||
        err.message?.includes('401') ||
        err.message?.toLowerCase().includes('unauthorized') ||
        err.message?.toLowerCase().includes('invalid_grant') ||
        err.message?.toLowerCase().includes('invalid credentials');

      if (isAuthError && connection.refreshToken) {
        logger.info('GoogleSheetsController', 'Access token rejected in getSpreadsheets. Refreshing...', { clientId });
        const newAccessToken = await refreshGoogleToken(clientId, connection.refreshToken);
        spreadsheets = await fetchUserSpreadsheets(newAccessToken);
      } else {
        throw err;
      }
    }
    res.status(200).json({
      success: true,
      data: spreadsheets,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns the tabs/sheets inside a spreadsheet.
 */
export async function getSheetsInSpreadsheet(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const spreadsheetId = req.params.id;

    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const connection = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (!connection) {
      res.status(400).json({ success: false, error: 'Google Account not connected.' });
      return;
    }

    let tabs;
    try {
      tabs = await fetchSpreadsheetTabs(spreadsheetId, connection.accessToken);
    } catch (err: any) {
      const isAuthError =
        err.status === 401 ||
        err.message?.includes('401') ||
        err.message?.toLowerCase().includes('unauthorized') ||
        err.message?.toLowerCase().includes('invalid_grant') ||
        err.message?.toLowerCase().includes('invalid credentials');

      if (isAuthError && connection.refreshToken) {
        logger.info('GoogleSheetsController', 'Access token rejected in getSheetsInSpreadsheet. Refreshing...', { clientId });
        const newAccessToken = await refreshGoogleToken(clientId, connection.refreshToken);
        tabs = await fetchSpreadsheetTabs(spreadsheetId, newAccessToken);
      } else {
        throw err;
      }
    }
    res.status(200).json({
      success: true,
      data: tabs,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Configures / creates a Spreadsheet Connection configuration.
 * Automatically schedules background repeatable sync.
 */
export async function createConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const { spreadsheetId, spreadsheetName, sheetName, syncInterval, sheetUrl } = createConnectionSchema.parse(req.body);

    // Save connection
    const connection = await db.spreadsheetConnection.create({
      data: {
        clientId,
        spreadsheetId,
        spreadsheetName,
        sheetName,
        syncInterval,
        sheetUrl,
        syncEnabled: true,
      },
    });

    res.status(201).json({
      success: true,
      data: connection,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Saves column mappings.
 */
export async function saveMappings(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const { connectionId, mappings } = saveMappingsSchema.parse(req.body);

    // Verify connection ownership
    const connection = await db.spreadsheetConnection.findFirst({
      where: { id: connectionId, clientId },
    });

    if (!connection) {
      res.status(404).json({ success: false, error: 'Spreadsheet connection not found.' });
      return;
    }

    const saved = await saveColumnMappings(clientId, connectionId, mappings);

    // Trigger first-time lead sync immediately
    try {
      logger.info('GoogleSheetsController', 'Triggering first-time sync for connection', { connectionId });
      await syncSpreadsheetLeads(connectionId);
    } catch (syncErr: any) {
      logger.error('GoogleSheetsController', 'First-time sync failed (ignored)', { error: syncErr.message });
    }

    res.status(200).json({
      success: true,
      data: saved,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Executes a manual spreadsheet sync immediately.
 */
export async function syncNow(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const { connectionId } = syncNowSchema.parse(req.body);

    const connection = await db.spreadsheetConnection.findFirst({
      where: { id: connectionId, clientId },
    });

    if (!connection) {
      res.status(404).json({ success: false, error: 'Spreadsheet connection not found.' });
      return;
    }

    const stats = await syncSpreadsheetLeads(connectionId);
    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns spreadsheet sync/import logs history.
 */
export async function getSyncHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    // Fetches history (automatic client ID tenant filter)
    const history = await db.spreadsheetImportHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Updates Spreadsheet sync config properties.
 * Re-schedules repeatable jobs depending on settings updates.
 */
export async function updateConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const connectionId = req.params.id;

    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const updates = updateConnectionSchema.parse(req.body);

    const existing = await db.spreadsheetConnection.findFirst({
      where: { id: connectionId, clientId },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Spreadsheet connection not found.' });
      return;
    }

    const updated = await db.spreadsheetConnection.update({
      where: { id: connectionId },
      data: updates,
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Deletes / Disconnects Spreadsheet config connection and its repeatable sync schedule.
 */
export async function deleteConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const connectionId = req.params.id;

    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const existing = await db.spreadsheetConnection.findFirst({
      where: { id: connectionId, clientId },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Spreadsheet connection not found.' });
      return;
    }

    // Delete record from database
    await db.spreadsheetConnection.delete({
      where: { id: connectionId },
    });


    res.status(200).json({
      success: true,
      data: { message: 'Spreadsheet connection removed successfully.' },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns list of SpreadsheetConnections.
 */
export async function getConnections(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const connections = await db.spreadsheetConnection.findMany({
      where: { clientId },
      include: { mappings: true },
    });

    res.status(200).json({
      success: true,
      data: connections,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns Google Connection details.
 */
export async function getGoogleStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const connection = await db.googleConnection.findFirst({
      where: { clientId },
      select: { googleEmail: true, id: true, createdAt: true },
    });

    res.status(200).json({
      success: true,
      data: connection,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Returns column header values from the first row of a sheet.
 */
export async function getSheetHeaders(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const { id: spreadsheetId, sheetName } = req.params;

    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const connection = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (!connection) {
      res.status(400).json({ success: false, error: 'Google Account not connected.' });
      return;
    }

    let rows;
    try {
      rows = await fetchSheetValues(spreadsheetId, sheetName, connection.accessToken);
    } catch (err: any) {
      const isAuthError =
        err.status === 401 ||
        err.message?.includes('401') ||
        err.message?.toLowerCase().includes('unauthorized') ||
        err.message?.toLowerCase().includes('invalid_grant') ||
        err.message?.toLowerCase().includes('invalid credentials');

      if (isAuthError && connection.refreshToken) {
        logger.info('GoogleSheetsController', 'Access token rejected in getSheetHeaders. Refreshing...', { clientId });
        const newAccessToken = await refreshGoogleToken(clientId, connection.refreshToken);
        rows = await fetchSheetValues(spreadsheetId, sheetName, newAccessToken);
      } else {
        throw err;
      }
    }
    const headers = rows && rows.length > 0 ? rows[0] : [];

    res.status(200).json({
      success: true,
      data: headers,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Resolves a Google Spreadsheet URL, validates it, extracts the spreadsheet ID,
 * and fetches the metadata (title and sheet tabs list) using user's Google tokens.
 */
export async function connectByUrl(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    const { sheetUrl } = z.object({
      sheetUrl: z.string().url('Invalid URL format').min(1, 'Sheet URL is required'),
    }).parse(req.body);

    const spreadsheetId = extractSpreadsheetId(sheetUrl);

    const connection = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (!connection) {
      res.status(400).json({ success: false, error: 'Google Account not connected.' });
      return;
    }

    // Call Google Sheets API to fetch metadata
    let metadata;
    try {
      metadata = await fetchSpreadsheetMetadata(spreadsheetId, connection.accessToken);
    } catch (err: any) {
      const isAuthError =
        err.status === 401 ||
        err.message?.includes('401') ||
        err.message?.toLowerCase().includes('unauthorized') ||
        err.message?.toLowerCase().includes('invalid_grant') ||
        err.message?.toLowerCase().includes('invalid credentials');

      if (isAuthError && connection.refreshToken) {
        logger.info('GoogleSheetsController', 'Access token rejected in connectByUrl. Refreshing...', { clientId });
        const newAccessToken = await refreshGoogleToken(clientId, connection.refreshToken);
        metadata = await fetchSpreadsheetMetadata(spreadsheetId, newAccessToken);
      } else {
        throw err;
      }
    }

    res.status(200).json({
      success: true,
      data: {
        spreadsheetId,
        spreadsheetName: metadata.name,
        sheets: metadata.sheets,
      },
    });
  } catch (error: any) {
    next(error);
  }
}

/**
 * Disconnects the user's Google account completely.
 * 1. Stops all repeatable BullMQ sync jobs.
 * 2. Revokes the Google OAuth credentials token (ignores failure).
 * 3. Deletes GoogleConnection and all related spreadsheet connections/mappings/histories in a transaction.
 */
export async function disconnectGoogle(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, error: 'Client context missing.' });
      return;
    }

    logger.info('GoogleDisconnect', 'Starting disconnect flow for client', { clientId });



    // 2. Retrieve google connection credentials to revoke OAuth token
    const googleConn = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (googleConn) {
      const tokenToRevoke = googleConn.refreshToken || googleConn.accessToken;
      if (tokenToRevoke) {
        logger.info('GoogleDisconnect', `Revoking OAuth token for email ${googleConn.googleEmail}`);
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
          logger.info('GoogleDisconnect', 'Successfully revoked Google access token');
        } catch (revokeErr: any) {
          logger.warn('GoogleDisconnect', 'Failed to revoke Google access token (ignored)', { error: revokeErr.message });
        }
      }
    } else {
      logger.info('GoogleDisconnect', 'No active Google Connection found to revoke token');
    }

    // 3. Delete all database records inside a Prisma transaction
    logger.info('GoogleDisconnect', 'Starting database deletion transaction');
    await db.$transaction(async (tx: any) => {
      logger.info('GoogleDisconnect', 'Deleting spreadsheet import histories');
      await tx.spreadsheetImportHistory.deleteMany({
        where: { clientId },
      });

      logger.info('GoogleDisconnect', 'Deleting spreadsheet column mappings');
      await tx.spreadsheetColumnMapping.deleteMany({
        where: { clientId },
      });

      logger.info('GoogleDisconnect', 'Deleting spreadsheet connections');
      await tx.spreadsheetConnection.deleteMany({
        where: { clientId },
      });

      logger.info('GoogleDisconnect', 'Deleting Google connection record');
      await tx.googleConnection.deleteMany({
        where: { clientId },
      });
    });

    logger.info('GoogleDisconnect', 'Successfully completed Google account disconnect flow', { clientId });

    res.status(200).json({
      success: true,
      message: 'Google account disconnected successfully',
    });
  } catch (error) {
    logger.error('GoogleDisconnect', 'Critical failure during disconnect flow', { error });
    next(error);
  }
}


