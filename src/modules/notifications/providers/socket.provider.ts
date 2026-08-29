import { NotificationProvider, NotificationPayload } from './notification.provider';
import { getIo } from '../../../sockets';
import { logger } from '../../../utils/logger';

export class SocketProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    logger.info('SocketProvider', 'Broadcasting socket event', { clientId: payload.clientId });
    try {
      const io = getIo();
      io.to(`client:${payload.clientId}`).emit('notification:new', {
        title: payload.title,
        message: payload.message,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.warn('SocketProvider', `Failed to emit socket notification: ${err.message}`);
    }
  }
}
