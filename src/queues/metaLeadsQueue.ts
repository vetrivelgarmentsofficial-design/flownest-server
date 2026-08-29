import { Queue, Worker } from 'bullmq';
import prisma from '../config/db';
import { runBypassingTenant } from '../utils/tenant-context';
import { decrypt } from '../utils/encryption';
import { getIo } from '../sockets';
import { emitLeadNew } from '../sockets/leadEvents';
import { logger } from '../utils/logger';
import { redisConnection } from '../utils/redis';

const connection = redisConnection;

// ─── Primary Meta Leads Queue ────────────────────────────────────────────────
export const metaLeadsQueue = process.env.ENABLE_META_WORKER === 'true'
  ? new Queue('meta-leads', {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s, 40s, 80s
        },
        removeOnComplete: { count: 200 },
        removeOnFail: false, // Keep failed jobs for DLQ transfer
      },
    })
  : null;

// ─── Dead Letter Queue ────────────────────────────────────────────────────────
export const metaLeadsFailedQueue = process.env.ENABLE_META_WORKER === 'true'
  ? new Queue('meta-leads-failed', {
      connection: connection as any,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    })
  : null;

// ─── Main Worker ─────────────────────────────────────────────────────────────
// ─── Main Worker ─────────────────────────────────────────────────────────────
export let metaLeadsWorker: Worker | undefined = undefined;

if (process.env.ENABLE_META_WORKER === 'true') {
  const drainDelay = parseInt(process.env.META_LEADS_WORKER_DRAIN_DELAY || '30', 10);
  const stalledInterval = parseInt(process.env.META_LEADS_WORKER_STALLED_INTERVAL || '300000', 10);

  metaLeadsWorker = new Worker(
    'meta-leads',
    async (job) => {
      const { leadgenId, clientId, formId, pageId } = job.data;
      const attempt = job.attemptsMade + 1;

      logger.info('MetaLeadsWorker', `Processing job: ${job.name} (attempt ${attempt}/5)`, {
        jobId: job.id,
        clientId,
        pageId,
        formId,
        leadgenId,
        attempt,
      });

      if (job.name === 'process-lead') {
        await runBypassingTenant(async () => {
          // 1. Fetch client and validate token
          const client = await prisma.client.findUnique({
            where: { id: clientId },
          });

          if (!client || client.isDeleted || !client.metaAccessToken) {
            throw new Error(`Client ${clientId} not found, is deleted, or Meta token is missing.`);
          }

          // 2. Decrypt access token
          const accessToken = decrypt(client.metaAccessToken);
          logger.info('MetaLeadsWorker', 'Token decrypted. Fetching lead from Graph API.', {
            clientId,
            leadgenId,
          });

          // 3. Fetch lead details from Facebook Graph API
          const graphUrl = new URL(`https://graph.facebook.com/v20.0/${leadgenId}`);
          graphUrl.searchParams.set('fields', 'full_name,email,phone_number,field_data,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,page_id,page_name');
          graphUrl.searchParams.set('access_token', accessToken);

          let leadData: {
            id: string;
            full_name?: string;
            email?: string;
            phone_number?: string;
            field_data?: Array<{ name: string; values: string[] }>;
            created_time?: string;
            campaign_id?: string;
            campaign_name?: string;
            adset_id?: string;
            adset_name?: string;
            ad_id?: string;
            ad_name?: string;
            form_id?: string;
            page_id?: string;
            page_name?: string;
          };

          try {
            const graphRes = await fetch(graphUrl.toString());
            if (!graphRes.ok) {
              const errBody = await graphRes.text();
              throw new Error(`Graph API error: ${errBody}`);
            }
            leadData = await graphRes.json() as typeof leadData;
            logger.info('MetaLeadsWorker', 'Graph API lead data received', { clientId, leadgenId });
          } catch (fetchErr: any) {
            logger.error('MetaLeadsWorker', 'Graph API request failed', {
              clientId,
              leadgenId,
              error: fetchErr.message,
              attempt,
            });
            throw fetchErr;
          }

          // 4. Extract fields from field_data array (custom form fields)
          const fieldMap: Record<string, string> = {};
          if (leadData.field_data) {
            for (const field of leadData.field_data) {
              fieldMap[field.name.toLowerCase()] = field.values?.[0] || '';
            }
          }

          const name = leadData.full_name || fieldMap['full_name'] || fieldMap['name'] || `Meta Lead ${leadgenId.slice(0, 8)}`;
          const email = leadData.email || fieldMap['email'] || fieldMap['email_address'] || null;
          const phone = leadData.phone_number || fieldMap['phone_number'] || fieldMap['phone'] || null;

          // 5. Upsert lead (prevents duplicate processing via unique metaLeadId)
          const lead = await prisma.lead.upsert({
            where: { metaLeadId: leadgenId },
            update: {}, // Already exists — skip duplicate
            create: {
              clientId: client.id,
              agencyId: client.agencyId,
              metaLeadId: leadgenId,
              name,
              email,
              phone,
              source: 'facebook_lead_ad',
              leadSource: 'META_ADS',
              stage: 'NEW',
              campaignName: leadData.campaign_name || null,
              pageName: leadData.page_name || client.metaPageName || null,
              adAccountName: client.metaAdAccountName || null,
              metaCreatedAt: leadData.created_time ? new Date(leadData.created_time) : null,
              customFields: {
                adId: leadData.ad_id || null,
                adName: leadData.ad_name || null,
                adsetId: leadData.adset_id || null,
                adsetName: leadData.adset_name || null,
                campaignId: leadData.campaign_id || null,
                formId: leadData.form_id || null,
                pageId: leadData.page_id || null,
              } as any
            },
          });

          const isNew = !lead.updatedAt || lead.createdAt.getTime() === lead.updatedAt.getTime();
          if (!isNew) {
            logger.info('MetaLeadsWorker', 'Duplicate lead skipped (already exists)', {
              clientId,
              leadgenId,
              leadId: lead.id,
            });
            return;
          }

          logger.info('MetaLeadsWorker', 'Lead saved to database', {
            clientId,
            leadgenId,
            leadId: lead.id,
          });

          // Trigger Notification Engine (decoupled via queue)
          try {
            const { publishLeadCreated } = require('../modules/notifications/notification.service');
            await publishLeadCreated(lead.id, client.id);
          } catch (notifErr: any) {
            logger.warn('MetaLeadsWorker', 'Failed to publish lead creation notification to queue', { error: notifErr.message });
          }

          // 6. Update client last sync timestamp + token status
          await prisma.client.update({
            where: { id: clientId },
            data: {
              metaLastSyncAt: new Date(),
              metaTokenStatus: 'CONNECTED',
            },
          });

          // 7. Emit real-time Socket.IO event to client dashboard
          try {
            const io = getIo();
            emitLeadNew(io, client.id, {
              lead,
              leadId: lead.id,
              name: lead.name,
              phone: lead.phone,
              source: lead.source,
              stage: lead.stage,
            });
            logger.info('MetaLeadsWorker', 'Socket.IO lead:new event emitted', { clientId, leadId: lead.id });
          } catch (socketError: any) {
            logger.error('MetaLeadsWorker', 'Socket.IO emission failed (non-fatal)', {
              clientId,
              error: socketError.message,
            });
          }

          // 8. Write audit log
          try {
            // Find any assigned user to attribute the audit entry to (system action)
            const systemUser = await prisma.user.findFirst({
              where: { agencyId: client.agencyId, role: 'agency_admin' },
            });

            if (systemUser) {
              await prisma.activityLog.create({
                data: {
                  leadId: lead.id,
                  userId: systemUser.id,
                  clientId: client.id,
                  agencyId: client.agencyId,
                  action: 'lead_created_from_meta',
                  newValue: JSON.stringify({ source: 'facebook_lead_ad', leadgenId }),
                },
              });
              logger.info('MetaLeadsWorker', 'Audit log written', { clientId, leadId: lead.id });
            }
          } catch (auditError: any) {
            logger.error('MetaLeadsWorker', 'Audit log write failed (non-fatal)', {
              clientId,
              error: auditError.message,
            });
          }
        });
      }

      if (job.name === 'sync-leads') {
        await runBypassingTenant(async () => {
          const activeClients = await prisma.client.findMany({
            where: {
              metaAccessToken: { not: null },
              metaTokenStatus: 'CONNECTED',
              isDeleted: false,
            },
          });

          logger.info('MetaLeadsWorker', `Cron sync started for ${activeClients.length} connected clients`);

          for (const client of activeClients) {
            try {
              const accessToken = decrypt(client.metaAccessToken!);

              // In production: paginate through missed leads since metaLastSyncAt
              // using /me/leadgen_forms?fields=leads{...}&since=TIMESTAMP
              logger.info('MetaLeadsWorker', 'Cron sync processing client', { clientId: client.id });

              await prisma.client.update({
                where: { id: client.id },
                data: { metaLastSyncAt: new Date() },
              });
            } catch (syncError: any) {
              logger.error('MetaLeadsWorker', 'Cron sync failed for client', {
                clientId: client.id,
                error: syncError.message,
              });

              await prisma.client.update({
                where: { id: client.id },
                data: { metaTokenStatus: 'ERROR' },
              }).catch(() => {});
            }
          }

          logger.info('MetaLeadsWorker', 'Cron sync completed');
        });
      }
    },
    {
      connection: connection as any,
      drainDelay,
      stalledInterval,
    }
  );

  // ─── Worker Event Logging & DLQ Handler ───────────────────────────────────────
  metaLeadsWorker.on('completed', (job) => {
    logger.info('MetaLeadsWorker', `Job ${job.id} completed successfully`, { jobId: job.id });
  });

  metaLeadsWorker.on('failed', async (job, err) => {
    logger.error('MetaLeadsWorker', `Job ${job?.id} failed`, {
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: err.message,
    });

    if (!job) return;

    try {
      // Only move to DLQ after all retries are exhausted
      const attemptsLimit = job.opts.attempts ?? 5;
      if (job.attemptsMade < attemptsLimit) return;

      logger.error('MetaLeadsDLQ', 'Job exhausted all retries. Moving to dead letter queue.', {
        jobId: job.id,
        clientId: job.data?.clientId,
        leadgenId: job.data?.leadgenId,
        error: err.message,
      });

      if (metaLeadsFailedQueue) {
        await metaLeadsFailedQueue.add('dead-letter', {
          originalJobId: job.id,
          jobName: job.name,
          clientId: job.data?.clientId,
          leadgenId: job.data?.leadgenId,
          pageId: job.data?.pageId,
          formId: job.data?.formId,
          errorMessage: err.message,
          failedAt: new Date().toISOString(),
        });
      } else {
        logger.error('MetaLeadsDLQ', 'Could not move job to Dead Letter Queue: metaLeadsFailedQueue is disabled.');
      }
    } catch (dlqError: any) {
      logger.error('MetaLeadsDLQ', 'Failed to move job to dead letter queue', { error: dlqError.message });
    }
  });

  metaLeadsWorker.on('error', (err) => {
    logger.error('MetaLeadsWorker', 'Worker encountered an error', { error: err.message });
  });
}

// ─── Schedule 6-hour cron sync ────────────────────────────────────────────────
export async function scheduleMetaSync() {
  if (!metaLeadsQueue) {
    logger.info('MetaLeadsQueue', 'Meta sync cron not scheduled (queue is disabled)');
    return;
  }
  try {
    await metaLeadsQueue.add(
      'sync-leads',
      {},
      {
        repeat: { pattern: '0 */6 * * *' },
        jobId: 'meta-sync-cron',
      }
    );
    logger.info('MetaLeadsQueue', 'Repeatable 6-hour Meta sync scheduled successfully (cron: 0 */6 * * *)');
  } catch (err: any) {
    logger.error('MetaLeadsQueue', 'Failed to schedule sync-leads cron', { error: err.message });
  }
}

