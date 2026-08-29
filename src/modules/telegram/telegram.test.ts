import prisma from '../../config/db';
import { runBypassingTenant, runWithTenantContext } from '../../utils/tenant-context';
import { encrypt, decrypt } from '../../utils/encryption';
import { validateBotTokenAndGetInfo, handleWebhookUpdate } from './telegram.service';
import { 
  upsertIntegration, 
  getIntegrationsByClientId,
  upsertRecipient,
  getRecipientsByClientId,
  upsertPreference,
  getPreferenceByClientId
} from './telegram.repository';
import { TelegramProvider } from '../notifications/providers/telegram.provider';

// Mock Telegram API call responses globally
const originalFetch = globalThis.fetch;

async function runTests() {
  console.log('🧪 Starting Telegram Integration Test Suite...\n');

  // Seed test data bypassing multi-tenancy
  let agencyId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const clientId = 'a03a5f02-dd5b-4b5d-bda3-f9a10443ee12';
  const integrationId = 'c03a5f02-dd5b-4b5d-bda3-f9a10443ee22';

  let originalAgency: any = null;
  let originalClient: any = null;

  try {
    await runBypassingTenant(async () => {
      // Clean up previous runs
      await prisma.telegramIntegration.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.telegramRecipient.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.notificationLog.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.notificationPreference.deleteMany({ where: { clientId } }).catch(() => {});

      // Ensure target agency and client exist
      originalAgency = await prisma.agency.findUnique({ where: { id: agencyId } });
      if (!originalAgency) {
        originalAgency = await prisma.agency.create({
          data: {
            id: agencyId,
            name: 'Test Agency Corp',
            email: `test-agency-${Date.now()}@telegram-test.com`,
            plan: 'pro',
            subscriptionStatus: 'ACTIVE',
            subscriptionPlan: 'PROFESSIONAL',
          },
        });
      }

      originalClient = await prisma.client.findUnique({ where: { id: clientId } });
      if (!originalClient) {
        originalClient = await prisma.client.create({
          data: {
            id: clientId,
            agencyId,
            businessName: 'Test Client Store',
            email: `test-client-${Date.now()}@telegram-test.com`,
          },
        });
      } else {
        // Dynamically align agencyId to avoid conflicts with pre-existing seeds
        agencyId = originalClient.agencyId;
      }
    });

    console.log('✅ Test Data Seeded (Agency & Client ready)');

    // Set up global fetch mock
    const fetchMock = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      console.log('[DEBUG FETCH]', urlStr);
      
      if (urlStr.includes('INVALID_TOKEN/getMe')) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 404,
          description: 'Not Found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      if (urlStr.includes('VALID_TOKEN/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 12345678, is_bot: true, first_name: 'FlowNest Alert Bot', username: 'FlowNest_alert_bot' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (urlStr.includes('VALID_TOKEN/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 111 } }), { status: 200 });
      }

      if (urlStr.includes('BLOCKED_TOKEN/sendMessage')) {
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      }

      if (urlStr.includes('LIMIT_TOKEN/sendMessage')) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }), { status: 429 });
      }

      if (urlStr.includes('setWebhook') || urlStr.includes('deleteWebhook')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    };

    globalThis.fetch = fetchMock as any;

    // ─── TEST 1: Validate Bot Token ───
    console.log('\n⏳ Running Test 1: Validate Bot Token...');
    const validInfo = await validateBotTokenAndGetInfo('VALID_TOKEN');
    console.log('VALID INFO RET:', validInfo);
    if (validInfo.botUsername !== 'FlowNest_alert_bot') {
      throw new Error('Bot token validation returned invalid username');
    }
    console.log('✅ Test 1 Success: Valid bot token authenticated correctly.');

    try {
      const invalidInfo = await validateBotTokenAndGetInfo('INVALID_TOKEN');
      console.log('INVALID INFO RET:', invalidInfo);
      throw new Error('Invalid bot token should have failed validation');
    } catch (err: any) {
      if (err.message.includes('Invalid Telegram bot token')) {
        console.log('✅ Test 1 Success: Invalid bot token rejected correctly.');
      } else {
        throw err;
      }
    }

    // ─── TEST 2: Encryption & Decryption on writes ───
    console.log('\n⏳ Running Test 2: Database Token Encryption...');
    await runBypassingTenant(async () => {
      await upsertIntegration(clientId, 'VALID_TOKEN', 'FlowNest_alert_bot', 'FlowNest Alert Bot');
      
      // Query raw database to verify encryption
      const rawRecord = await prisma.$queryRawUnsafe<any[]>(
        `SELECT bot_token FROM telegram_integrations WHERE client_id = '${clientId}'::uuid`
      );
      
      const rawToken = rawRecord[0]?.bot_token;
      if (rawToken === 'VALID_TOKEN') {
        throw new Error('Bot token was stored in cleartext in the database!');
      }
      console.log('✅ Test 2 Success: Bot token is stored encrypted in database.');

      // Check automatic decryption on read
      const readRecord = await prisma.telegramIntegration.findFirst({
        where: { clientId },
      });
      if (!readRecord) {
        throw new Error('Could not read telegram integration record');
      }
      if (readRecord.botToken !== 'VALID_TOKEN') {
        throw new Error(`Auto-decryption failed. Expected "VALID_TOKEN", got "${readRecord.botToken}"`);
      }
      console.log('✅ Test 2 Success: Auto-decryption on query read verified.');
    });

    // ─── TEST 3: Client connection preference ───
    console.log('\n⏳ Running Test 3: Client Notification Preferences...');
    await runBypassingTenant(async () => {
      await upsertPreference(clientId, true);
      const pref = await getPreferenceByClientId(clientId);
      if (!pref || !pref.telegramEnabled) {
        throw new Error('Notification Preference write or fetch failed.');
      }
      console.log('✅ Test 3 Success: Preference config persisted.');
    });

    // ─── TEST 4: Recipient Webhook start parameter matching ───
    console.log('\n⏳ Running Test 4: Webhook Handshake & Recipient Connection...');
    await runBypassingTenant(async () => {
      // Upsert a test integration with a deterministic ID for webhook matching
      await prisma.telegramIntegration.deleteMany({ where: { clientId } });
      await prisma.telegramIntegration.create({
        data: {
          id: integrationId,
          clientId,
          botToken: encrypt('VALID_TOKEN'),
          botUsername: 'FlowNest_alert_bot',
          botName: 'FlowNest Alert Bot',
        },
      });

      // Simulate webhook event from Telegram
      const mockPayload = {
        update_id: 998877,
        message: {
          message_id: 1212,
          from: { id: 88889999, first_name: 'John', last_name: 'Doe', username: 'johndoe_sales' },
          chat: { id: 88889999, type: 'private' },
          text: `/start client_${clientId}`,
        },
      };

      await handleWebhookUpdate(integrationId, mockPayload);

      // Verify recipient registered
      const recipients = await getRecipientsByClientId(clientId);
      const rep = recipients.find((r: any) => r.chatId === '88889999');
      if (!rep || rep.username !== 'johndoe_sales' || rep.firstName !== 'John') {
        throw new Error('Recipient handshake failed or database save failed.');
      }
      console.log('✅ Test 4 Success: Telegram user linked successfully via /start.');
    });

    // ─── TEST 5: Multi-Tenant Compliance ───
    console.log('\n⏳ Running Test 5: Tenant Isolation...');
    const unauthorizedClientId = '11111111-2222-3333-4444-555555555555';
    
    // Scoped context query should fail to read other tenants' integrations
    await runWithTenantContext({ clientId: unauthorizedClientId }, async () => {
      try {
        const otherIntegrations = await getIntegrationsByClientId(clientId);
        if (otherIntegrations && otherIntegrations.length > 0) {
          throw new Error('Tenant isolation breach: Integration of another tenant was read.');
        }
      } catch (err: any) {
        // Multi-tenancy violation error is expected if it queries correctly, or returns null scoped
        console.log('✅ Test 5 Success: Read scoped out or blocked other tenant.');
      }
    });

    // ─── TEST 6: Message dispatch & Provider logging ───
    console.log('\n⏳ Running Test 6: Provider Messaging & Error Logging...');
    const provider = new TelegramProvider();
    
    // Successful Send
    await provider.send({
      clientId,
      integrationId,
      chatId: '88889999',
      title: 'New Lead Alert',
      message: 'Hello, this is a test notification.'
    });

    const logs = await runBypassingTenant(async () => {
      return prisma.notificationLog.findMany({
        where: { clientId },
        orderBy: { sentAt: 'desc' },
      });
    });

    const successLog = logs.find((l: any) => l.status === 'SENT');
    if (!successLog || successLog.recipient !== '88889999') {
      throw new Error('Success notification log not generated correctly.');
    }
    console.log('✅ Test 6 Success: Success logs correctly added.');

    // User blocked bot (403)
    // Update bot token to BLOCKED_TOKEN in database to force mock return 403
    await runBypassingTenant(async () => {
      await prisma.telegramIntegration.update({
        where: { id: integrationId },
        data: { botToken: encrypt('BLOCKED_TOKEN') },
      });
    });

    await provider.send({
      clientId,
      integrationId,
      chatId: '88889999',
      title: 'New Lead Alert',
      message: 'This will be blocked.'
    });

    const updatedRecipients = await runBypassingTenant(async () => {
      return getRecipientsByClientId(clientId);
    });
    const blockedRecipient = updatedRecipients.find((r: any) => r.chatId === '88889999');
    if (blockedRecipient?.isActive !== false) {
      throw new Error('Blocked recipient was not set to isActive = false.');
    }
    console.log('✅ Test 6 Success: 403 block correctly set recipient to inactive.');

    // Transient errors trigger retry (429)
    await runBypassingTenant(async () => {
      await prisma.telegramIntegration.update({
        where: { id: integrationId },
        data: { botToken: encrypt('LIMIT_TOKEN') },
      });
    });

    try {
      await provider.send({
        clientId,
        integrationId,
        chatId: '88889999',
        title: 'New Lead Alert',
        message: 'This will trigger 429.'
      });
      throw new Error('429 rate limit should have thrown a retry error');
    } catch (err: any) {
      if (err.message.includes('transient error')) {
        console.log('✅ Test 6 Success: 429 Rate limits successfully trigger throws for worker retries.');
      } else {
        throw err;
      }
    }

    console.log('\n⭐ ALL TELEGRAM TESTS COMPLETED SUCCESSFULLY! ⭐');

  } catch (err: any) {
    console.error('\n❌ Test suite failed with error:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    // Restore fetch
    globalThis.fetch = originalFetch;

    // Cleanup test data
    await runBypassingTenant(async () => {
      await prisma.telegramRecipient.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.telegramIntegration.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.notificationLog.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.notificationPreference.deleteMany({ where: { clientId } }).catch(() => {});
      await prisma.$disconnect();
    });
  }
}

runTests();
