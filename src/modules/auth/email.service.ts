import { Resend } from 'resend';
import { logger } from '../../utils/logger';

const resendApiKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

const resend = resendApiKey ? new Resend(resendApiKey) : null;

if (!resend) {
  logger.warn(
    'EmailService',
    'RESEND_API_KEY is not configured in the environment variables. Transactional emails will be logged to the console instead of being delivered.'
  );
} else {
  logger.info(
    'EmailService',
    `✅ Resend email client initialized successfully (sender: ${emailFrom})`
  );
}

/**
 * Helper to wrap email sends, with fallback logs in development
 */
async function sendMail(to: string, subject: string, html: string) {
  if (!resend) {
    console.log('\n--------------------------------------------------');
    console.log(`✉️  [MOCK EMAIL SENT]`);
    console.log(`To:      ${to}`);
    console.log(`From:    ${emailFrom}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 500)}...`);
    console.log('--------------------------------------------------\n');
    return { id: 'mock-id' };
  }

  try {
    const response = await resend.emails.send({
      from: emailFrom,
      to,
      subject,
      html,
    });
    if (response.error) {
      logger.error('EmailService', `Resend rejected email to ${to}:`, response.error);
      throw new Error(response.error.message);
    }
    logger.info('EmailService', `Email sent successfully to ${to} (id: ${response.data?.id})`);
    return response.data;
  } catch (err: any) {
    logger.error('EmailService', `Failed to send email to ${to}`, { error: err.message });
    throw err;
  }
}

/**
 * Sends a verification OTP code during onboarding
 */
export async function sendVerificationEmail(agencyName: string, toEmail: string, token: string, expiresAt: Date) {
  const subject = `Verify your email for ${agencyName} on FlowNest CRM`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #4F46E5;">Welcome to FlowNest CRM!</h2>
      <p>Hello,</p>
      <p>Thank you for registering your agency <strong>${agencyName}</strong>. To get started with your 45-day free trial, please verify your email address by entering the following One-Time Password (OTP):</p>
      <div style="text-align: center; margin: 30px 0;">
        <span style="background-color: #F3F4F6; color: #4F46E5; font-size: 32px; font-weight: bold; letter-spacing: 5px; padding: 12px 24px; border-radius: 8px; border: 1px dashed #4F46E5; display: inline-block;">${token}</span>
      </div>
      <hr style="border: none; border-top: 1px solid #eeeeee; margin: 30px 0;" />
      <p style="font-size: 12px; color: #999999;">This verification code will expire on ${expiresAt.toLocaleString()} (15 minutes from request).</p>
      <p style="font-size: 12px; color: #999999;">Security Notice: If you did not register a FlowNest CRM account, you can safely ignore this email.</p>
    </div>
  `;

  return sendMail(toEmail, subject, html);
}

/**
 * Sends a forgot password reset link
 */
export async function sendForgotPassword(toEmail: string, token: string) {
  const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
  const subject = 'Reset your password for FlowNest CRM';

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #4F46E5;">Password Reset Request</h2>
      <p>Hello,</p>
      <p>We received a request to reset the password for your FlowNest CRM account. Click the button below to choose a new password:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="background-color: #4F46E5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password</a>
      </div>
      <p style="font-size: 13px; color: #666666;">Or copy and paste this URL into your browser:<br/>
      <a href="${resetUrl}" style="color: #4F46E5;">${resetUrl}</a></p>
      <hr style="border: none; border-top: 1px solid #eeeeee; margin: 30px 0;" />
      <p style="font-size: 12px; color: #999999;">This password reset link is valid for 1 hour. If you did not make this request, your password will remain unchanged.</p>
    </div>
  `;

  return sendMail(toEmail, subject, html);
}

/**
 * Sends a password reset confirmation
 */
export async function sendResetPassword(toEmail: string) {
  const subject = 'Your FlowNest CRM password has been reset';

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #10B981;">Password Reset Successful</h2>
      <p>Hello,</p>
      <p>This is a confirmation that the password for your FlowNest CRM account has been successfully updated.</p>
      <p>If you did not perform this action, please secure your account immediately or contact our support team.</p>
    </div>
  `;

  return sendMail(toEmail, subject, html);
}

/**
 * Sends a reminder regarding remaining trial days
 */
export async function sendTrialReminder(agencyName: string, toEmail: string, daysRemaining: number) {
  const upgradeUrl = `${frontendUrl}/agency/settings?tab=billing`;
  let subject = `Your FlowNest CRM trial ends in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}`;

  let title = `${daysRemaining} Days Left in Your Free Trial`;
  let bodyText = `This is a friendly reminder that your 45-day free trial for <strong>${agencyName}</strong> expires in ${daysRemaining} days. Upgrade your subscription plan now to keep your digital pipelines syncing without interruptions.`;

  if (daysRemaining === 0) {
    subject = `Your FlowNest CRM free trial has expired`;
    title = `Your Free Trial Has Expired`;
    bodyText = `We hope you enjoyed using FlowNest CRM! Your 45-day free trial for <strong>${agencyName}</strong> has expired. To restore access to your dashboards, campaigns, and lead integrations, please upgrade to a subscription plan.`;
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #4F46E5;">${title}</h2>
      <p>Hello,</p>
      <p>${bodyText}</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${upgradeUrl}" style="background-color: #4F46E5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Upgrade My Plan</a>
      </div>
      <p>If you have any questions, feel free to reply to this email to contact support.</p>
    </div>
  `;

  return sendMail(toEmail, subject, html);
}

/**
 * Sends confirmation when plan is upgraded/activated
 */
export async function sendSubscriptionActivated(agencyName: string, toEmail: string, planName: string) {
  const dashboardUrl = `${frontendUrl}/agency/dashboard`;
  const subject = `Your FlowNest CRM ${planName} Subscription is Active!`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #10B981;">Subscription Activated!</h2>
      <p>Hello,</p>
      <p>Thank you for subscribing to FlowNest CRM! Your subscription for <strong>${agencyName}</strong> has been successfully updated to the <strong>${planName}</strong> plan.</p>
      <p>All premium integrations, Meta webhook triggers, and Google Sheets connectors are active and unlocked.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${dashboardUrl}" style="background-color: #10B981; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Go to Dashboard</a>
      </div>
    </div>
  `;

  return sendMail(toEmail, subject, html);
}

/**
 * Sends a support ticket notification email to administration support address.
 */
export async function sendSupportTicketEmail(
  senderEmail: string,
  senderRole: string,
  tenantId: string,
  subjectText: string,
  messageText: string
) {
  const adminTargetEmail = process.env.SUPPORT_TICKET_RECEIVER_EMAIL || 'support@flownest.co';
  const subject = `[SUPPORT TICKET] ${subjectText}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333333; line-height: 1.6;">
      <h2 style="color: #4F46E5; border-bottom: 2px solid #EEEEEE; padding-bottom: 10px;">New Support Ticket Received</h2>
      <p>A user has submitted a support ticket from their workspace settings portal:</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background-color: #F9FAFB;">
          <td style="padding: 10px; border: 1px solid #E5E7EB; font-weight: bold; width: 30%;">User Email</td>
          <td style="padding: 10px; border: 1px solid #E5E7EB;">${senderEmail}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #E5E7EB; font-weight: bold;">User Role</td>
          <td style="padding: 10px; border: 1px solid #E5E7EB; text-transform: uppercase;">${senderRole}</td>
        </tr>
        <tr style="background-color: #F9FAFB;">
          <td style="padding: 10px; border: 1px solid #E5E7EB; font-weight: bold;">Workspace ID</td>
          <td style="padding: 10px; border: 1px solid #E5E7EB; font-family: monospace;">${tenantId}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #E5E7EB; font-weight: bold;">Subject</td>
          <td style="padding: 10px; border: 1px solid #E5E7EB;">${subjectText}</td>
        </tr>
      </table>

      <div style="background-color: #F3F4F6; border-left: 4px solid #4F46E5; padding: 15px; border-radius: 4px; margin-top: 20px;">
        <h4 style="margin-top: 0; margin-bottom: 10px; color: #1F2937;">Message Details:</h4>
        <p style="white-space: pre-wrap; margin: 0; color: #4B5563;">${messageText}</p>
      </div>

      <hr style="border: none; border-top: 1px solid #eeeeee; margin: 30px 0;" />
      <p style="font-size: 11px; color: #999999;">FlowNest Support Center • Automated Workspace System Notification</p>
    </div>
  `;

  return sendMail(adminTargetEmail, subject, html);
}
