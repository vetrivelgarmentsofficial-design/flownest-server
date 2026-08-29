import { Request, Response, NextFunction } from 'express';
import { connectBotSchema, testConnectionSchema } from './telegram.validation';
import { 
  validateBotTokenAndGetInfo, 
  setBotWebhook, 
  deleteBotWebhook, 
  handleWebhookUpdate,
  sendTelegramMessage
} from './telegram.service';
import { 
  upsertIntegration, 
  getIntegrationsByClientId, 
  getIntegrationById,
  deleteIntegrationById,
  upsertPreference,
  getPreferenceByClientId,
  getRecipientsByClientId,
  deleteRecipientById,
  createIntegration,
  createRecipient,
  validateDuplicateChat
} from './telegram.repository';
import prisma from '../../config/db';
import { decrypt } from '../../utils/encryption';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';

/**
 * Agency Endpoint: Connect Telegram Bot
 */
export async function connectBot(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(400).json({
      success: false,
      data: null,
      error: { message: 'Agency-level bot connection is deprecated. Please configure Telegram bot under Client workspace settings.', code: 'DEPRECATED' }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Agency Endpoint: Get Bot Status
 */
export async function getBotStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({
      success: true,
      data: { isConnected: false },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Agency Endpoint: Disconnect Telegram Bot
 */
export async function disconnectBot(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({
      success: true,
      data: { isConnected: false },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Client Endpoint: Connect Client to Bot (Token + Chat ID Registration)
 */
export async function clientConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId || req.user?.tenantType !== 'client') {
      res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Forbidden. Only Client accounts can connect.', code: 'FORBIDDEN' },
      });
      return;
    }

    const { botToken, chatId, recipientName } = connectBotSchema.parse(req.body);

    // 1. Call Telegram getMe API to verify token validity
    const botInfo = await validateBotTokenAndGetInfo(botToken);

    // 2. Validate Chat ID by sending a welcome message
    const testMsgResult = await sendTelegramMessage(
      botToken,
      chatId,
      '✅ FlowNest CRM Telegram Integration Connected Successfully.'
    );

    if (!testMsgResult.success) {
      let errorDetail = 'Invalid Chat ID or Telegram communication error';
      try {
        const bodyObj = JSON.parse(testMsgResult.body || '{}');
        if (bodyObj.description) {
          errorDetail = bodyObj.description;
        }
      } catch (e) {
        if (testMsgResult.body) errorDetail = testMsgResult.body;
      }
      res.status(400).json({
        success: false,
        data: null,
        error: { message: `❌ ${errorDetail}`, code: 'TELEGRAM_ERROR' },
      });
      return;
    }

    // 3. Prevent duplicate Chat IDs for the same client
    const isDuplicate = await validateDuplicateChat(clientId, chatId);
    if (isDuplicate) {
      res.status(400).json({
        success: false,
        data: null,
        error: { message: '❌ Duplicate Chat ID already exists', code: 'DUPLICATE_CHAT_ID' },
      });
      return;
    }

    // 4. Save/upsert integration in DB
    const integration = await createIntegration(
      clientId,
      botToken,
      botInfo.botUsername,
      botInfo.botName
    );

    // 5. Create recipient with connectionMethod = MANUAL
    const recipient = await createRecipient(
      clientId,
      integration.id,
      chatId,
      null, // username
      null, // firstName
      null, // lastName
      'MANUAL',
      recipientName || null
    );

    // 6. Register optional webhook so that deep-linking auto-start still works for other users who start the bot on Telegram
    try {
      await setBotWebhook(integration.id, botToken);
    } catch (webhookErr: any) {
      logger.warn('TelegramController', 'Failed to register optional webhook during manual connect', { error: webhookErr.message });
    }

    // 7. Activate preferences
    await upsertPreference(clientId, true);

    res.status(200).json({
      success: true,
      message: 'Telegram bot connected successfully.',
      integration,
      recipient,
    });
  } catch (error: any) {
    const isValidationError = error.name === 'ZodError';
    const message = isValidationError 
      ? error.errors.map((e: any) => e.message).join(', ') 
      : error.message;

    res.status(400).json({
      success: false,
      data: null,
      error: { message: message.startsWith('❌') ? message : `❌ ${message}`, code: 'BAD_REQUEST' },
    });
  }
}

/**
 * Client Endpoint: Get Client Connection Status and Recipients
 */
export async function getClientStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }

    // Fetch preferences
    const preference = await getPreferenceByClientId(clientId);
    const telegramEnabled = preference ? preference.telegramEnabled : false;

    // Fetch client-specific integrations
    const integrations = await getIntegrationsByClientId(clientId);

    // Fetch all recipients for client
    const allRecipients = await getRecipientsByClientId(clientId);

    const integrationsData = integrations.map((integration: any) => {
      const integrationRecipients = allRecipients.filter(
        (r: any) => r.integrationId === integration.id
      );
      return {
        id: integration.id,
        botName: integration.botName,
        botUsername: integration.botUsername,
        botUrl: `https://t.me/${integration.botUsername}?start=integration_${integration.id}`,
        isConnected: integration.isConnected,
        recipientsCount: integrationRecipients.length,
        recipients: integrationRecipients.map((r: any) => ({
          id: r.id,
          chatId: r.chatId,
          username: r.username,
          firstName: r.firstName,
          lastName: r.lastName,
          recipientName: r.recipientName,
          connectionMethod: r.connectionMethod,
          isActive: r.isActive,
          connectedAt: r.connectedAt.toISOString(),
        })),
      };
    });

    res.status(200).json({
      success: true,
      data: {
        telegramEnabled,
        integrations: integrationsData,
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Client Endpoint: Disconnect Client Integration (Specific Bot)
 */
export async function clientDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const integrationId = req.params.integrationId;

    if (!clientId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }

    if (!integrationId) {
      res.status(400).json({ success: false, data: null, error: { message: 'Integration ID is required.', code: 'BAD_REQUEST' } });
      return;
    }

    // Find specific integration
    const integration = await getIntegrationById(integrationId);
    if (!integration || integration.clientId !== clientId) {
      res.status(404).json({ success: false, data: null, error: { message: 'Integration not found.', code: 'NOT_FOUND' } });
      return;
    }

    // Delete bot webhook
    const token = decrypt(integration.botToken);
    await deleteBotWebhook(token);

    // Delete recipient records associated with this integration
    await runBypassingTenant(async () => {
      await prisma.telegramRecipient.deleteMany({
        where: { integrationId },
      });
    });

    // Delete integration record from DB
    await deleteIntegrationById(clientId, integrationId);

    // If no integrations left, disable preference
    const remaining = await getIntegrationsByClientId(clientId);
    if (remaining.length === 0) {
      await upsertPreference(clientId, false);
    }

    res.status(200).json({
      success: true,
      data: {
        message: 'Telegram bot disconnected successfully.',
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Public Webhook Callback Endpoint: Telegram updates
 */
export async function processWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { integrationId } = req.params;
    
    // Call background service
    await handleWebhookUpdate(integrationId, req.body);
    
    // Always return 200 OK immediately to Telegram
    res.status(200).json({ success: true });
  } catch (error: any) {
    logger.error('TelegramController', 'Error in public webhook controller', { error: error.message });
    res.status(200).json({ success: true, warning: error.message });
  }
}

/**
 * Client Endpoint: Remove single recipient
 */
export async function removeClientRecipient(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const { id: recipientId } = req.params;

    if (!clientId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }

    await deleteRecipientById(clientId, recipientId);

    res.status(200).json({
      success: true,
      data: { message: 'Recipient disconnected successfully.' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Client Endpoint: Get Client Notification Logs
 */
export async function getClientLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }

    const logs = await prisma.notificationLog.findMany({
      where: { clientId },
      orderBy: { sentAt: 'desc' },
      take: 15,
    });

    res.status(200).json({
      success: true,
      data: logs.map((l) => ({
        id: l.id,
        channel: l.channel,
        recipient: l.recipient,
        title: l.title,
        message: l.message,
        status: l.status,
        error: l.error,
        sentAt: l.sentAt.toISOString(),
      })),
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Client Endpoint: Send Test Lead Alert Message to Bot
 */
export async function sendTestAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
      return;
    }

    // Find latest lead for the client
    const latestLead = await prisma.lead.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    const name = latestLead?.name || 'John Doe (Test)';
    const phone = latestLead?.phone || '+91 98765 43210';
    const email = latestLead?.email || 'john.doe@example.com';
    const source = latestLead?.source || 'Test Alert Button';
    const createdAt = latestLead?.createdAt || new Date();
    const leadId = latestLead?.id || 'mock-lead-id';

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const crmLink = `${frontendUrl}/client/leads/${leadId}`;

    const formattedMessage = 
      `🧪 *Test Lead Alert Received!*\n\n` +
      `👤 *Name:* ${name}\n` +
      `📞 *Phone:* ${phone}\n` +
      `📧 *Email:* ${email}\n` +
      `📍 *Source:* ${source}\n` +
      `🕒 *Time:* ${new Date(createdAt).toLocaleString()}\n\n` +
      `👉 [Open in FlowNest CRM](${crmLink})`;

    // Get active recipients
    const recipients = await prisma.telegramRecipient.findMany({
      where: { clientId, isActive: true },
    });

    if (recipients.length === 0) {
      res.status(400).json({
        success: false,
        data: null,
        error: { message: 'No active Telegram recipients found. Please link a recipient chat on Telegram first.', code: 'NO_RECIPIENTS' }
      });
      return;
    }

    const { TelegramProvider } = require('../notifications/providers/telegram.provider');
    const telegramProvider = new TelegramProvider();

    // Dispatch messages to all recipients
    await Promise.all(
      recipients.map(async (recipient) => {
        await telegramProvider.send({
          clientId,
          integrationId: recipient.integrationId,
          recipientId: recipient.id,
          chatId: recipient.chatId,
          message: formattedMessage,
          title: 'Test Lead Alert',
        });
      })
    );

    res.status(200).json({
      success: true,
      data: { message: 'Test message sent successfully.' },
      meta: {}
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Client Endpoint: Test Telegram Bot & Chat ID Connection (No saving)
 */
export async function testConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const { botToken, chatId } = testConnectionSchema.parse(req.body);

    // 1. Verify bot token
    await validateBotTokenAndGetInfo(botToken);

    // 2. Validate Chat ID by sending test message
    const result = await sendTelegramMessage(botToken, chatId, '🧪 Test Message from FlowNest CRM');

    if (!result.success) {
      let errorDetail = 'Invalid Chat ID or Telegram communication error';
      try {
        const bodyObj = JSON.parse(result.body || '{}');
        if (bodyObj.description) {
          errorDetail = bodyObj.description;
        }
      } catch (e) {
        if (result.body) errorDetail = result.body;
      }
      res.status(400).json({
        success: false,
        data: null,
        error: { message: `❌ ${errorDetail}`, code: 'TELEGRAM_ERROR' },
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Connection Successful',
    });
  } catch (error: any) {
    const isValidationError = error.name === 'ZodError';
    const message = isValidationError 
      ? error.errors.map((e: any) => e.message).join(', ') 
      : error.message;

    res.status(400).json({
      success: false,
      data: null,
      error: { message: message.startsWith('❌') ? message : `❌ ${message}`, code: 'BAD_REQUEST' },
    });
  }
}

