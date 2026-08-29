import cron from 'node-cron';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { syncSpreadsheetLeads } from './spreadsheetSync.service';
import { logger } from '../../utils/logger';

const db = prisma as any;

// A simple in-memory lock to prevent concurrent cron executions from overlapping
let isSyncing = false;

/**
 * Initializes and starts the spreadsheet synchronization scheduler.
 * By default, this schedules a cron job to run every 15 minutes.
 */
export function startSpreadsheetScheduler() {
  const cronPattern = process.env.SPREADSHEET_SYNC_CRON || '*/15 * * * *';
  
  logger.info('SpreadsheetScheduler', `Initializing spreadsheet cron scheduler with pattern: "${cronPattern}"`);

  cron.schedule(cronPattern, async () => {
    if (isSyncing) {
      logger.warn('SpreadsheetScheduler', 'Previous synchronization run is still in progress. Skipping this schedule trigger to prevent overlapping.');
      return;
    }

    isSyncing = true;
    logger.info('SpreadsheetScheduler', 'Scheduled spreadsheet synchronization started.');

    try {
      // Fetch all spreadsheet connections where sync is enabled.
      // Bypasses multi-tenancy filter since it's a global system background cron job.
      const connections = await runBypassingTenant(async () => {
        return db.spreadsheetConnection.findMany({
          where: { syncEnabled: true },
          select: {
            id: true,
            spreadsheetName: true,
            sheetName: true,
            clientId: true,
          },
        });
      });

      logger.info('SpreadsheetScheduler', `Found ${connections.length} active spreadsheet connection(s) to process.`);

      for (const connection of connections) {
        try {
          logger.info('SpreadsheetScheduler', `Syncing connection for client ${connection.clientId}: ${connection.spreadsheetName} (Tab: ${connection.sheetName})`);
          
          const stats = await syncSpreadsheetLeads(connection.id);
          
          logger.info('SpreadsheetScheduler', `Successfully synced connection ${connection.id}`, { ...stats });
        } catch (syncErr: any) {
          logger.error('SpreadsheetScheduler', `Failed to sync connection ${connection.id}`, {
            error: syncErr.message,
            stack: syncErr.stack,
          });
        }
      }
    } catch (err: any) {
      logger.error('SpreadsheetScheduler', 'Fatal error encountered in spreadsheet scheduler run', {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      isSyncing = false;
      logger.info('SpreadsheetScheduler', 'Scheduled spreadsheet synchronization completed.');
    }
  });
}
