export interface ConnectBotDTO {
  botToken: string;
}

export interface TelegramBotStatusResponse {
  isConnected: boolean;
  botName?: string;
  botUsername?: string;
  botUrl?: string;
}

export interface TelegramClientStatusResponse {
  isConnected: boolean;
  telegramEnabled: boolean;
  botUsername?: string;
  botUrl?: string;
  recipientsCount: number;
  recipients: Array<{
    id: string;
    chatId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
    connectedAt: string;
  }>;
}
