// Trigger IDE type cache recheck
import { Prisma } from '@prisma/client';
import prisma from '../../config/db';
import { encrypt, decrypt } from '../../utils/encryption';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';
import { MetaDiagnosticsService, callGraphApi } from './meta-diagnostics.service';

/**
 * Exchanges the Facebook authorization code for a real long-lived access token
 * using the two-step Graph API process.
 * Step 1: code → short-lived token
 * Step 2: short-lived → 60-day long-lived token
 * Saves encrypted token and updates connection metadata on the Client record.
 */
export async function exchangeCodeForLongLivedToken(code: string, clientId: string): Promise<void> {
  // Item 4: Automatic Token Replacement - Reset old tokens/configs before saving new values
  await runBypassingTenant(async () => {
    await prisma.client.update({
      where: { id: clientId },
      data: {
        metaPageId: null,
        metaPageName: null,
        metaPageAccessToken: null,
        metaAdAccountId: null,
        metaAdAccountName: null,
        metaTokenStatus: 'PENDING',
        metaLastError: null,
        metaPermissionSnapshot: Prisma.DbNull,
      },
    });
  });

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.API_URL || 'http://localhost:3000'}/v1/meta/callback`;

  if (!appId || !appSecret || appId === 'your_meta_app_id') {
    throw new Error('Meta App credentials (META_APP_ID / META_APP_SECRET) are not configured in the environment.');
  }

  logger.info('MetaService', 'Starting OAuth token exchange', { clientId });

  // ─── Step 1: Exchange auth code for short-lived token ────────────────────────
  const shortLivedUrl = new URL('https://graph.facebook.com/v20.0/oauth/access_token');
  shortLivedUrl.searchParams.set('client_id', appId);
  shortLivedUrl.searchParams.set('client_secret', appSecret);
  shortLivedUrl.searchParams.set('redirect_uri', redirectUri);
  shortLivedUrl.searchParams.set('code', code);

  const shortLivedData = await callGraphApi(shortLivedUrl.toString());
  const shortLivedToken = shortLivedData.access_token;
  logger.info('MetaService', 'Short-lived token obtained, exchanging for long-lived token', { clientId });

  // ─── Step 2: Exchange short-lived for 60-day long-lived token ─────────────────
  const longLivedUrl = new URL('https://graph.facebook.com/v20.0/oauth/access_token');
  longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longLivedUrl.searchParams.set('client_id', appId);
  longLivedUrl.searchParams.set('client_secret', appSecret);
  longLivedUrl.searchParams.set('fb_exchange_token', shortLivedToken);

  const longLivedData = await callGraphApi(longLivedUrl.toString());

  const longLivedToken = longLivedData.access_token;
  // Facebook returns expires_in in seconds; default to 60 days if not provided
  const expiresInSeconds = longLivedData.expires_in ?? 60 * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const now = new Date();

  // Item 2: Token Permission Validation
  const diagnostics = await MetaDiagnosticsService.validateUserPermissions(longLivedToken);
  if (!diagnostics.isValid) {
    const errorMsg = `Meta OAuth connection failed: Missing required permission scopes: ${diagnostics.missing.join(', ')}. Please reconnect and grant all requested permissions.`;
    
    await runBypassingTenant(async () => {
      await prisma.client.update({
        where: { id: clientId },
        data: {
          metaTokenStatus: 'ERROR',
          metaLastError: errorMsg,
          metaPermissionSnapshot: diagnostics.permissions as any,
          metaConnectedAt: now,
          metaLastSyncAt: now,
        },
      });
    });
    throw new Error(errorMsg);
  }

  // ─── Encrypt and persist to database ──────────────────────────────────────────
  return runBypassingTenant(async () => {
    const encryptedToken = encrypt(longLivedToken);

    await prisma.client.update({
      where: { id: clientId },
      data: {
        metaAccessToken: encryptedToken,
        tokenExpiresAt: expiresAt,
        metaTokenStatus: 'CONNECTED',
        metaConnectedAt: now,
        metaLastSyncAt: now,
        metaLastError: null,
        metaPermissionSnapshot: diagnostics.permissions as any,
      },
    });

    logger.info('MetaService', 'Long-lived token saved successfully', {
      clientId,
      expiresAt: expiresAt.toISOString(),
    });

    try {
      await getMetaDashboardService(clientId);
    } catch (autoErr: any) {
      logger.warn('MetaService', 'Auto-configuration during token exchange failed', { error: autoErr.message });
    }
  });
}

/**
 * Refreshes an existing long-lived Meta token using the fb_exchange_token flow.
 * Used by the token-refresh cron worker.
 * Returns the new expiry date or throws on failure.
 */
export async function refreshLongLivedToken(clientId: string, currentToken: string): Promise<Date> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret || appId === 'your_meta_app_id') {
    throw new Error('Meta App credentials are not configured.');
  }

  const url = new URL('https://graph.facebook.com/v20.0/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', currentToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Token refresh API failed: ${errBody}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresInSeconds = data.expires_in ?? 60 * 24 * 60 * 60;
  const newExpiry = new Date(Date.now() + expiresInSeconds * 1000);

  return runBypassingTenant(async () => {
    const encryptedToken = encrypt(data.access_token);
    await prisma.client.update({
      where: { id: clientId },
      data: {
        metaAccessToken: encryptedToken,
        tokenExpiresAt: newExpiry,
        metaTokenStatus: 'CONNECTED',
        metaLastSyncAt: new Date(),
      },
    });

    try {
      const { getIo } = require('../../sockets');
      const io = getIo();
      io.to(`client:${clientId}`).emit('token:refreshed', {
        expiresAt: newExpiry.toISOString(),
        timestamp: new Date().toISOString()
      });
    } catch (sockErr: any) {
      logger.warn('MetaService', `Failed to emit token:refreshed event: ${sockErr.message}`);
    }

    logger.info('MetaService', 'Token refreshed successfully', {
      clientId,
      newExpiry: newExpiry.toISOString(),
    });
    return newExpiry;
  });
}


/**
 * Fetches the list of accessible Meta Ad Accounts for a client using their access token.
 */
export async function fetchClientAdAccounts(agencyId: string, clientId: string) {
  return runBypassingTenant(async () => {
    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId },
    });

    if (!client || !client.metaAccessToken) {
      throw new Error('Client Meta token is not connected or client not found.');
    }

    const accessToken = decrypt(client.metaAccessToken);
    const url = `https://graph.facebook.com/v20.0/me/adaccounts?fields=name,account_id,id&limit=150&access_token=${accessToken}`;

    logger.info('MetaService', 'Fetching ad accounts from Meta Graph API', { clientId });
    const data = await callGraphApi(url);
    return data.data || [];
  });
}

/**
 * Fetches the list of accessible Facebook Pages for a client using their access token.
 */
export async function fetchClientPages(agencyId: string, clientId: string) {
  return runBypassingTenant(async () => {
    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId },
    });

    if (!client || !client.metaAccessToken) {
      throw new Error('Client Meta token is not connected or client not found.');
    }

    const accessToken = decrypt(client.metaAccessToken);
    const url = `https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token&limit=150&access_token=${accessToken}`;

    logger.info('MetaService', 'Fetching pages from Meta Graph API', { clientId });
    const data = await callGraphApi(url);
    return data.data || [];
  });
}

/**
 * Subscribes a Facebook Page to the CRM app's leadgen webhook events.
 */
export async function subscribePageToWebhook(pageId: string, pageAccessToken: string) {
  const url = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
  
  logger.info('MetaService', 'Subscribing page to leadgen webhook', { pageId });

  const result = await callGraphApi(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribed_fields: 'leadgen',
      access_token: pageAccessToken,
    }),
  });

  logger.info('MetaService', 'Webhook subscription response received', {
    pageId,
    success: result.success,
    responseBody: result,
  });
  return result;
}

/**
 * Saves the selected Ad Account and Facebook Page configuration for a client,
 * then automatically subscribes the Page to Webhook events.
 */
export async function saveMetaConfig(
  agencyId: string,
  clientId: string,
  config: {
    metaAdAccountId: string;
    metaAdAccountName: string;
    metaPageId: string;
    metaPageName: string;
    metaPageAccessToken: string;
  }
) {
  return runBypassingTenant(async () => {
    logger.info('MetaService', 'Prisma Database Query: findFirst Client', {
      where: { id: clientId, agencyId },
    });

    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId },
    });

    if (!client) {
      throw new Error('Client not found or access denied.');
    }

    // Item 3: Page Token Validation - Fail early if token lacks subscription or forms capability
    const pageCheck = await MetaDiagnosticsService.validatePagePermissions(config.metaPageId, config.metaPageAccessToken);
    if (!pageCheck.isValid) {
      throw new Error(`Page Token Verification Failed: ${pageCheck.reason}`);
    }

    const formsCheck = await MetaDiagnosticsService.validateLeadgenAccess(config.metaPageId, config.metaPageAccessToken);
    if (!formsCheck.accessible) {
      throw new Error(`Page Token Verification Failed: Cannot read leadgen forms. Meta error: ${formsCheck.error || 'Unknown error'}`);
    }

    // 1. Subscribe page to webhook
    await subscribePageToWebhook(config.metaPageId, config.metaPageAccessToken);

    // 2. Encrypt the Page Access Token for secure storage
    const encryptedPageToken = encrypt(config.metaPageAccessToken);

    // 3. Save details to database
    const updatedClient = await prisma.client.update({
      where: { id: clientId },
      data: {
        metaAdAccountId: config.metaAdAccountId,
        metaAdAccountName: config.metaAdAccountName,
        metaPageId: config.metaPageId,
        metaPageName: config.metaPageName,
        metaPageAccessToken: encryptedPageToken,
        metaTokenStatus: 'CONNECTED',
        metaConnectedAt: new Date(),
        metaLastError: null,
      },
    });

    logger.info('MetaService', 'Saved Meta config and subscribed to webhook', {
      clientId,
      pageId: config.metaPageId,
      adAccountId: config.metaAdAccountId,
    });

    return updatedClient;
  });
}

/**
 * Disconnects the Meta integration for a client by setting all Meta-related fields to null/defaults.
 */
export async function disconnectMetaForClient(agencyId: string, clientId: string) {
  return runBypassingTenant(async () => {
    logger.info('MetaService', 'Prisma Database Query: findFirst Client for disconnect', {
      where: { id: clientId, agencyId },
    });

    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId },
    });

    if (!client) {
      throw new Error('Client not found or access denied.');
    }

    const updatedClient = await prisma.client.update({
      where: { id: clientId },
      data: {
        metaAccessToken: null,
        metaAdAccountId: null,
        metaAdAccountName: null,
        metaPageId: null,
        metaPageName: null,
        metaPageAccessToken: null,
        metaFormId: null,
        metaBusinessId: null,
        metaConnectedAt: null,
        tokenExpiresAt: null,
        metaLastSyncAt: null,
        metaPermissionSnapshot: Prisma.DbNull,
        metaLastError: null,
        metaAdSpend: 0.00,
        metaTokenStatus: 'DISCONNECTED',
      },
    });

    logger.info('MetaService', 'Client Meta integration disconnected successfully', {
      clientId,
      agencyId,
    });

    return updatedClient;
  });
}


/**
 * Generates unified Meta Command Center dashboard datasets for a client.
 */
export async function getMetaDashboardService(clientId: string) {
  return runBypassingTenant(async () => {
    // 1. Fetch Client profile
    const client = await prisma.client.findFirst({
      where: { id: clientId, isDeleted: false },
    });

    if (!client) {
      throw new Error('Client account not found');
    }

    if (!client.metaAccessToken) {
      return {
        connected: false,
        client: {
          id: client.id,
          businessName: client.businessName,
          email: client.email,
        },
      };
    }

    const accessToken = decrypt(client.metaAccessToken);

    // Helper to call Graph API safely
    const fetchMetaNode = async (url: string): Promise<any> => {
      try {
        return await callGraphApi(url);
      } catch (err: any) {
        logger.warn('MetaService', `Fetch failed for url ${url}: ${err.message}`);
        return null;
      }
    };

    // Helper to map Meta Ad Account statuses
    const mapAccountStatus = (statusNum: number): string => {
      switch (statusNum) {
        case 1: return 'ACTIVE';
        case 2: return 'DISABLED';
        case 3: return 'UNSETTLED BILLS';
        case 7: return 'PENDING RISK REVIEW';
        case 9: return 'IN GRACE PERIOD';
        case 100: return 'PENDING CLOSURE';
        case 101: return 'CLOSED';
        default: return 'INACTIVE';
      }
    };

    // 2. Discover Ad Accounts, Pages, and Businesses for Auto-Configuration / Switch Selectors
    const [discoveredAdAccountsRes, discoveredPagesRes, discoveredBusinessesRes] = await Promise.all([
      fetchMetaNode(`https://graph.facebook.com/v20.0/me/adaccounts?fields=name,account_id,id,currency,timezone_name,spend_cap,account_status&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/me/accounts?fields=name,id,access_token,category,followers_count&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/me/businesses?fields=name,id,verification_status&access_token=${accessToken}`),
    ]);

    const adAccountsList = (discoveredAdAccountsRes?.data || []).map((acct: any) => ({
      id: acct.id,
      name: acct.name || 'FlowNest Ad Account',
      accountId: acct.account_id || acct.id,
      currency: acct.currency || 'INR',
      timezone: acct.timezone_name || 'Asia/Kolkata',
      spendCap: acct.spend_cap ? (parseFloat(acct.spend_cap) / 100).toLocaleString() : 'No Limit',
      status: mapAccountStatus(acct.account_status),
    }));

    const pagesList = (discoveredPagesRes?.data || []).map((p: any) => ({
      id: p.id,
      name: p.name || 'Facebook Page',
      followers: p.followers_count || 0,
      category: p.category || 'Business',
      access_token: p.access_token,
    }));

    const businessesList = (discoveredBusinessesRes?.data || []).map((b: any) => ({
      id: b.id,
      name: b.name || 'Facebook Business',
      verificationStatus: b.verification_status || 'NOT_VERIFIED',
    }));

    // 3. Hands-Free Auto-Configuration Logic
    let autoConfiguredAdAccount = adAccountsList.find(
      (a: any) => a.id === client.metaAdAccountId || a.accountId === client.metaAdAccountId
    );
    let autoConfiguredPage = pagesList.find((p: any) => p.id === client.metaPageId);

    // If ad account is missing, auto-select the first one
    if (!autoConfiguredAdAccount && adAccountsList.length > 0) {
      autoConfiguredAdAccount = adAccountsList[0];
    }
    // If page is missing, auto-select the first one
    if (!autoConfiguredPage && pagesList.length > 0) {
      autoConfiguredPage = pagesList[0];
    }

    let needsSave = false;
    let updatedAdAccountId = client.metaAdAccountId;
    let updatedAdAccountName = client.metaAdAccountName;
    let updatedPageId = client.metaPageId;
    let updatedPageName = client.metaPageName;
    let updatedPageAccessToken = client.metaPageAccessToken;

    if (autoConfiguredAdAccount && client.metaAdAccountId !== autoConfiguredAdAccount.id) {
      updatedAdAccountId = autoConfiguredAdAccount.id;
      updatedAdAccountName = autoConfiguredAdAccount.name;
      needsSave = true;
    }
    if (autoConfiguredPage && client.metaPageId !== autoConfiguredPage.id) {
      updatedPageId = autoConfiguredPage.id;
      updatedPageName = autoConfiguredPage.name;
      updatedPageAccessToken = encrypt(autoConfiguredPage.access_token);
      needsSave = true;
    }

    if (needsSave) {
      logger.info('MetaService', 'Auto-configuring connected Meta assets', {
        clientId,
        adAccountId: updatedAdAccountId ?? undefined,
        pageId: updatedPageId ?? undefined,
      });

      await prisma.client.update({
        where: { id: clientId },
        data: {
          metaAdAccountId: updatedAdAccountId,
          metaAdAccountName: updatedAdAccountName,
          metaPageId: updatedPageId,
          metaPageName: updatedPageName,
          metaPageAccessToken: updatedPageAccessToken,
          metaTokenStatus: 'CONNECTED',
          metaConnectedAt: new Date(),
        },
      });

      // Update local variables for subsequent fetches
      client.metaAdAccountId = updatedAdAccountId;
      client.metaAdAccountName = updatedAdAccountName;
      client.metaPageId = updatedPageId;
      client.metaPageName = updatedPageName;
      client.metaPageAccessToken = updatedPageAccessToken;

      // Subscribe page webhook
      if (updatedPageId && autoConfiguredPage?.access_token) {
        try {
          await subscribePageToWebhook(updatedPageId, autoConfiguredPage.access_token);
        } catch (subErr: any) {
          logger.warn('MetaService', `Auto webhook subscription failed: ${subErr.message}`);
        }
      }
    }

    const finalAdAccountId = client.metaAdAccountId;
    const finalPageId = client.metaPageId;
    const finalPageAccessToken = client.metaPageAccessToken ? decrypt(client.metaPageAccessToken) : null;

    if (!finalAdAccountId) {
      return {
        connected: true,
        apiAvailable: false,
        client: {
          id: client.id,
          businessName: client.businessName,
          email: client.email,
        },
        adAccounts: adAccountsList,
        pages: pagesList,
        businesses: businessesList,
        error: 'No Meta Ad Account connected or discovered.',
      };
    }

    const normAdAccountId = finalAdAccountId.startsWith('act_') ? finalAdAccountId : 'act_' + finalAdAccountId;

    // Helper to parse insights item
    const parseInsights = (item: any) => {
      if (!item) {
        return {
          spend: 0,
          reach: 0,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          cpc: 0,
          cpm: 0,
          leads: 0,
          costPerLead: 0,
        };
      }
      const spend = parseFloat(item.spend || '0');
      const reach = parseInt(item.reach || '0', 10);
      const impressions = parseInt(item.impressions || '0', 10);
      const clicks = parseInt(item.clicks || '0', 10);
      const ctr = parseFloat(item.ctr || '0');
      const cpc = parseFloat(item.cpc || '0');
      const cpm = parseFloat(item.cpm || '0');

      let leads = 0;
      if (Array.isArray(item.actions)) {
        const leadAction = item.actions.find(
          (a: any) => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped'
        );
        if (leadAction) {
          leads = parseInt(leadAction.value || '0', 10);
        }
      }
      const costPerLead = leads > 0 ? spend / leads : 0;
      return { spend, reach, impressions, clicks, ctr, cpc, cpm, leads, costPerLead };
    };

    // 4. Fetch insights, campaigns, adsets, ads, forms, database leads, diagnostics, and sales
    const [
      meRes,
      adAccountRes,
      pageRes,
      overviewInsightsRes,
      currentMonthInsightsRes,
      campaignsRes,
      campaignInsightsRes,
      adsetsRes,
      adsetInsightsRes,
      adsRes,
      adInsightsRes,
      formsRes,
      dbLeads,
      diagnosticsReport,
      metaSales,
      lastLead,
    ] = await Promise.all([
      fetchMetaNode(`https://graph.facebook.com/v20.0/me?fields=name&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}?fields=name,currency,timezone_name,business,account_id,spend_cap,account_status&access_token=${accessToken}`),
      finalPageId ? fetchMetaNode(`https://graph.facebook.com/v20.0/${finalPageId}?fields=name,id,followers_count,category&access_token=${accessToken}`) : Promise.resolve(null),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/insights?fields=spend,reach,impressions,clicks,ctr,cpc,cpm,actions&date_preset=maximum&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/insights?fields=spend,actions&date_preset=this_month&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/campaigns?fields=name,objective,status,id&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/insights?level=campaign&fields=campaign_id,spend,reach,impressions,clicks,ctr,cpc,cpm,actions&date_preset=maximum&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/adsets?fields=name,status,daily_budget,campaign{id,name}&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/insights?level=adset&fields=adset_id,spend,reach,impressions,clicks,actions&date_preset=maximum&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/ads?fields=name,status,adset{id,name},campaign{id,name}&limit=150&access_token=${accessToken}`),
      fetchMetaNode(`https://graph.facebook.com/v20.0/${normAdAccountId}/insights?level=ad&fields=ad_id,spend,reach,impressions,clicks,ctr,cpc,cpm,actions&date_preset=maximum&limit=150&access_token=${accessToken}`),
      finalPageId ? fetchMetaNode(`https://graph.facebook.com/v20.0/${finalPageId}/leadgen_forms?fields=name,id,created_time,leads_count&limit=150&access_token=${finalPageAccessToken || accessToken}`) : Promise.resolve(null),
      prisma.lead.findMany({
        where: { clientId, leadSource: 'META_ADS' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      MetaDiagnosticsService.generateMetaDiagnosticsReport(clientId),
      prisma.sale.findMany({
        where: { clientId, lead: { leadSource: 'META_ADS' } },
        select: { amount: true },
      }),
      prisma.lead.findFirst({
        where: { clientId, leadSource: 'META_ADS' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const apiAvailable = !!(meRes || adAccountRes || overviewInsightsRes || campaignsRes);

    // Map Connection Card details
    const connectedUser = {
      name: meRes?.name || 'Unknown User',
    };
    const connectedAdAccount = {
      id: adAccountRes?.account_id || finalAdAccountId || '—',
      name: adAccountRes?.name || client.metaAdAccountName || '—',
      currency: adAccountRes?.currency || '—',
      timezone: adAccountRes?.timezone_name || '—',
      spendCap: adAccountRes?.spend_cap ? (parseFloat(adAccountRes.spend_cap) / 100).toLocaleString() : 'No Limit',
      status: adAccountRes?.account_status ? mapAccountStatus(adAccountRes.account_status) : 'INACTIVE',
    };
    const connectedBusiness = {
      name: adAccountRes?.business?.name || businessesList[0]?.name || '—',
      id: adAccountRes?.business?.id || businessesList[0]?.id || '—',
      verificationStatus: businessesList[0]?.verificationStatus || '—',
    };
    const connectedPage = {
      name: pageRes?.name || client.metaPageName || '—',
      id: pageRes?.id || finalPageId || '—',
      followers: pageRes?.followers_count || 0,
      category: pageRes?.category || '—',
    };
    let daysRemaining = 0;
    if (client.tokenExpiresAt) {
      const diffMs = new Date(client.tokenExpiresAt).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    // Map Overview metrics
    const overviewMetrics = parseInsights(overviewInsightsRes?.data?.[0]);
    const currentMonthSpend = parseFloat(currentMonthInsightsRes?.data?.[0]?.spend || '0');

    // Revenue calculations (authentic from WON leads sales)
    const totalRevenue = metaSales.reduce((sum: number, s: any) => sum + Number(s.amount), 0);
    const roas = overviewMetrics.spend > 0 ? totalRevenue / overviewMetrics.spend : 0;

    // Map Campaigns
    const campaignList = campaignsRes?.data || [];
    const campaignInsightsList = campaignInsightsRes?.data || [];
    const campaignInsightsMap = new Map<string, any>();
    for (const insight of campaignInsightsList) {
      if (insight.campaign_id) {
        campaignInsightsMap.set(insight.campaign_id, parseInsights(insight));
      }
    }
    const campaigns = campaignList.map((c: any) => {
      const insights = campaignInsightsMap.get(c.id) || { spend: 0, reach: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, leads: 0, costPerLead: 0 };
      return {
        id: c.id,
        name: c.name,
        objective: c.objective || '—',
        status: c.status || '—',
        ...insights,
      };
    });
    campaigns.sort((a: any, b: any) => b.spend - a.spend);

    // Map Adsets
    const adsetList = adsetsRes?.data || [];
    const adsetInsightsList = adsetInsightsRes?.data || [];
    const adsetInsightsMap = new Map<string, any>();
    for (const insight of adsetInsightsList) {
      if (insight.adset_id) {
        adsetInsightsMap.set(insight.adset_id, parseInsights(insight));
      }
    }
    const adsets = adsetList.map((as: any) => {
      const insights = adsetInsightsMap.get(as.id) || { spend: 0, reach: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, leads: 0, costPerLead: 0 };
      return {
        id: as.id,
        name: as.name,
        status: as.status || '—',
        dailyBudget: as.daily_budget ? parseFloat(as.daily_budget) / 100 : 0,
        reach: insights.reach,
        leads: insights.leads,
        spend: insights.spend,
      };
    });

    // Map Ads
    const adsList = adsRes?.data || [];
    const adInsightsList = adInsightsRes?.data || [];
    const adInsightsMap = new Map<string, any>();
    for (const insight of adInsightsList) {
      if (insight.ad_id) {
        adInsightsMap.set(insight.ad_id, parseInsights(insight));
      }
    }
    const ads = adsList.map((ad: any) => {
      const insights = adInsightsMap.get(ad.id) || { spend: 0, reach: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, leads: 0, costPerLead: 0 };
      return {
        id: ad.id,
        name: ad.name,
        status: ad.status || '—',
        spend: insights.spend,
        reach: insights.reach,
        clicks: insights.clicks,
        ctr: insights.ctr,
        leads: insights.leads,
        cpc: insights.cpc,
      };
    });

    // Map Forms
    const forms = (formsRes?.data || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      createdTime: f.created_time || '—',
      leadsCount: f.leads_count || 0,
    }));

    // Map Leads
    const leads = dbLeads.map((l: any) => {
      const custom = l.customFields ? (l.customFields as any) : {};
      return {
        id: l.id,
        name: l.name,
        phone: l.phone || '—',
        email: l.email || '—',
        campaign: l.campaignName || '—',
        adset: custom.adsetName || '—',
        ad: custom.adName || '—',
        form: custom.formId || '—',
        page: l.pageName || '—',
        createdTime: l.metaCreatedAt ? l.metaCreatedAt.toISOString() : l.createdAt.toISOString(),
        metaLeadId: l.metaLeadId || '—',
        source: 'META',
      };
    });

    // Queue Health Diagnostics checks
    let queueHealth = 'UNAVAILABLE';
    let failedJobs = 0;
    let deadLetterQueueCount = 0;
    try {
      const { metaLeadsQueue, metaLeadsFailedQueue } = require('../../queues/metaLeadsQueue');
      if (metaLeadsQueue) {
        const counts = await metaLeadsQueue.getJobCounts();
        failedJobs = counts.failed || 0;
        queueHealth = 'HEALTHY';
      }
      if (metaLeadsFailedQueue) {
        const failedCounts = await metaLeadsFailedQueue.getJobCounts();
        deadLetterQueueCount = (failedCounts.active || 0) + (failedCounts.failed || 0) + (failedCounts.waiting || 0);
      }
    } catch (qErr: any) {
      logger.warn('MetaService', `BullMQ health check failed: ${qErr.message}`);
    }

    // Trigger Socket.IO updates for active telemetry refresh
    try {
      const { getIo } = require('../../sockets');
      const io = getIo();
      io.to(`client:${clientId}`).emit('campaign:updated', { count: campaigns.length });
      io.to(`client:${clientId}`).emit('adset_updated', { count: adsets.length });
    } catch (sockErr: any) {
      logger.warn('MetaService', `Manual refresh socket trigger failed: ${sockErr.message}`);
    }

    return {
      connected: true,
      apiAvailable,
      client: {
        id: client.id,
        businessName: client.businessName,
        email: client.email,
        metaLastSyncAt: client.metaLastSyncAt,
      },
      overviewMetrics: {
        ...overviewMetrics,
        currentMonthSpend,
      },
      totalRevenue,
      roas,
      campaigns,
      adsets,
      ads,
      forms,
      leads,
      businesses: businessesList,
      adAccounts: adAccountsList,
      pages: pagesList,
      connectionCard: {
        connectedBusiness,
        connectedAdAccount,
        connectedPage,
        connectedUser,
        daysRemaining,
      },
      diagnostics: {
        webhookStatus: diagnosticsReport.pageDiagnostics?.webhookSubscribed ? 'CONNECTED' : 'DISCONNECTED',
        pageTokenStatus: diagnosticsReport.pageDiagnostics?.tokenValid ? 'VALID' : 'INVALID',
        userTokenStatus: client.metaTokenStatus === 'CONNECTED' ? 'ACTIVE' : 'EXPIRED',
        permissionsGranted: diagnosticsReport.userPermissions?.granted || [],
        queueHealth,
        failedJobs,
        deadLetterQueueCount,
        lastSuccessfulSync: client.metaLastSyncAt ? client.metaLastSyncAt.toISOString() : null,
        lastLeadReceived: lastLead ? lastLead.createdAt.toISOString() : null,
        lastWebhookEvent: client.metaLastSyncAt ? client.metaLastSyncAt.toISOString() : null,
      },
    };
  });
}

