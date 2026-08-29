import { NotificationProvider, NotificationPayload } from './notification.provider';
import prisma from '../../../config/db';
import { sendTelegramMessage } from '../../telegram/telegram.service';
import { markRecipientInactive } from '../../telegram/telegram.repository';
import { decrypt } from '../../../utils/encryption';
import { runBypassingTenant } from '../../../utils/tenant-context';
import { logger } from '../../../utils/logger';

export class TelegramProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    const { clientId, integrationId, chatId, message, title, recipientId } = payload;

    if (!chatId) {
      throw new Error('Telegram chatId is required to send notification');
    }

    if (!integrationId) {
      throw new Error('Telegram integrationId is required to send notification');
    }

    await runBypassingTenant(async () => {
      // 1. Fetch Telegram Integration for the specific bot connection
      const integration = await prisma.telegramIntegration.findUnique({
        where: { id: integrationId },
      });

      if (!integration || !integration.isConnected) {
        throw new Error(`Telegram integration ${integrationId} not configured or disabled`);
      }

      // 3. Decrypt token
      const botToken = decrypt(integration.botToken);

      // 4. Send Message
      logger.info('TelegramProvider', 'Sending message', { chatId, clientId });
      const result = await sendTelegramMessage(botToken, chatId, message);

      if (!result.success) {
        const errorMsg = result.body || 'Unknown Telegram API error';
        
        // Log failure to NotificationLog
        await prisma.notificationLog.create({
          data: {
            clientId,
            channel: 'TELEGRAM',
            recipient: chatId,
            title: title || 'New Lead Alert',
            message,
            status: 'FAILED',
            error: `Status: ${result.status}, Body: ${errorMsg}`,
          },
        });

        // Handle blocked bot (403)
        if (result.status === 403) {
          logger.warn('TelegramProvider', 'User blocked the bot. Marking recipient inactive.', { chatId, clientId });
          await markRecipientInactive(integrationId, chatId);
          return; // Do not throw, no retry needed for blocked users
        }

        // Handle rate limit (429) or Server error (5xx)
        if (result.status === 429 || (result.status && result.status >= 500)) {
          throw new Error(`Telegram transient error (${result.status}): ${errorMsg}`);
        }

        // Bad request / Invalid chatId (400)
        if (result.status === 400) {
          logger.error('TelegramProvider', 'Telegram bad request (400) - check chatId', { chatId, errorMsg });
          return; // Do not throw to avoid infinite retries on invalid chatId
        }

        throw new Error(`Telegram message delivery failed: ${errorMsg}`);
      }

      // Log success to NotificationLog
      await prisma.notificationLog.create({
        data: {
          clientId,
          channel: 'TELEGRAM',
          recipient: chatId,
          title: title || 'New Lead Alert',
          message,
          status: 'SENT',
        },
      });

      logger.info('TelegramProvider', 'Message sent successfully', { chatId, clientId });
    });
  }
}
