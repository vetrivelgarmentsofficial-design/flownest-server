import * as jose from 'jose';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { logger } from '../../utils/logger';

const db = prisma as any;

export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly'
];

/**
 * Generates a signed JWT OAuth state parameter to protect against CSRF.
 * Expires in 15 minutes.
 */
async function generateOAuthState(clientId: string, role?: string): Promise<string> {
  const secretStr = process.env.JWT_ACCESS_SECRET;
  if (!secretStr) throw new Error('JWT_ACCESS_SECRET is not configured.');
  const secret = new TextEncoder().encode(secretStr);
  return new jose.SignJWT({ clientId, role, purpose: 'google_oauth' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

/**
 * Verifies the signed JWT OAuth state and returns the embedded clientId and optional role.
 * Throws if expired, tampered, or missing required fields.
 */
export async function verifyGoogleOAuthState(state: string): Promise<{ clientId: string; role?: string }> {
  const secretStr = process.env.JWT_ACCESS_SECRET;
  if (!secretStr) throw new Error('JWT_ACCESS_SECRET is not configured.');
  const secret = new TextEncoder().encode(secretStr);
  const { payload } = await jose.jwtVerify(state, secret);
  if (!payload.clientId || payload.purpose !== 'google_oauth') {
    throw new Error('Invalid OAuth state payload.');
  }
  return {
    clientId: payload.clientId as string,
    role: payload.role as string | undefined,
  };
}

/**
 * Generates Google OAuth URL.
 * Includes access_type=offline and prompt=consent to guarantee refresh_token delivery.
 */
export async function generateGoogleOAuthUrl(clientId: string, role?: string): Promise<string> {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    logger.error('GoogleOAuthService', 'GOOGLE_CLIENT_ID is not configured.');
    throw new Error('Google Integration is not configured. Please set GOOGLE_CLIENT_ID in your environment.');
  }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.API_URL || 'http://localhost:3000'}/v1/google/callback`;

  const state = await generateOAuthState(clientId, role);
  const scopeString = GOOGLE_OAUTH_SCOPES.join(' ');

  const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${encodeURIComponent(
    scopeString
  )}&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`;

  logger.info('GoogleOAuthService', 'Generated Google OAuth URL', { clientId, redirectUri, role });
  return oauthUrl;
}

/**
 * Helper to call standard Google REST endpoints
 */
export async function callGoogleApi(url: string, accessToken: string, options: RequestInit = {}): Promise<any> {
  const finalOptions: RequestInit = {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };

  const res = await fetch(url, finalOptions);
  let body: any;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    logger.error('GoogleOAuthService', `Google API call failed to ${url}`, {
      statusCode: res.status,
      body,
    });
    const errorMsg = body?.error?.message || `Google API call failed with status ${res.status}`;
    const finalMsg = `Google API call failed with status ${res.status}: ${errorMsg}`;
    const err: any = new Error(finalMsg);
    err.status = res.status;
    throw err;
  }

  return body;
}

/**
 * Exchanges the Google authorization code for access and refresh tokens.
 * Fetches user profile to identify their email, then upserts the connection details.
 */
export async function exchangeCodeForTokens(code: string, clientId: string): Promise<void> {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.API_URL || 'http://localhost:3000'}/v1/google/callback`;

  if (!googleClientId || !googleClientSecret) {
    throw new Error('Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are not configured.');
  }

  logger.info('GoogleOAuthService', 'Exchanging authorization code for tokens', { clientId });

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google token exchange failed: ${errBody}`);
  }

  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  
  if (!data.access_token) {
    throw new Error('No access_token returned by Google OAuth.');
  }

  // Retrieve user's email using oauth2 userinfo endpoint
  const userinfo = await callGoogleApi('https://www.googleapis.com/oauth2/v2/userinfo', data.access_token);
  const email = userinfo.email || 'unknown@google.com';

  await runBypassingTenant(async () => {
    // Check if a connection already exists
    const existing = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (existing) {
      await db.googleConnection.update({
        where: { id: existing.id },
        data: {
          googleEmail: email,
          accessToken: data.access_token,
          // If refresh token is not returned (because user reconnected without consent screen), keep the old one
          ...(data.refresh_token && { refreshToken: data.refresh_token }),
        },
      });
    } else {
      if (!data.refresh_token) {
        throw new Error('No refresh_token returned. Please disconnect the app in your Google account settings and try again.');
      }
      await db.googleConnection.create({
        data: {
          clientId,
          googleEmail: email,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
        },
      });
    }

    logger.info('GoogleOAuthService', 'Saved Google Connection tokens successfully', {
      clientId,
      email,
    });
  });
}

/**
 * Refreshes the Google access token for a client connection.
 * Used internally by sync engine workers.
 */
export async function refreshGoogleToken(clientId: string, refreshToken: string): Promise<string> {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!googleClientId || !googleClientSecret) {
    throw new Error('Google OAuth credentials are not configured.');
  }

  logger.info('GoogleOAuthService', 'Refreshing Google access token', { clientId });

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google token refresh request failed: ${errBody}`);
  }

  const data = await res.json() as { access_token: string };

  await runBypassingTenant(async () => {
    const connection = await db.googleConnection.findFirst({
      where: { clientId },
    });

    if (connection) {
      await db.googleConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: data.access_token,
        },
      });
    }
  });

  return data.access_token;
}
