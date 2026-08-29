import cron from 'node-cron';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';
import { getIo } from '../../sockets';
import { emitLeadStageChanged } from '../../sockets/leadEvents';

let isRunning = false;

/**
 * Periodically reviews Proposal, F1, and F2 leads and advances them if inactive.
 */
export async function runPipelineAutomation(): Promise<void> {
  if (isRunning) {
    logger.warn('PipelineAutomation', 'Previous automation run is still active. Skipping this trigger.');
    return;
  }

  isRunning = true;
  logger.info('PipelineAutomation', 'Scheduled lead inactivity auto-move task started.');

  try {
    const now = new Date();

    // Query active leads in NEGOTIATION (Proposal), FOLLOW_UP (F1), and QUALIFIED (F2) stages
    // Bypassing multi-tenancy context since this scheduler sweeps globally.
    const leads = await runBypassingTenant(async () => {
      return prisma.lead.findMany({
        where: {
          stage: { in: ['NEGOTIATION', 'FOLLOW_UP', 'QUALIFIED'] },
          status: 'ACTIVE',
        },
      });
    });

    logger.info('PipelineAutomation', `Sweeping ${leads.length} active leads for inactivity...`);

    for (const lead of leads) {
      try {
        const customFields = (lead.customFields as any) || {};
        
        // If lastActivityAt is missing, use updatedAt
        const lastActivityAtStr = customFields.lastActivityAt || lead.updatedAt.toISOString();
        const lastActivityAt = new Date(lastActivityAtStr);
        const diffMs = now.getTime() - lastActivityAt.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        let nextStage: 'FOLLOW_UP' | 'QUALIFIED' | 'LOST' | null = null;
        let transitionReason = '';

        if (lead.stage === 'NEGOTIATION') {
          // If Proposal (NEGOTIATION) inactive for 24+ hours
          if (diffHours >= 24) {
            nextStage = 'FOLLOW_UP';
            transitionReason = 'Automatically moved to Follow Up (F1)\nNo activity detected after 24 hours.';
          }
        } else if (lead.stage === 'FOLLOW_UP') {
          // If Follow Up F1 (FOLLOW_UP) inactive for 48+ hours
          if (diffHours >= 48) {
            nextStage = 'QUALIFIED';
            transitionReason = 'Automatically moved to Follow Up (F2)\nNo activity detected.';
          }
        } else if (lead.stage === 'QUALIFIED') {
          // If Follow Up F2 (QUALIFIED) inactive for 72+ hours
          if (diffHours >= 72) {
            nextStage = 'LOST';
            transitionReason = 'Automatically moved to Follow Up (F3)\nNo activity detected.';
          }
        }

        if (nextStage) {
          logger.info('PipelineAutomation', `Auto-advancing lead ${lead.id} (${lead.name}): ${lead.stage} -> ${nextStage}. Inactivity: ${diffHours.toFixed(1)} hrs.`);

          await runBypassingTenant(async () => {
            await prisma.$transaction(async (tx) => {
              // Fetch a default user associated with the tenant to assign the activity log to
              const defaultUser = await tx.user.findFirst({
                where: { clientId: lead.clientId },
              });
              const systemUserId = defaultUser?.id || lead.assignedTo;

              if (!systemUserId) {
                logger.warn('PipelineAutomation', `Could not find a valid user context for client ${lead.clientId} to log auto-move activities. Skipping.`);
                return;
              }

              // Update customFields: reset lastActivityAt so the next countdown starts from this auto-move
              const updatedCustomFields = {
                ...customFields,
                lastActivityAt: now.toISOString(),
                lastActivityType: 'Auto-Move to ' + nextStage,
                autoMovedAt: now.toISOString(),
              };

              // 1. Update lead stage and customFields
              await tx.lead.update({
                where: { id: lead.id },
                data: {
                  stage: nextStage,
                  customFields: updatedCustomFields,
                },
              });

              // 2. Create stage change activity log
              await tx.activityLog.create({
                data: {
                  leadId: lead.id,
                  userId: systemUserId,
                  clientId: lead.clientId,
                  agencyId: lead.agencyId,
                  action: 'stage_change',
                  oldValue: lead.stage,
                  newValue: nextStage,
                },
              });

              // 3. Create note activity log detailing the reason
              await tx.activityLog.create({
                data: {
                  leadId: lead.id,
                  userId: systemUserId,
                  clientId: lead.clientId,
                  agencyId: lead.agencyId,
                  action: 'note',
                  oldValue: null,
                  newValue: transitionReason,
                },
              });

              // 4. Emit live Socket.IO update
              try {
                const io = getIo();
                emitLeadStageChanged(io, lead.clientId, {
                  leadId: lead.id,
                  oldStage: lead.stage,
                  newStage: nextStage,
                });
              } catch (socketErr: any) {
                logger.warn('PipelineAutomation', 'Failed to emit socket stage change notification', { error: socketErr.message });
              }
            });
          });
        }
      } catch (leadErr: any) {
        logger.error('PipelineAutomation', `Failed to process automation for lead ${lead.id}`, { error: leadErr.message });
      }
    }
  } catch (err: any) {
    logger.error('PipelineAutomation', 'Fatal error during pipeline automation run', { error: err.message });
  } finally {
    isRunning = false;
    logger.info('PipelineAutomation', 'Scheduled lead inactivity auto-move task completed.');
  }
}

/**
 * Starts the hourly cron job for pipeline automation.
 */
export function startPipelineAutomationScheduler(): void {
  const cronPattern = process.env.PIPELINE_AUTOMATION_CRON || '0 * * * *'; // runs every hour
  
  logger.info('PipelineAutomation', `Initializing pipeline automation cron with pattern: "${cronPattern}"`);

  cron.schedule(cronPattern, async () => {
    await runPipelineAutomation();
  });

  // Run a quick trigger 15 seconds after startup to ensure everything functions properly in dev
  setTimeout(() => {
    logger.info('PipelineAutomation', 'Triggering startup diagnostics scan...');
    runPipelineAutomation().catch((err) => {
      logger.error('PipelineAutomation', 'Startup diagnostics scan failed', { error: err.message });
    });
  }, 15000);
}
