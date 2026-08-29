import { NotificationProvider, NotificationPayload } from './notification.provider';
import { logger } from '../../../utils/logger';

export class EmailProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    logger.info('EmailProvider', `[SIMULATED EMAIL] Sending notification to Client ${payload.clientId}: "${payload.title}" - ${payload.message}`);
  }
}
