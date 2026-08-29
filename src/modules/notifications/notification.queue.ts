import { Queue, Worker } from 'bullmq';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { getIo } from '../../sockets';
import { emitFollowUpDue } from '../../sockets/leadEvents';
import { redisConnection } from '../../utils/redis';
import { logger } from '../../utils/logger';
import { TelegramProvider } from './providers/telegram.provider';
import { SocketProvider } from './providers/socket.provider';

const connection = redisConnection;

// Enable background tasks if worker flag is set
const enableWorker = process.env.ENABLE_META_WORKER === 'true';
const enableNotifications = process.env.ENABLE_NOTIFICATION_WORKER === 'true';

export const notificationsQueue = (enableWorker && enableNotifications)
  ? new Queue('notifications', {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 5, // Increased attempts for Telegram provider reliability
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s, 40s, 80s
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 }, // Retain failed jobs for analysis
      },
    })
  : null;

export let notificationsWorker: Worker | undefined = undefined;

if (enableWorker && enableNotifications) {
  const drainDelay = parseInt(process.env.NOTIFICATIONS_WORKER_DRAIN_DELAY || '60', 10);
  const stalledInterval = parseInt(process.env.NOTIFICATIONS_WORKER_STALLED_INTERVAL || '300000', 10);

  notificationsWorker = new Worker(
    'notifications',
    async (job) => {
      logger.info('NotificationsWorker', `Processing notification job: ${job.name} (id: ${job.id})`);

      // ─── 1. Existing Follow-up Reminders Logic ───
      if (job.name === 'send-reminder') {
        const { followUpId } = job.data;

        await runBypassingTenant(async () => {
          const followUp = await prisma.followUp.findUnique({
            where: { id: followUpId },
            include: { lead: true },
          });

          if (!followUp) {
            logger.warn('NotificationsWorker', `FollowUp ID ${followUpId} not found. Skipping.`);
            return;
          }

          if (followUp.status !== 'pending') {
            logger.info('NotificationsWorker', `FollowUp ID ${followUpId} status is ${followUp.status}. Skipping alert.`);
            return;
          }

          const lead = followUp.lead;

          // Simulated email remainder
          console.log('--------------------------------------------------');
          console.log(`✉️ [EMAIL NOTIFICATION] SENDING REMINDER`);
          console.log(`To: Agency/Client Staff`);
          console.log(`Subject: [FlowNest CRM] Follow-up due for lead: ${lead.name}`);
          console.log(`Body: Hello! You have a scheduled follow-up reminder.`);
          console.log(`Lead Name: ${lead.name}`);
          console.log(`Scheduled Time: ${followUp.scheduledAt}`);
          console.log(`Note: ${followUp.note || 'No note attached'}`);
          console.log('--------------------------------------------------');

          if (lead.assignedTo) {
            try {
              const io = getIo();
              emitFollowUpDue(io, lead.assignedTo, {
                followUpId: followUp.id,
                leadId: followUp.leadId,
                note: followUp.note,
              });
            } catch (socketError: any) {
              logger.error('NotificationsWorker', 'Failed to emit follow_up:due socket event', { error: socketError.message });
            }
          }

          logger.info('NotificationsWorker', `Successfully sent follow-up reminder for Lead: ${lead.name}`);
        });
      }

      // ─── 2. New Lead Event Handler ───
      else if (job.name === 'notify-lead-created') {
        const { leadId, clientId } = job.data;

        await runBypassingTenant(async () => {
          // Fetch lead details
          const lead = await prisma.lead.findUnique({
            where: { id: leadId },
          });

          if (!lead) {
            logger.warn('NotificationsWorker', `Lead ID ${leadId} not found. Skipping notifications.`);
            return;
          }

          // Fetch preferences
          let preference = await prisma.notificationPreference.findUnique({
            where: { clientId },
          });

          if (!preference) {
            // Lazy create defaults
            preference = await prisma.notificationPreference.create({
              data: { clientId, telegramEnabled: false },
            });
          }

          const title = 'New Lead Alert';
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
          const crmLink = `${frontendUrl}/client/leads/${lead.id}`;

          // Format Notification Message (Markdown support)
          const formattedMessage = 
            `🔔 *New Lead Received!*\n\n` +
            `👤 *Name:* ${lead.name || 'N/A'}\n` +
            `📞 *Phone:* ${lead.phone || 'N/A'}\n` +
            `📧 *Email:* ${lead.email || 'N/A'}\n` +
            `📍 *Source:* ${lead.source || 'N/A'}\n` +
            `🕒 *Time:* ${new Date(lead.createdAt).toLocaleString()}\n\n` +
            `👉 [Open in FlowNest CRM](${crmLink})`;

          // Trigger real-time socket push notification provider (Browser popup simulation)
          try {
            await new SocketProvider().send({
              clientId,
              title,
              message: `New Lead: ${lead.name} (${lead.source || 'Manual'})`,
              leadId: lead.id,
            });
          } catch (sockErr: any) {
            logger.warn('NotificationsWorker', 'Socket notification failed', { error: sockErr.message });
          }

          // Trigger Telegram integration if enabled
          if (preference.telegramEnabled) {
            const recipients = await prisma.telegramRecipient.findMany({
              where: { clientId, isActive: true },
            });

            logger.info('NotificationsWorker', `Enqueuing Telegram notifications for ${recipients.length} recipients`, { clientId, leadId });

            for (const recipient of recipients) {
              await notificationsQueue?.add(
                'send-telegram-notification',
                {
                  clientId,
                  integrationId: recipient.integrationId,
                  recipientId: recipient.id,
                  chatId: recipient.chatId,
                  message: formattedMessage,
                  title,
                  leadId: lead.id,
                },
                {
                  jobId: `telegram-${leadId}-${recipient.chatId}-${recipient.integrationId}`, // Avoid duplicate alerts per recipient chat per bot
                }
              );
            }
          }
        });
      }

      // ─── 3. Specific Telegram Dispatch Job ───
      else if (job.name === 'send-telegram-notification') {
        const { clientId, integrationId, chatId, message, title, recipientId } = job.data;
        const provider = new TelegramProvider();
        await provider.send({ clientId, integrationId, chatId, message, title, recipientId });
      }
    },
    {
      connection: connection as any,
      drainDelay,
      stalledInterval,
    }
  );
}
