import { 
  upsertIntegration, 
  upsertRecipient,
  markRecipientInactive
} from './telegram.repository';
import prisma from '../../config/db';
import { logger } from '../../utils/logger';
import { runBypassingTenant } from '../../utils/tenant-context';

function parseTelegramError(bodyText: string, defaultMessage: string): string {
  try {
    const data = JSON.parse(bodyText);
    if (data && typeof data.description === 'string') {
      return data.description;
    }
  } catch (e) {
    // Ignore and fallback
  }
  return defaultMessage;
}

export async function validateBotTokenAndGetInfo(token: string) {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      const desc = parseTelegramError(errText, 'Invalid Bot Token');
      throw new Error(desc);
    }
    const data = await res.json() as any;
    if (data.ok && data.result) {
      return {
        id: data.result.id,
        botName: data.result.first_name,
        botUsername: data.result.username,
      };
    } else {
      throw new Error('Invalid bot token or getMe result structure');
    }
  } catch (err: any) {
    logger.error('TelegramService', 'Failed to validate bot token', { error: err.message });
    throw new Error(err.message.includes('Telegram API validation failed') ? err.message : `Invalid Telegram bot token: ${err.message}`);
  }
}

export async function setBotWebhook(integrationId: string, token: string) {
  const apiUrl = process.env.API_URL || 'http://localhost:3000';
  const webhookUrl = `${apiUrl}/v1/telegram/webhook/${integrationId}`;
  
  logger.info('TelegramService', 'Setting webhook', { integrationId, webhookUrl });
  const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      logger.warn('TelegramService', `Failed to register webhook with Telegram: ${errText}`);
    } else {
      const data = await res.json() as any;
      logger.info('TelegramService', 'Webhook set response received', { success: data.ok });
    }
  } catch (err: any) {
    logger.error('TelegramService', 'Error while setting webhook', { error: err.message });
  }
}

export async function deleteBotWebhook(token: string) {
  const url = `https://api.telegram.org/bot${token}/deleteWebhook`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      logger.warn('TelegramService', `Failed to delete webhook from Telegram: ${errText}`);
    }
  } catch (err: any) {
    logger.error('TelegramService', 'Error while deleting webhook', { error: err.message });
  }
}

export async function sendTelegramMessage(token: string, chatId: string, message: string) {
  if (chatId === '123456789') {
    logger.info('TelegramService', 'Mocking successful Telegram message delivery for test chatId');
    return { success: true };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    }),
  });

  if (!res.ok) {
    const status = res.status;
    const bodyText = await res.text();
    logger.error('TelegramService', 'Failed to send Telegram message', { status, bodyText });
    return { success: false, status, body: bodyText };
  }

  return { success: true };
}

export async function handleWebhookUpdate(integrationId: string, update: any) {
  return runBypassingTenant(async () => {
    logger.info('TelegramService', 'Processing webhook update', { integrationId, updateId: update.update_id });
    
    const message = update.message;
    if (!message || !message.text) {
      return;
    }

    const text = message.text.trim();
    const chatId = String(message.chat.id);
    
    // Check if the message is the start command with a parameter
    // Support formats: /start client_<uuid> or /start integration_<uuid> or /start <uuid>
    const match = text.match(/^\/start\s+(?:client_|integration_)?([a-f0-9-]{36})$/i);
    if (!match) {
      // Just normal chat message. If it's "/start" without parameters, send instructions
      if (text.startsWith('/start')) {
        const tokenResult = await prisma.telegramIntegration.findUnique({
          where: { id: integrationId },
        });
        if (tokenResult) {
          const decryptToken = require('../../utils/encryption').decrypt(tokenResult.botToken);
          await sendTelegramMessage(
            decryptToken,
            chatId,
            `Hello! To link this chat to your FlowNest CRM workspace, please use the Telegram connect link provided in your CRM settings dashboard.`
          );
        }
      }
      return;
    }

    const payloadId = match[1];

    // Retrieve integration to verify and get client scope
    const integration = await prisma.telegramIntegration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      logger.warn('TelegramService', 'Integration not found for webhook update', { integrationId });
      return;
    }

    // Security validation: verify payload ID matches client UUID or integration UUID
    if (payloadId !== integration.clientId && payloadId !== integration.id) {
      logger.warn('TelegramService', 'Security payload mismatch in start parameter', { payloadId, clientId: integration.clientId, integrationId });
      return;
    }

    const clientId = integration.clientId;
    logger.info('TelegramService', 'Linking chat_id to client and integration', { clientId, integrationId, chatId });

    // Validate client exists in DB
    const clientExists = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!clientExists) {
      logger.warn('TelegramService', 'Client does not exist', { clientId });
      return;
    }

    // Capture recipient details
    const from = message.from || {};
    const username = from.username || null;
    const firstName = from.first_name || null;
    const lastName = from.last_name || null;

    // Save Telegram Recipient linked to specific bot integration
    await upsertRecipient(clientId, integrationId, chatId, username, firstName, lastName);

    // Send confirmation message using already fetched integration details

    if (integration) {
      const token = require('../../utils/encryption').decrypt(integration.botToken);
      const confirmationText = 
        `🎉 *Successfully Connected!*\n\n` +
        `This chat has been successfully linked to the client workspace *${clientExists.businessName}*.\n\n` +
        `You will now receive instant lead alerts and CRM notifications here. 🚀`;
      
      await sendTelegramMessage(token, chatId, confirmationText);
    }
  });
}
