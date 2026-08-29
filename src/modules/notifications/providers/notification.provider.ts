export interface NotificationPayload {
  clientId: string;
  integrationId?: string;
  title: string;
  message: string;
  leadId?: string;
  recipientId?: string;
  chatId?: string;
}

export interface NotificationProvider {
  send(payload: NotificationPayload): Promise<void>;
}
