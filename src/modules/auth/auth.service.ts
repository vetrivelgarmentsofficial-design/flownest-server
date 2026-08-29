import bcrypt from 'bcrypt';
import crypto from 'crypto';
import * as jose from 'jose';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { sendForgotPassword, sendResetPassword, sendSupportTicketEmail } from './email.service';
import { logger } from '../../utils/logger';

const BCRYPT_SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';

export interface TokenPayload {
  userId: string;
  role: string;
  tenantId: string;
  tenantType: 'agency' | 'client';
  subscriptionStatus?: string | null;
  subscriptionPlan?: string | null;
  trialEndDate?: string | null;
  isTrialExpired?: boolean;
}

/**
 * Generate JWT access token using jose library
 */
export async function generateAccessToken(payload: TokenPayload): Promise<string> {
  const secretStr = process.env.JWT_ACCESS_SECRET;
  if (!secretStr) {
    throw new Error('JWT_ACCESS_SECRET is not configured in the environment.');
  }

  const secret = new TextEncoder().encode(secretStr);
  
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(secret);
}

/**
 * Generate a random 64-byte hex refresh token and save it to the database.
 * Returns a compound token string: "id:secret"
 */
export async function createRefreshToken(userId: string, tenantId: string, tenantType: 'agency' | 'client', expiresInDays = 7): Promise<string> {
  // Generate random 64-byte hex secret
  const secret = crypto.randomBytes(64).toString('hex');
  
  // SHA-256 hash the secret for fast microsecond database checks (fully secure for high-entropy random keys)
  const tokenHash = crypto.createHash('sha256').update(secret).digest('hex');
  
  // Set expiry
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  // We bypass tenant checks for token creation because this is an auth system write
  return runBypassingTenant(async () => {
    const record = await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        agencyId: (tenantType === 'agency' && tenantId !== 'system') ? tenantId : undefined,
        clientId: (tenantType === 'client' && tenantId !== 'system') ? tenantId : undefined,
      },
    });

    // Return compound token
    return `${record.id}:${secret}`;
  });
}

/**
 * Resolves the parent agency profile details for any system user.
 */
async function getAgencyForUser(user: { agencyId?: string | null; clientId?: string | null }) {
  if (user.agencyId) {
    return prisma.agency.findUnique({
      where: { id: user.agencyId },
    });
  }
  if (user.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: user.clientId },
    });
    if (client) {
      return prisma.agency.findUnique({
        where: { id: client.agencyId },
      });
    }
  }
  return null;
}

/**
 * Validates a user's email and password, returning tokens and user details.
 */
export async function loginUser(email: string, passwordPlain: string, rememberMe = false) {
  return runBypassingTenant(async () => {
    // 1. Fetch user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      const err: any = new Error('Invalid email or password');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    // 2. Validate password
    const isPasswordValid = await bcrypt.compare(passwordPlain, user.passwordHash);
    if (!isPasswordValid) {
      const err: any = new Error('Invalid email or password');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    // Check if associated agency is suspended or unverified
    const associatedAgency = await getAgencyForUser(user);
    if (associatedAgency) {
      if (!associatedAgency.isActive) {
        const err: any = new Error('Your agency account has been suspended. Please contact support.');
        err.statusCode = 403;
        err.code = 'FORBIDDEN';
        throw err;
      }

      if (!associatedAgency.emailVerified) {
        const err: any = new Error('Please verify your email before logging in.');
        err.statusCode = 403;
        err.code = 'EMAIL_NOT_VERIFIED';
        throw err;
      }
    }

    // 3. Resolve tenant scope
    let tenantId = '';
    let tenantType: 'agency' | 'client' = 'agency';

    if (user.role === 'super_admin') {
      tenantId = 'system';
      tenantType = 'agency';
    } else if (user.clientId) {
      tenantId = user.clientId;
      tenantType = 'client';
    } else if (user.agencyId) {
      tenantId = user.agencyId;
      tenantType = 'agency';
    } else {
      throw new Error('User does not belong to any agency or client tenant.');
    }

    const subscriptionStatus = associatedAgency?.subscriptionStatus || null;
    const subscriptionPlan = associatedAgency?.subscriptionPlan || null;
    const trialEndDate = associatedAgency?.trialEndDate ? associatedAgency.trialEndDate.toISOString() : null;
    const isTrialExpired = associatedAgency?.isTrialExpired || false;

    // 4. Generate access token
    const accessToken = await generateAccessToken({
      userId: user.id,
      role: user.role,
      tenantId,
      tenantType,
      subscriptionStatus,
      subscriptionPlan,
      trialEndDate,
      isTrialExpired,
    });

    const expiresInDays = rememberMe ? 180 : 7;

    // 5. Generate refresh token
    const refreshToken = await createRefreshToken(user.id, tenantId, tenantType, expiresInDays);

    return {
      accessToken,
      refreshToken,
      expiresInDays,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId,
        tenantType,
        subscriptionStatus,
        subscriptionPlan,
        trialEndDate,
        isTrialExpired,
      },
    };
  });
}

/**
 * Handles the rotation of refresh tokens.
 * Validates compound token, deletes old token, issues new access + refresh tokens.
 */
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rotateRefreshToken(compoundToken: string) {
  const parts = compoundToken.split(':');
  if (parts.length !== 2) {
    const err: any = new Error('Invalid refresh token format');
    err.statusCode = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const [tokenId, secret] = parts;

  if (!uuidRegex.test(tokenId)) {
    const err: any = new Error('Invalid refresh token ID format');
    err.statusCode = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  return runBypassingTenant(async () => {
    // 1. Fetch the refresh token record including the user details
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { id: tokenId },
      include: { user: true },
    });

    if (!tokenRecord) {
      const err: any = new Error('Refresh token not found or revoked');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    // 2. Check if expired
    if (new Date() > tokenRecord.expiresAt) {
      // Clean up expired token
      await prisma.refreshToken.delete({ where: { id: tokenId } }).catch(() => {});
      const err: any = new Error('Refresh token has expired');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    // 3. Verify hash of the secret (support legacy bcrypt and optimized SHA-256)
    let isSecretValid = false;
    if (tokenRecord.tokenHash.startsWith('$2')) {
      isSecretValid = await bcrypt.compare(secret, tokenRecord.tokenHash);
    } else {
      const hashedSecret = crypto.createHash('sha256').update(secret).digest('hex');
      isSecretValid = (hashedSecret === tokenRecord.tokenHash);
    }

    if (!isSecretValid) {
      // Potential theft or breach - invalidate all user tokens in production
      await prisma.refreshToken.delete({ where: { id: tokenId } }).catch(() => {});
      const err: any = new Error('Invalid refresh token');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    const user = tokenRecord.user;

    // Check if associated agency is suspended or unverified
    const associatedAgency = await getAgencyForUser(user);
    if (associatedAgency) {
      if (!associatedAgency.isActive) {
        const err: any = new Error('Your agency account has been suspended. Please contact support.');
        err.statusCode = 403;
        err.code = 'FORBIDDEN';
        throw err;
      }

      if (!associatedAgency.emailVerified) {
        const err: any = new Error('Please verify your email before logging in.');
        err.statusCode = 403;
        err.code = 'EMAIL_NOT_VERIFIED';
        throw err;
      }
    }

    // 4. Resolve tenant scope
    let tenantId = '';
    let tenantType: 'agency' | 'client' = 'agency';

    if (user.role === 'super_admin') {
      tenantId = 'system';
      tenantType = 'agency';
    } else if (user.clientId) {
      tenantId = user.clientId;
      tenantType = 'client';
    } else if (user.agencyId) {
      tenantId = user.agencyId;
      tenantType = 'agency';
    }

    // 5. Delete old refresh token record (Token Rotation)
    try {
      await prisma.refreshToken.delete({
        where: { id: tokenId },
      });
    } catch (e: any) {
      // Ignore if it was already deleted (e.g. by a concurrent request)
      logger.warn('AuthService', 'Failed to delete refresh token during rotation (possibly already rotated)', {
        tokenId,
        error: e.message
      });
    }

    const subscriptionStatus = associatedAgency?.subscriptionStatus || null;
    const subscriptionPlan = associatedAgency?.subscriptionPlan || null;
    const trialEndDate = associatedAgency?.trialEndDate ? associatedAgency.trialEndDate.toISOString() : null;
    const isTrialExpired = associatedAgency?.isTrialExpired || false;

    // Calculate original lifespan of the token being rotated
    const originalDurationMs = tokenRecord.expiresAt.getTime() - tokenRecord.createdAt.getTime();
    const isRememberMe = originalDurationMs > 8 * 24 * 60 * 60 * 1000;
    const expiresInDays = isRememberMe ? 180 : 7;

    // 6. Generate new access & refresh tokens
    const newAccessToken = await generateAccessToken({
      userId: user.id,
      role: user.role,
      tenantId,
      tenantType,
      subscriptionStatus,
      subscriptionPlan,
      trialEndDate,
      isTrialExpired,
    });

    const newRefreshToken = await createRefreshToken(user.id, tenantId, tenantType, expiresInDays);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresInDays,
    };
  });
}

/**
 * Invalidate a refresh token by deleting it from the database.
 */
export async function invalidateRefreshToken(compoundToken: string): Promise<void> {
  const parts = compoundToken.split(':');
  if (parts.length !== 2) {
    return; // Silently fail/no-op on malformed token logout
  }

  const [tokenId] = parts;

  await runBypassingTenant(async () => {
    await prisma.refreshToken.delete({
      where: { id: tokenId },
    }).catch(() => {
      // Silently catch in case the record is already deleted
    });
  });
}

/**
 * Initiates the password reset flow.
 * Generates a reset token, saves its hash, and triggers a Resend email.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  return runBypassingTenant(async () => {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      const err: any = new Error('No account found with this email address.');
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Generate random token and secure hash
    const token = crypto.randomBytes(32).toString('hex');
    const passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
    const passwordResetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save the hashed token and expiration in database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken,
        passwordResetTokenExpiresAt,
      },
    });

    // Send email using Resend
    try {
      await sendForgotPassword(user.email, token);
      logger.info('AuthService', `Password reset token email sent to ${user.email}`);
    } catch (emailErr: any) {
      logger.error('AuthService', 'Password reset email delivery failed', {
        email: user.email,
        error: emailErr.message,
      });
    }
  });
}

/**
 * Resets user password if reset token is valid and not expired.
 */
export async function resetPassword(token: string, passwordPlain: string): Promise<void> {
  return runBypassingTenant(async () => {
    const passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken,
        passwordResetTokenExpiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      const err: any = new Error('The password reset link is invalid or has expired.');
      err.statusCode = 400;
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // Hash the new password
    const passwordHash = await bcrypt.hash(passwordPlain, BCRYPT_SALT_ROUNDS);

    // Update password and clear reset token fields
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    // Send password reset confirmation email
    try {
      await sendResetPassword(user.email);
    } catch (emailErr: any) {
      logger.error('AuthService', 'Password reset confirmation email delivery failed', {
        email: user.email,
        error: emailErr.message,
      });
    }
  });
}

/**
 * Creates and logs a support ticket email notification.
 */
export async function createSupportTicketService(
  userId: string,
  userRole: string,
  tenantId: string,
  subject: string,
  message: string
) {
  return runBypassingTenant(async () => {
    const userRecord = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const email = userRecord?.email || 'unknown@flownest.co';
    await sendSupportTicketEmail(email, userRole, tenantId, subject, message);
  });
}

