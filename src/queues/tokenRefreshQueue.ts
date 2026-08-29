import { Queue, Worker } from 'bullmq';
import prisma from '../config/db';
import { runBypassingTenant } from '../utils/tenant-context';
import { decrypt } from '../utils/encryption';
import { refreshLongLivedToken } from '../modules/meta/meta.service';
import { logger } from '../utils/logger';
import { redisConnection } from '../utils/redis';

const connection = redisConnection;
const enableMeta = process.env.ENABLE_META_WORKER === 'true';

export const tokenRefreshQueue = (enableMeta && process.env.ENABLE_TOKEN_REFRESH_WORKER === 'true')
  ? new Queue('token-refresh', {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    })
  : null;

export let tokenRefreshWorker: Worker | undefined = undefined;

if (enableMeta && process.env.ENABLE_TOKEN_REFRESH_WORKER === 'true') {
  const drainDelay = parseInt(process.env.TOKEN_REFRESH_WORKER_DRAIN_DELAY || '60', 10);
  const stalledInterval = parseInt(process.env.TOKEN_REFRESH_WORKER_STALLED_INTERVAL || '900000', 10);

  tokenRefreshWorker = new Worker(
    'token-refresh',
    async (job) => {
      logger.info('TokenRefreshWorker', `Processing job: ${job.name}`);

      if (job.name === 'refresh-meta-tokens') {
        await runBypassingTenant(async () => {
          const tenDaysFromNow = new Date();
          tenDaysFromNow.setDate(tenDaysFromNow.getDate() + 10);

          // Fetch all clients whose tokens expire within 10 days
          const expiringClients = await prisma.client.findMany({
            where: {
              metaAccessToken: { not: null },
              metaTokenStatus: { not: 'DISCONNECTED' },
              isDeleted: false,
              OR: [
                { tokenExpiresAt: { lte: tenDaysFromNow } },
                { metaTokenStatus: 'ERROR' }, // Retry clients that were previously errored
              ],
            },
          });

          logger.info('TokenRefreshWorker', `Found ${expiringClients.length} client(s) requiring token refresh.`);

          for (const client of expiringClients) {
            try {
              // Validate token is present and decryptable
              if (!client.metaAccessToken) {
                logger.warn('TokenRefreshWorker', 'Client has no access token, marking DISCONNECTED', {
                  clientId: client.id,
                });
                await prisma.client.update({
                  where: { id: client.id },
                  data: { metaTokenStatus: 'DISCONNECTED' },
                });
                continue;
              }

              const currentToken = decrypt(client.metaAccessToken);

              // Check if already expired (not just expiring)
              if (client.tokenExpiresAt && new Date() > client.tokenExpiresAt) {
                logger.warn('TokenRefreshWorker', 'Token already expired. Attempting refresh anyway.', {
                  clientId: client.id,
                  expiredAt: client.tokenExpiresAt.toISOString(),
                });
                await prisma.client.update({
                  where: { id: client.id },
                  data: { metaTokenStatus: 'EXPIRED' },
                });
              }

              // Perform real token refresh via Graph API
              logger.info('TokenRefreshWorker', 'Refreshing Meta token via Graph API', { clientId: client.id });
              const newExpiry = await refreshLongLivedToken(client.id, currentToken);

              logger.info('TokenRefreshWorker', 'Token refresh SUCCESS', {
                clientId: client.id,
                newExpiry: newExpiry.toISOString(),
              });
            } catch (refreshError: any) {
              logger.error('TokenRefreshWorker', 'Token refresh FAILED', {
                clientId: client.id,
                error: refreshError.message,
              });

              // Mark as ERROR so it's retried in the next cron run
              await prisma.client.update({
                where: { id: client.id },
                data: { metaTokenStatus: 'ERROR' },
              }).catch(() => {});
            }
          }

          logger.info('TokenRefreshWorker', 'Token refresh cron job completed.');
        });
      }
    },
    {
      connection: connection as any,
      drainDelay,
      stalledInterval,
    }
  );

  // ─── Worker event logging ──────────────────────────────────────────────────────
  tokenRefreshWorker.on('completed', (job) => {
    logger.info('TokenRefreshWorker', `Job ${job.id} completed`);
  });

  tokenRefreshWorker.on('failed', (job, err) => {
    logger.error('TokenRefreshWorker', `Job ${job?.id} failed`, { error: err.message });
  });

  tokenRefreshWorker.on('error', (err) => {
    logger.error('TokenRefreshWorker', 'Worker error', { error: err.message });
  });
}

// ─── Schedule Daily Cron at 02:00 ─────────────────────────────────────────────
export async function scheduleTokenRefresh() {
  if (!tokenRefreshQueue) {
    logger.info('TokenRefreshQueue', 'Daily token refresh cron not scheduled (queue is disabled)');
    return;
  }
  try {
    await tokenRefreshQueue.add(
      'refresh-meta-tokens',
      {},
      {
        repeat: { pattern: '0 2 * * *' },
        jobId: 'meta-token-refresh-cron',
      }
    );
    logger.info('TokenRefreshQueue', 'Daily repeatable token refresh scheduled successfully (cron: 0 2 * * *)');
  } catch (err: any) {
    logger.error('TokenRefreshQueue', 'Failed to schedule token refresh job', { error: err.message });
  }
}

