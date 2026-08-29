import prisma from '../../config/db';
import { decrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { runBypassingTenant } from '../../utils/tenant-context';

export interface GraphApiErrorDetails {
  url: string;
  statusCode: number;
  body: any;
  headers: any;
  fbtraceId?: string;
}

export class GraphApiError extends Error {
  details: GraphApiErrorDetails;
  constructor(info: { message: string; details: GraphApiErrorDetails }) {
    super(info.message);
    this.name = 'GraphApiError';
    this.details = info.details;
  }
}

/**
 * Robust Graph API fetching helper that logs failures in detail
 */
export async function callGraphApi(url: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(url, options);
  const headers = Object.fromEntries(res.headers.entries());
  const fbtraceId = (headers['x-fb-trace-id'] || headers['x-fb-request-id']) as string | undefined;

  let body: any;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const errorDetails: GraphApiErrorDetails = {
      url,
      statusCode: res.status,
      body,
      headers,
      fbtraceId,
    };
    logger.error('MetaDiagnosticsService', 'Meta Graph API failure details', {
      statusCode: res.status,
      fbtraceId,
      url,
      body,
    });
    throw new GraphApiError({
      message: body?.error?.message || `Graph API call failed with status ${res.status}`,
      details: errorDetails,
    });
  }

  return body;
}

export const MetaDiagnosticsService = {
  /**
   * Validates user-level permissions for Leads Ads management.
   */
  async validateUserPermissions(userAccessToken: string) {
    try {
      const url = `https://graph.facebook.com/v20.0/me/permissions?access_token=${userAccessToken}`;
      const response = await callGraphApi(url);
      const permissions = response.data || [];

      const baseCriticalScopes = ['leads_retrieval', 'pages_manage_metadata', 'pages_manage_ads'];
      const criticalScopes = process.env.META_EXCLUDE_METADATA_SCOPE === 'true'
        ? baseCriticalScopes.filter((scope) => scope !== 'pages_manage_metadata')
        : baseCriticalScopes;

      const grantedList = permissions
        .filter((p: any) => p.status === 'granted')
        .map((p: any) => p.permission);

      const missing = criticalScopes.filter((scope) => !grantedList.includes(scope));

      return {
        isValid: missing.length === 0,
        permissions,
        missing,
      };
    } catch (error: any) {
      logger.error('MetaDiagnosticsService', 'validateUserPermissions failed', { error: error.message });
      const baseCriticalScopes = ['leads_retrieval', 'pages_manage_metadata', 'pages_manage_ads'];
      const criticalScopes = process.env.META_EXCLUDE_METADATA_SCOPE === 'true'
        ? baseCriticalScopes.filter((scope) => scope !== 'pages_manage_metadata')
        : baseCriticalScopes;
      return {
        isValid: false,
        permissions: [],
        missing: criticalScopes,
        error: error.message,
      };
    }
  },

  /**
   * Validates that the page token works and can access the page configuration.
   */
  async validatePagePermissions(pageId: string, pageAccessToken: string) {
    console.log({
      tokenType: 'PAGE_ACCESS_TOKEN_PAGE_PERMS',
      pageId,
      tokenPrefix: pageAccessToken ? pageAccessToken.substring(0, 20) : 'null'
    });
    try {
      const url = `https://graph.facebook.com/v20.0/${pageId}?fields=name&access_token=${pageAccessToken}`;
      const response = await callGraphApi(url);
      console.log('GET /{pageId} raw response:', JSON.stringify(response));
      return {
        isValid: true,
        pageName: response.name,
      };
    } catch (error: any) {
      console.log('GET /{pageId} error response:', error.message, error.details);
      logger.error('MetaDiagnosticsService', 'validatePagePermissions failed', { pageId, error: error.message });
      return {
        isValid: false,
        reason: error.message,
      };
    }
  },

  /**
   * Checks if the CRM App is registered to Webhooks for the page.
   */
  async validateWebhookSubscription(pageId: string, pageAccessToken: string) {
    try {
      const url = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
      const response = await callGraphApi(url);
      const subscriptions = response.data || [];

      // Check if any app is subscribed to leadgen
      const leadgenSub = subscriptions.find((sub: any) => {
        const fields = sub.subscribed_fields || [];
        return fields.includes('leadgen');
      });

      return {
        subscribed: !!leadgenSub,
        details: subscriptions,
      };
    } catch (error: any) {
      logger.error('MetaDiagnosticsService', 'validateWebhookSubscription failed', { pageId, error: error.message });
      return {
        subscribed: false,
        error: error.message,
      };
    }
  },

  /**
   * Validates that leadgen forms are readable using the page token.
   */
  async validateLeadgenAccess(pageId: string, pageAccessToken: string) {
    const tokenType = 'PAGE_ACCESS_TOKEN';
    const accessToken = pageAccessToken || '';
    console.log({
      pageId,
      tokenPrefix: accessToken.substring(0, 20),
      tokenType
    });
    try {
      const url = `https://graph.facebook.com/v20.0/${pageId}/leadgen_forms?limit=1&access_token=${pageAccessToken}`;
      const response = await callGraphApi(url);
      console.log('GET /{pageId}/leadgen_forms raw response:', JSON.stringify(response));
      return {
        accessible: true,
      };
    } catch (error: any) {
      const rawResponse = error.details?.body || error.details || error;
      console.log('GET /{pageId}/leadgen_forms raw response:', JSON.stringify(rawResponse));
      logger.error('MetaDiagnosticsService', 'validateLeadgenAccess failed', { pageId, error: error.message });
      return {
        accessible: false,
        error: error.message,
      };
    }
  },

  /**
   * Evaluates end-to-end integration status for a Client and creates a structured health report.
   */
  async generateMetaDiagnosticsReport(clientId: string) {
    return runBypassingTenant(async () => {
      const client = await prisma.client.findUnique({
        where: { id: clientId },
      }) as any;

      if (!client) {
        throw new Error('Client not found');
      }

      if (!client.metaAccessToken) {
        return {
          status: 'DISCONNECTED',
          lastError: client.metaLastError,
          connectedAt: null,
          lastSyncAt: null,
          userPermissions: { isValid: false, granted: [], missing: ['leads_retrieval', 'pages_manage_metadata', 'pages_manage_ads'] },
          configuration: null,
          pageDiagnostics: null,
        };
      }

      const userToken = decrypt(client.metaAccessToken);
      const userPermCheck = await this.validateUserPermissions(userToken);

      const report: any = {
        status: client.metaTokenStatus,
        lastError: client.metaLastError,
        connectedAt: client.metaConnectedAt,
        lastSyncAt: client.metaLastSyncAt,
        userPermissions: {
          isValid: userPermCheck.isValid,
          granted: userPermCheck.permissions.map((p: any) => p && typeof p === 'object' ? p.permission : p),
          missing: userPermCheck.missing,
        },
        configuration: {
          pageId: client.metaPageId,
          pageName: client.metaPageName,
          adAccountId: client.metaAdAccountId,
          adAccountName: client.metaAdAccountName,
        },
        pageDiagnostics: null,
      };

      if (client.metaPageId && client.metaPageAccessToken) {
        const pageToken = decrypt(client.metaPageAccessToken);
        const pagePermCheck = await this.validatePagePermissions(client.metaPageId, pageToken);
        const webhookCheck = await this.validateWebhookSubscription(client.metaPageId, pageToken);
        const leadgenCheck = await this.validateLeadgenAccess(client.metaPageId, pageToken);

        report.pageDiagnostics = {
          pageId: client.metaPageId,
          pageName: client.metaPageName,
          tokenValid: pagePermCheck.isValid,
          webhookSubscribed: webhookCheck.subscribed,
          leadgenAccessible: leadgenCheck.accessible,
          reason: pagePermCheck.reason || webhookCheck.error || leadgenCheck.error || null,
        };
      }

      return report;
    });
  },
};
