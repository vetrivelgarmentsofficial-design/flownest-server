import { NotificationProvider, NotificationPayload } from './notification.provider';
import { logger } from '../../../utils/logger';

export class WhatsappProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    logger.info('WhatsappProvider', `[SIMULATED WHATSAPP] Sending message for Client ${payload.clientId}: "${payload.message}"`);
  }
}
