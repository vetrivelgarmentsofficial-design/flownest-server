import { Queue, Worker } from 'bullmq';
import prisma from '../config/db';
import { runBypassingTenant } from '../utils/tenant-context';
import { sendTrialReminder } from '../modules/auth/email.service';
import { logger } from '../utils/logger';
import { redisConnection } from '../utils/redis';

const connection = redisConnection;
const enableMeta = process.env.ENABLE_META_WORKER === 'true';

// --- Queue Setup ---
export const trialExpiryQueue = (enableMeta && process.env.ENABLE_TRIAL_WORKER === 'true')
  ? new Queue('trial-expiry', {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    })
  : null;

// --- Worker Setup ---
export let trialExpiryWorker: Worker | undefined = undefined;

if (enableMeta && process.env.ENABLE_TRIAL_WORKER === 'true') {
  const drainDelay = parseInt(process.env.TRIAL_EXPIRY_WORKER_DRAIN_DELAY || '60', 10);
  const stalledInterval = parseInt(process.env.TRIAL_EXPIRY_WORKER_STALLED_INTERVAL || '900000', 10);

  trialExpiryWorker = new Worker(
    'trial-expiry',
    async (job) => {
      logger.info('TrialExpiryWorker', `Running background trial verification job: ${job.name}`);

      if (job.name === 'check-expiring-trials') {
        await runBypassingTenant(async () => {
          const now = new Date();

          // 1. Fetch all agencies in TRIAL state that are not yet marked as expired
          const trialAgencies = await prisma.agency.findMany({
            where: {
              subscriptionStatus: 'TRIAL',
              isTrialExpired: false,
            },
          });

          logger.info('TrialExpiryWorker', `Found ${trialAgencies.length} active trial agencies to inspect.`);

          for (const agency of trialAgencies) {
            try {
              if (!agency.trialEndDate) continue;

              const trialEnd = new Date(agency.trialEndDate);
              
              // Normalize dates to calculate clean day differences (midnight to midnight)
              const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const endMidnight = new Date(trialEnd.getFullYear(), trialEnd.getMonth(), trialEnd.getDate());
              
              const timeDiff = endMidnight.getTime() - todayMidnight.getTime();
              const daysRemaining = Math.ceil(timeDiff / (24 * 60 * 60 * 1000));

              logger.info('TrialExpiryWorker', `Checking agency ${agency.name} (${agency.email}) - Days remaining: ${daysRemaining}`);

              if (daysRemaining <= 0) {
                // --- TRIAL EXPIRED ---
                logger.warn('TrialExpiryWorker', `Agency trial has expired: ${agency.name} (ended: ${agency.trialEndDate})`);
                
                await prisma.$transaction(async (tx) => {
                  // Update status
                  await tx.agency.update({
                    where: { id: agency.id },
                    data: {
                      isTrialExpired: true,
                      subscriptionStatus: 'EXPIRED',
                    },
                  });

                  // Invalidate all active refresh tokens for the agency users & client users
                  await tx.refreshToken.deleteMany({
                    where: { agencyId: agency.id },
                  });
                });

                // Send email reminder (0 days remaining = expired template)
                await sendTrialReminder(agency.name, agency.email, 0);

                logger.info('TrialExpiryWorker', `Successfully expired trial and revoked tokens for ${agency.name}`);
              } else if (daysRemaining === 7 || daysRemaining === 3 || daysRemaining === 1) {
                // --- SEND REMINDER EMAILS ---
                logger.info('TrialExpiryWorker', `Sending ${daysRemaining}-day trial reminder email for ${agency.name}`);
                await sendTrialReminder(agency.name, agency.email, daysRemaining);
              }
            } catch (err: any) {
              logger.error('TrialExpiryWorker', `Failed to check trial status for agency ${agency.name} (${agency.id})`, {
                error: err.message,
              });
            }
          }
        });
      }
    },
    {
      connection: connection as any,
      drainDelay,
      stalledInterval,
    }
  );

  // Logging
  trialExpiryWorker.on('completed', (job) => {
    logger.info('TrialExpiryWorker', `Job ${job.id} completed successfully`);
  });

  trialExpiryWorker.on('failed', (job, err) => {
    logger.error('TrialExpiryWorker', `Job ${job?.id} failed`, { error: err.message });
  });

  trialExpiryWorker.on('error', (err) => {
    logger.error('TrialExpiryWorker', 'System error encountered inside worker', { error: err.message });
  });
}


/**
 * Registers the repeatable daily trial sweep job.
 */
export async function scheduleDailyTrialSweep() {
  if (!trialExpiryQueue) {
    logger.info('TrialExpiryQueue', 'Daily trial sweep cron not scheduled (queue is disabled)');
    return;
  }
  try {
    // Register repeatable job at 01:00 AM daily
    await trialExpiryQueue.add(
      'check-expiring-trials',
      {},
      {
        repeat: { pattern: '0 1 * * *' },
        jobId: 'daily-trial-sweep',
      }
    );
    logger.info('TrialExpiryQueue', 'Daily repeatable trial sweep scheduled successfully (cron: 0 1 * * *)');
  } catch (err: any) {
    logger.error('TrialExpiryQueue', 'Failed to schedule daily trial sweep job', { error: err.message });
  }
}
