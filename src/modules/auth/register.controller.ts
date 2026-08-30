import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { registerBodySchema } from './register.validation';
import { registerAgency, verifyAgencyEmail, resendVerificationEmail } from './register.service';

const verifyEmailBodySchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
  token: z.string().length(6, 'Verification OTP must be exactly 6 digits'),
});

const resendVerificationBodySchema = z.object({
  email: z.string().email('Please enter a valid email address').trim().toLowerCase(),
});

/**
 * Controller endpoint to handle new Agency Registration.
 */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { agencyName, email, password } = registerBodySchema.parse(req.body);

    const onboardingData = await registerAgency(agencyName, email, password);

    res.status(201).json({
      success: true,
      data: {
        message: 'Agency registration successful. Please check your email to verify your account.',
        ...onboardingData,
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to handle Email Verification by token lookup.
 */
export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, token } = verifyEmailBodySchema.parse(req.body);

    await verifyAgencyEmail(email, token);

    res.status(200).json({
      success: true,
      data: {
        message: 'Your email has been verified successfully. You can now log in to your account.',
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Controller endpoint to request a fresh Email Verification link resend.
 */
export async function resendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = resendVerificationBodySchema.parse(req.body);

    await resendVerificationEmail(email);

    res.status(200).json({
      success: true,
      data: {
        message: 'A fresh verification link has been sent to your email address.',
      },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}
