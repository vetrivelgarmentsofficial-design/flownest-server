export interface TelegramIntegrationData {
  id: string;
  agencyId: string;
  botToken: string;
  botUsername: string;
  botName: string;
  isConnected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramRecipientData {
  id: string;
  clientId: string;
  chatId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isActive: boolean;
  connectedAt: Date;
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
    chat: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      type: string;
    };
    date: number;
    text?: string;
  };
}
