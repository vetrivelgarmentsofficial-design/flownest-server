import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../../config/db';
import { runBypassingTenant } from '../../utils/tenant-context';
import { sendVerificationEmail } from './email.service';
import { logger } from '../../utils/logger';

const BCRYPT_SALT_ROUNDS = 12;

export async function registerAgency(agencyName: string, email: string, passwordPlain: string) {
  return runBypassingTenant(async () => {
    // 1. Prevent duplicate email in Agency or User
    const existingAgency = await prisma.agency.findUnique({
      where: { email },
    });

    if (existingAgency) {
      const err: any = new Error('An agency with this email address already exists.');
      err.statusCode = 400;
      err.code = 'BAD_REQUEST';
      throw err;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      const err: any = new Error('A user with this email address already exists.');
      err.statusCode = 400;
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // 2. Generate cryptographically secure email verification parameters
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

    // 3. Define trial dates (45 days trial)
    const trialStartDate = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 45);

    // 4. Encrypt password using bcrypt
    const passwordHash = await bcrypt.hash(passwordPlain, BCRYPT_SALT_ROUNDS);

    // 5. Wrap database writes inside transaction
    logger.info('RegisterService', 'Executing registration transaction', { agencyName, email });
    const result = await prisma.$transaction(async (tx) => {
      // Create the Agency
      const agency = await tx.agency.create({
        data: {
          name: agencyName,
          email,
          plan: 'free_trial', // Keep placeholder compatible
          isActive: true,
          emailVerified: false,
          verificationToken: token,
          verificationTokenExpiresAt: tokenExpiresAt,
          subscriptionStatus: 'TRIAL',
          subscriptionPlan: 'FREE_TRIAL',
          trialStartDate,
          trialEndDate,
          isTrialExpired: false,
        },
      });

      // Create the Admin User for the Agency
      const user = await tx.user.create({
        data: {
          agencyId: agency.id,
          role: 'agency_admin',
          email,
          passwordHash,
        },
      });

      return { agency, user };
    });

    // 6. Dispatch transactional verification email
    try {
      await sendVerificationEmail(result.agency.name, result.agency.email, token, tokenExpiresAt);
    } catch (emailErr: any) {
      logger.error('RegisterService', 'Verification email dispatch failed during registration', {
        email,
        error: emailErr.message,
      });
      // Do not roll back registration if email server fails; user can request resend on login
    }

    return {
      agencyId: result.agency.id,
      agencyName: result.agency.name,
      adminId: result.user.id,
      adminEmail: result.user.email,
    };
  });
}

/**
 * Validates a verification token, updates agency status
 */
export async function verifyAgencyEmail(token: string) {
  return runBypassingTenant(async () => {
    // Find the agency with this token
    const agency = await prisma.agency.findFirst({
      where: {
        verificationToken: token,
      },
    });

    if (!agency) {
      const err: any = new Error('Invalid or expired email verification token.');
      err.statusCode = 400;
      err.code = 'INVALID_TOKEN';
      throw err;
    }

    // Check if token has expired
    if (agency.verificationTokenExpiresAt && new Date() > agency.verificationTokenExpiresAt) {
      const err: any = new Error('Verification token has expired. Please request a new one.');
      err.statusCode = 400;
      err.code = 'EXPIRED_TOKEN';
      throw err;
    }

    // Mark email as verified
    const updatedAgency = await prisma.agency.update({
      where: { id: agency.id },
      data: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        verificationToken: null,
        verificationTokenExpiresAt: null,
      },
    });

    logger.info('RegisterService', 'Agency email verified successfully', {
      agencyId: agency.id,
      email: agency.email,
    });

    return updatedAgency;
  });
}

/**
 * Resends a verification email with a fresh token
 */
export async function resendVerificationEmail(email: string) {
  return runBypassingTenant(async () => {
    const agency = await prisma.agency.findUnique({
      where: { email },
    });

    if (!agency) {
      const err: any = new Error('No agency account found with this email address.');
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (agency.emailVerified) {
      const err: any = new Error('This email address has already been verified.');
      err.statusCode = 400;
      err.code = 'ALREADY_VERIFIED';
      throw err;
    }

    // Generate new token details
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.agency.update({
      where: { id: agency.id },
      data: {
        verificationToken: token,
        verificationTokenExpiresAt: tokenExpiresAt,
      },
    });

    // Send email (gracefully handle delivery failures)
    try {
      await sendVerificationEmail(agency.name, agency.email, token, tokenExpiresAt);
    } catch (emailErr: any) {
      logger.error('RegisterService', 'Verification email delivery failed on resend request', {
        email: agency.email,
        error: emailErr.message,
      });
      // Still return success — the token was rotated in the database.
      // User can try again or check spam folder.
    }

    logger.info('RegisterService', 'Resent verification email', {
      agencyId: agency.id,
      email: agency.email,
    });

    return { success: true };
  });
}
