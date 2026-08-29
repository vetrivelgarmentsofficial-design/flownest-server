import prisma from '../../config/db';
import { logger } from '../../utils/logger';
import { runBypassingTenant } from '../../utils/tenant-context';
import { SocketProvider } from './providers/socket.provider';
import { TelegramProvider } from './providers/telegram.provider';

/**
 * Sends notifications directly (Socket + Telegram) for a newly created lead.
 * Executed inside runBypassingTenant since this is called in background contexts / threads.
 */
export async function sendLeadCreatedNotificationsDirectly(leadId: string, clientId: string): Promise<void> {
  await runBypassingTenant(async () => {
    logger.info('NotificationService', 'Executing direct notification delivery for lead', { leadId, clientId });

    // 1. Fetch lead details
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      logger.warn('NotificationService', `Lead ID ${leadId} not found. Skipping notifications.`);
      return;
    }

    // 2. Fetch or lazy-create notification preferences
    let preference = await prisma.notificationPreference.findUnique({
      where: { clientId },
    });

    if (!preference) {
      preference = await prisma.notificationPreference.create({
        data: { clientId, telegramEnabled: false },
      });
    }

    const title = 'New Lead Alert';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const crmLink = `${frontendUrl}/client/leads/${lead.id}`;

    // Format Message (Markdown support)
    const formattedMessage = 
      `🔔 *New Lead Received!*\n\n` +
      `👤 *Name:* ${lead.name || 'N/A'}\n` +
      `📞 *Phone:* ${lead.phone || 'N/A'}\n` +
      `📧 *Email:* ${lead.email || 'N/A'}\n` +
      `📍 *Source:* ${lead.source || 'N/A'}\n` +
      `🕒 *Time:* ${new Date(lead.createdAt).toLocaleString()}\n\n` +
      `👉 [Open in FlowNest CRM](${crmLink})`;

    // 3. Trigger Socket push notification (Browser live alerts)
    try {
      await new SocketProvider().send({
        clientId,
        title,
        message: `New Lead: ${lead.name} (${lead.source || 'Manual'})`,
        leadId: lead.id,
      });
    } catch (sockErr: any) {
      logger.warn('NotificationService', 'Socket notification failed', { error: sockErr.message });
    }

    // 4. Trigger Telegram alerts if preference is enabled
    if (preference.telegramEnabled) {
      const recipients = await prisma.telegramRecipient.findMany({
        where: { clientId, isActive: true },
      });

      logger.info('NotificationService', `Sending Telegram notifications directly to ${recipients.length} recipients`, { clientId, leadId });

      const telegramProvider = new TelegramProvider();
      
      // Dispatch notifications asynchronously in parallel
      await Promise.allSettled(
        recipients.map(async (recipient) => {
          try {
            await telegramProvider.send({
              clientId,
              integrationId: recipient.integrationId,
              recipientId: recipient.id,
              chatId: recipient.chatId,
              message: formattedMessage,
              title,
              leadId: lead.id,
            });
          } catch (telErr: any) {
            logger.error('NotificationService', 'Telegram direct alert failed for recipient', {
              chatId: recipient.chatId,
              error: telErr.message,
            });
          }
        })
      );
    }
  });
}

/**
 * Publishes a lead creation notification event.
 * Dispatches the event directly and asynchronously using setImmediate to avoid blocking DB transactions.
 */
export async function publishLeadCreated(leadId: string, clientId: string): Promise<boolean> {
  logger.info('NotificationService', 'Publishing lead:created notification event (direct execution)', { leadId, clientId });

  // Execute in the next tick of the event loop to ensure database transactions commit first.
  setImmediate(() => {
    sendLeadCreatedNotificationsDirectly(leadId, clientId).catch((err) => {
      logger.error('NotificationService', 'Asynchronous notification delivery failed', { error: err.message, leadId });
    });
  });

  return true;
}
