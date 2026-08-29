import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Default values
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let code = err.code || 'INTERNAL_SERVER_ERROR';

  // Handle Zod Validation Errors
  if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed: ' + err.errors.map((e) => `[${e.path.join('.')}] ${e.message}`).join(', ');
  }

  // Handle Multi-tenancy errors
  if (message.includes('Multi-tenancy violation')) {
    statusCode = 400;
    code = 'TENANT_VIOLATION';
  }

  // Handle CORS errors
  if (message.startsWith('Not allowed by CORS')) {
    statusCode = 403;
    code = 'CORS_FORBIDDEN';
  }

  // Hide stack trace in production, log details internally
  if (statusCode === 500) {
    console.error(`[SYSTEM ERROR] ${err.stack || err.message}`);
    // Hide details for 500 errors to clients
    message = 'An unexpected error occurred. Please try again later.';
  } else {
    console.warn(`[API WARNING] ${statusCode} - ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    code,
    errorDetails: {
      message,
      code,
      details: err.details,
    },
  });
}
