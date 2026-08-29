import prisma from '../../config/db';

const db = prisma as any;

export async function getIntegrationsByClientId(clientId: string) {
  return db.telegramIntegration.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getIntegrationById(id: string) {
  return db.telegramIntegration.findUnique({
    where: { id },
  });
}

export async function upsertIntegration(
  clientId: string,
  botToken: string,
  botUsername: string,
  botName: string
) {
  const existing = await db.telegramIntegration.findFirst({
    where: {
      clientId,
      botUsername,
    },
  });
  if (existing) {
    return db.telegramIntegration.update({
      where: { id: existing.id },
      data: {
        botToken,
        botName,
        isConnected: true,
      },
    });
  }
  return db.telegramIntegration.create({
    data: {
      clientId,
      botToken,
      botUsername,
      botName,
      isConnected: true,
    },
  });
}

export async function deleteIntegrationById(clientId: string, id: string) {
  return db.telegramIntegration.delete({
    where: { id, clientId },
  });
}

export async function getRecipientsByClientId(clientId: string) {
  return db.telegramRecipient.findMany({
    where: { clientId },
    orderBy: { connectedAt: 'desc' },
  });
}

export async function upsertRecipient(
  clientId: string,
  integrationId: string,
  chatId: string,
  username?: string | null,
  firstName?: string | null,
  lastName?: string | null
) {
  const existing = await db.telegramRecipient.findFirst({
    where: {
      integrationId,
      chatId,
    },
  });
  if (existing) {
    return db.telegramRecipient.update({
      where: { id: existing.id },
      data: {
        username,
        firstName,
        lastName,
        isActive: true,
      },
    });
  }
  return db.telegramRecipient.create({
    data: {
      clientId,
      integrationId,
      chatId,
      username,
      firstName,
      lastName,
      isActive: true,
    },
  });
}

export async function markRecipientInactive(integrationId: string, chatId: string) {
  const existing = await db.telegramRecipient.findFirst({
    where: {
      integrationId,
      chatId,
    },
  });
  if (existing) {
    return db.telegramRecipient.update({
      where: { id: existing.id },
      data: {
        isActive: false,
      },
    });
  }
}

export async function deleteRecipientById(clientId: string, recipientId: string) {
  return db.telegramRecipient.delete({
    where: {
      id: recipientId,
      clientId,
    },
  });
}

export async function getPreferenceByClientId(clientId: string) {
  return db.notificationPreference.findUnique({
    where: { clientId },
  });
}

export async function upsertPreference(clientId: string, telegramEnabled: boolean) {
  return db.notificationPreference.upsert({
    where: { clientId },
    update: {
      telegramEnabled,
    },
    create: {
      clientId,
      telegramEnabled,
    },
  });
}

export async function createIntegration(
  clientId: string,
  botToken: string,
  botUsername: string,
  botName: string
) {
  const existing = await db.telegramIntegration.findFirst({
    where: {
      clientId,
      botUsername,
    },
  });
  if (existing) {
    return db.telegramIntegration.update({
      where: { id: existing.id },
      data: {
        botToken,
        botName,
        isConnected: true,
      },
    });
  }
  return db.telegramIntegration.create({
    data: {
      clientId,
      botToken,
      botUsername,
      botName,
      isConnected: true,
    },
  });
}

export async function createRecipient(
  clientId: string,
  integrationId: string,
  chatId: string,
  username?: string | null,
  firstName?: string | null,
  lastName?: string | null,
  connectionMethod: any = 'MANUAL',
  recipientName?: string | null
) {
  const existing = await db.telegramRecipient.findFirst({
    where: {
      integrationId,
      chatId,
    },
  });
  if (existing) {
    return db.telegramRecipient.update({
      where: { id: existing.id },
      data: {
        username,
        firstName,
        lastName,
        recipientName,
        connectionMethod,
        isActive: true,
      },
    });
  }
  return db.telegramRecipient.create({
    data: {
      clientId,
      integrationId,
      chatId,
      username,
      firstName,
      lastName,
      recipientName,
      connectionMethod,
      isActive: true,
    },
  });
}

export async function findIntegration(clientId: string, botUsername: string) {
  return db.telegramIntegration.findFirst({
    where: {
      clientId,
      botUsername,
    },
  });
}

export async function findRecipient(integrationId: string, chatId: string) {
  return db.telegramRecipient.findFirst({
    where: {
      integrationId,
      chatId,
    },
  });
}

export async function validateDuplicateChat(clientId: string, chatId: string) {
  const existing = await db.telegramRecipient.findFirst({
    where: {
      clientId,
      chatId,
      isActive: true,
    },
  });
  return !!existing;
}
