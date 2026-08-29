import { Queue, Worker } from 'bullmq';
import prisma from '../config/db';
import { runBypassingTenant } from '../utils/tenant-context';
import { getIo } from '../sockets';
import { emitFollowUpDue } from '../sockets/leadEvents';
import { redisConnection } from '../utils/redis';

const connection = redisConnection;
const enableMeta = process.env.ENABLE_META_WORKER === 'true';

export const notificationsQueue = (enableMeta && process.env.ENABLE_NOTIFICATION_WORKER === 'true')
  ? new Queue('notifications', {
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

export let notificationsWorker: Worker | undefined = undefined;

if (enableMeta && process.env.ENABLE_NOTIFICATION_WORKER === 'true') {
  const drainDelay = parseInt(process.env.NOTIFICATIONS_WORKER_DRAIN_DELAY || '60', 10);
  const stalledInterval = parseInt(process.env.NOTIFICATIONS_WORKER_STALLED_INTERVAL || '300000', 10);

  notificationsWorker = new Worker(
    'notifications',
    async (job) => {
      console.log(`[Queue Worker] Processing job: ${job.name} (id: ${job.id})`);

      if (job.name === 'send-reminder') {
        const { followUpId } = job.data;

        await runBypassingTenant(async () => {
          // Fetch follow up and lead details
          const followUp = await prisma.followUp.findUnique({
            where: { id: followUpId },
            include: { lead: true },
          });

          if (!followUp) {
            console.warn(`[Reminder Worker] FollowUp ID ${followUpId} not found. Skipping.`);
            return;
          }

          // Only send reminder if still pending
          if (followUp.status !== 'pending') {
            console.log(`[Reminder Worker] FollowUp ID ${followUpId} is already status: ${followUp.status}. Skipping alert.`);
            return;
          }

          const lead = followUp.lead;

          // Simulate sending email reminder
          console.log('--------------------------------------------------');
          console.log(`✉️ [EMAIL NOTIFICATION] SENDING REMINDER`);
          console.log(`To: Agency/Client Staff`);
          console.log(`Subject: [FlowNest CRM] Follow-up due for lead: ${lead.name}`);
          console.log(`Body: Hello! You have a scheduled follow-up reminder.`);
          console.log(`Lead Name: ${lead.name}`);
          console.log(`Scheduled Time: ${followUp.scheduledAt}`);
          console.log(`Note: ${followUp.note || 'No note attached'}`);
          console.log('--------------------------------------------------');

          // Emit Socket.IO follow_up:due notification if lead is assigned to a user
          if (lead.assignedTo) {
            try {
              const io = getIo();
              emitFollowUpDue(io, lead.assignedTo, {
                followUpId: followUp.id,
                leadId: followUp.leadId,
                note: followUp.note,
              });
            } catch (socketError: any) {
              console.error('[Reminder Worker Error] Failed to emit follow_up:due socket event:', socketError.message);
            }
          }

          // Optional: Update follow-up status to indicate reminder was sent (or keep pending)
          // Let's keep it pending so user can mark it as done manually, but we log successful execution
          console.log(`[Reminder Worker] Successfully sent follow-up reminder for Lead: ${lead.name}`);
        });
      }
    },
    {
      connection: connection as any,
      drainDelay,
      stalledInterval,
    }
  );
}

