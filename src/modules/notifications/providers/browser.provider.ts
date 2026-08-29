import { NotificationProvider, NotificationPayload } from './notification.provider';
import { logger } from '../../../utils/logger';

export class BrowserProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    logger.info('BrowserProvider', `[SIMULATED BROWSER PUSH] Push alert for Client ${payload.clientId}: "${payload.title}" - ${payload.message}`);
  }
}
