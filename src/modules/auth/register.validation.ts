import { z } from 'zod';

export const registerBodySchema = z.object({
  agencyName: z
    .string()
    .min(2, 'Agency name must be at least 2 characters long')
    .max(255, 'Agency name must be under 255 characters'),
  email: z
    .string()
    .email('Please enter a valid email address')
    .trim()
    .toLowerCase(),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters long')
    .max(100, 'Password must be under 100 characters'),
});
