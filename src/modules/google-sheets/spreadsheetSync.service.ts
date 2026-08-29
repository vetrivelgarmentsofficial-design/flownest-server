import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';
import { fetchSheetValues } from './spreadsheet.service';
import { refreshGoogleToken } from './googleOAuth.service';
import { getIo } from '../../sockets';
import { emitLeadNew } from '../../sockets/leadEvents';

const db = prisma as any;

export interface SyncResult {
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
}

/**
 * Runs spreadsheet lead synchronization for a specific connection.
 * Bypasses standard multi-tenancy filter because it is invoked inside background workers.
 */
export async function syncSpreadsheetLeads(connectionId: string): Promise<SyncResult> {
  return runBypassingTenant(async () => {
    logger.info('SpreadsheetSync', 'Starting spreadsheet synchronization job', { connectionId });
    const startedAt = new Date();

    // 1. Fetch connection, client, mappings and google credentials
    const connection = await db.spreadsheetConnection.findUnique({
      where: { id: connectionId },
      include: {
        client: {
          include: {
            googleConnections: true,
          },
        },
        mappings: true,
      },
    });

    if (!connection) {
      console.warn(`[Sync] Connection ${connectionId} no longer exists`);
      throw new Error(`Spreadsheet Connection ${connectionId} not found.`);
    }


    const client = connection.client;
    const googleConn = client.googleConnections[0];

    if (!googleConn) {
      throw new Error(`Google connection credentials missing for Client ${client.id}`);
    }

    let rows: string[][] = [];
    let headers: string[] = [];
    let dataRows: string[][] = [];

    const isIncremental = connection.lastProcessedRow > 0;

    const fetchValuesWithRetry = async (range?: string) => {
      try {
        return await fetchSheetValues(connection.spreadsheetId, connection.sheetName, googleConn.accessToken, range);
      } catch (err: any) {
        const isAuthError =
          err.status === 401 ||
          err.message?.includes('401') ||
          err.message?.toLowerCase().includes('unauthorized') ||
          err.message?.toLowerCase().includes('invalid_grant') ||
          err.message?.toLowerCase().includes('invalid credentials');

        if (isAuthError) {
          logger.info('SpreadsheetSync', 'Access token rejected. Refreshing access token.', { clientId: client.id });
          const newAccessToken = await refreshGoogleToken(client.id, googleConn.refreshToken);
          return await fetchSheetValues(connection.spreadsheetId, connection.sheetName, newAccessToken, range);
        } else {
          throw err;
        }
      }
    };

    try {
      if (isIncremental) {
        // Fetch headers (A1:Z1)
        const escapedSheetName = connection.sheetName.replace(/'/g, "''");
        const headerRange = `'${escapedSheetName}'!A1:Z1`;
        const headerRows = await fetchValuesWithRetry(headerRange);
        if (!headerRows || headerRows.length === 0) {
          throw new Error('Could not fetch spreadsheet headers');
        }
        headers = headerRows[0].map((h: string) => h.trim().toLowerCase());

        // Fetch only new rows starting at lastProcessedRow + 2
        const startRowIdx = connection.lastProcessedRow + 2;
        const dataRange = `'${escapedSheetName}'!A${startRowIdx}:Z`;
        dataRows = await fetchValuesWithRetry(dataRange);
      } else {
        // Full Sync: Fetch everything
        const allRows = await fetchValuesWithRetry();
        if (allRows && allRows.length > 0) {
          headers = allRows[0].map((h: string) => h.trim().toLowerCase());
          dataRows = allRows.slice(1);
        }
      }
    } catch (fetchErr: any) {
      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      await db.spreadsheetSyncLog.create({
        data: {
          spreadsheetConnectionId: connectionId,
          startedAt,
          completedAt,
          totalRows: 0,
          insertedRows: 0,
          updatedRows: 0,
          duplicateRows: 0,
          failedRows: 1,
          duration,
          status: 'FAILED',
          errorMessage: fetchErr.message || 'Failed to fetch spreadsheet rows',
        },
      });
      throw fetchErr;
    }

    if (!dataRows || dataRows.length === 0) {
      logger.info('SpreadsheetSync', 'No new rows to process', { connectionId });
      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      const stats = { totalRows: 0, importedRows: 0, duplicateRows: 0, failedRows: 0, updatedRows: 0 };
      
      await createImportHistory(client.id, connectionId, stats, connection.spreadsheetName, connection.sheetName);
      
      await db.spreadsheetSyncLog.create({
        data: {
          spreadsheetConnectionId: connectionId,
          startedAt,
          completedAt,
          totalRows: 0,
          insertedRows: 0,
          updatedRows: 0,
          duplicateRows: 0,
          failedRows: 0,
          duration,
          status: 'SUCCESS',
        },
      });

      await db.spreadsheetConnection.update({
        where: { id: connectionId },
        data: { lastSyncAt: new Date() },
      });

      return stats;
    }

    // 3. Map sheet headers to column index mapping
    const mappings = connection.mappings;
    const fieldColumnIndices: Record<string, number> = {};
    for (const mapping of mappings) {
      const index = headers.indexOf(mapping.sheetColumn.trim().toLowerCase());
      if (index !== -1) {
        fieldColumnIndices[mapping.crmField] = index;
      }
    }

    let importedRows = 0;
    let duplicateRows = 0;
    let failedRows = 0;
    let updatedRows = 0;

    // Find a system user context for activity logs
    const systemUser = await prisma.user.findFirst({
      where: { agencyId: client.agencyId, role: 'agency_admin' },
    });

    // 4. Process each row
    for (const row of dataRows) {
      try {
        const getFieldValue = (field: string): string | null => {
          const index = fieldColumnIndices[field];
          if (index !== undefined && row[index] !== undefined) {
            return row[index].trim();
          }
          return null;
        };

        const name = getFieldValue('name') || getFieldValue('customer name') || `Google Sheet Lead`;
        const email = getFieldValue('email') || getFieldValue('email address');
        const phone = getFieldValue('phone') || getFieldValue('mobile number') || getFieldValue('phone number');
        const source = getFieldValue('source') || getFieldValue('campaign') || 'google_sheets';
        const city = getFieldValue('city') || getFieldValue('town') || getFieldValue('city name');

        // Validate lead has at least some details
        if (!name && !email && !phone) {
          failedRows++;
          continue;
        }

        const leadName = name.substring(0, 255);
        const leadEmail = email ? email.substring(0, 255) : null;
        const leadPhone = phone ? phone.substring(0, 30) : null;
        const leadSource = source.substring(0, 255);
        const leadCity = city ? city.substring(0, 255) : null;

        // Custom fields extraction
        const customFields: Record<string, string> = {};
        for (const mapping of mappings) {
          const index = fieldColumnIndices[mapping.crmField];
          if (index !== undefined && row[index] !== undefined) {
            customFields[mapping.crmField] = row[index].trim();
          }
        }

        // Deduplicate lead by phone or email separately
        let existingLead = null;
        if (leadPhone) {
          existingLead = await prisma.lead.findFirst({
            where: { clientId: client.id, phone: leadPhone },
          });
        }
        if (!existingLead && leadEmail) {
          existingLead = await prisma.lead.findFirst({
            where: { clientId: client.id, email: leadEmail },
          });
        }

        let syncType: 'CREATED' | 'UPDATED' | 'DUPLICATE' = 'CREATED';
        let lead;
        let oldDataJson: any = null;
        let newDataJson: any = null;

        if (existingLead) {
          // Check if there are changes to trigger an update
          const existingCustomFields = existingLead.customFields || {};
          const hasChanges =
            existingLead.name !== leadName ||
            existingLead.city !== leadCity ||
            existingLead.source !== leadSource ||
            JSON.stringify(existingCustomFields) !== JSON.stringify(customFields);

          if (hasChanges) {
            syncType = 'UPDATED';
            oldDataJson = {
              name: existingLead.name,
              city: existingLead.city,
              source: existingLead.source,
              customFields: existingCustomFields,
            };
            newDataJson = {
              name: leadName,
              city: leadCity,
              source: leadSource,
              customFields,
            };

            lead = await prisma.lead.update({
              where: { id: existingLead.id },
              data: {
                name: leadName,
                city: leadCity,
                source: leadSource,
                customFields: customFields as any,
              },
            });
            updatedRows++;

            // Emit Socket event: lead:updated
            try {
              const io = getIo();
              io.to(`client:${client.id}`).emit('lead:updated', {
                leadId: lead.id,
                name: lead.name,
                phone: lead.phone,
                source: lead.source,
                stage: lead.stage,
              });
            } catch (socketErr) {
              logger.error('SpreadsheetSync', 'Failed to emit socket lead:updated', { socketErr });
            }

            // Log activity
            if (systemUser) {
              await prisma.activityLog.create({
                data: {
                  leadId: lead.id,
                  userId: systemUser.id,
                  clientId: client.id,
                  agencyId: client.agencyId,
                  action: 'lead_updated_from_google_sheets',
                  oldValue: JSON.stringify(oldDataJson),
                  newValue: JSON.stringify(newDataJson),
                },
              });
            }
          } else {
            syncType = 'DUPLICATE';
            lead = existingLead;
            duplicateRows++;
          }
        } else {
          // Create new Lead
          syncType = 'CREATED';
          newDataJson = {
            name: leadName,
            email: leadEmail,
            phone: leadPhone,
            source: leadSource,
            city: leadCity,
            customFields,
          };

          lead = await prisma.lead.create({
            data: {
              clientId: client.id,
              agencyId: client.agencyId,
              name: leadName,
              email: leadEmail,
              phone: leadPhone,
              source: leadSource,
              city: leadCity,
              stage: 'NEW',
              leadSource: 'GOOGLE_SHEETS',
              status: 'ACTIVE',
              createdBy: 'SYSTEM',
              customFields: customFields as any,
            },
          });
          importedRows++;

          // Trigger Notification Engine (decoupled via queue)
          try {
            const { publishLeadCreated } = require('../notifications/notification.service');
            await publishLeadCreated(lead.id, client.id);
          } catch (notifErr: any) {
            logger.warn('SpreadsheetSync', 'Failed to publish lead creation notification to queue', { error: notifErr.message });
          }

          // Emit Socket event: lead:new (includes full lead object for optimistic UI update)
          try {
            const io = getIo();
            console.log(`[Socket] Emitting lead:new for client ${client.id}`, lead.id);
            emitLeadNew(io, client.id, {
              lead,
              leadId: lead.id,
              name: lead.name,
              phone: lead.phone,
              source: 'GOOGLE_SHEETS',
              stage: lead.stage,
            });
          } catch (socketErr) {
            logger.error('SpreadsheetSync', 'Failed to emit socket lead:new', { socketErr });
          }

          // Log activity
          if (systemUser) {
            await prisma.activityLog.create({
              data: {
                leadId: lead.id,
                userId: systemUser.id,
                clientId: client.id,
                agencyId: client.agencyId,
                action: 'imported_from_google_sheets',
                newValue: JSON.stringify({
                  message: 'Lead imported automatically from Google Sheets.',
                  spreadsheetId: connection.spreadsheetId,
                  spreadsheetName: connection.spreadsheetName,
                  sheetName: connection.sheetName,
                }),
              },
            });
          }
        }

        // Save Lead Sync History
        await db.leadSyncHistory.create({
          data: {
            leadId: lead.id,
            spreadsheetConnectionId: connectionId,
            syncType,
            oldData: oldDataJson ? (oldDataJson as any) : undefined,
            newData: newDataJson ? (newDataJson as any) : undefined,
          },
        });

      } catch (rowErr: any) {
        logger.error('SpreadsheetSync', 'Failed to sync row', { rowErr: rowErr.message });
        failedRows++;
      }
    }

    const stats = {
      totalRows: dataRows.length,
      importedRows,
      duplicateRows,
      failedRows,
      updatedRows,
    };

    // Update Spreadsheet Connection cursors
    const finalProcessedRow = connection.lastProcessedRow + dataRows.length;
    await db.spreadsheetConnection.update({
      where: { id: connectionId },
      data: {
        lastSyncAt: new Date(),
        lastProcessedRow: finalProcessedRow,
      },
    });

    // Save Sync Log
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    
    let status: 'SUCCESS' | 'FAILED' | 'PARTIAL_SUCCESS' = 'SUCCESS';
    if (failedRows > 0) {
      status = (importedRows > 0 || updatedRows > 0 || duplicateRows > 0) ? 'PARTIAL_SUCCESS' : 'FAILED';
    }

    await db.spreadsheetSyncLog.create({
      data: {
        spreadsheetConnectionId: connectionId,
        startedAt,
        completedAt,
        totalRows: dataRows.length,
        insertedRows: importedRows,
        updatedRows,
        duplicateRows,
        failedRows,
        duration,
        status,
      },
    });

    // 5. Save import sync logs history
    await createImportHistory(client.id, connectionId, stats, connection.spreadsheetName, connection.sheetName);

    logger.info('SpreadsheetSync', 'Spreadsheet synchronization completed', {
      connectionId,
      stats,
    });

    return stats;
  });
}

/**
 * Creates import history entry in the database.
 */
async function createImportHistory(
  clientId: string,
  connectionId: string,
  stats: SyncResult,
  spreadsheetName?: string,
  sheetTabName?: string
) {
  return db.spreadsheetImportHistory.create({
    data: {
      clientId,
      connectionId,
      totalRows: stats.totalRows,
      importedRows: stats.importedRows,
      duplicateRows: stats.duplicateRows,
      failedRows: stats.failedRows,
      spreadsheetName,
      sheetTabName,
    },
  });
}
