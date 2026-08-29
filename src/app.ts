import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load local overrides first if available
const localEnvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}
dotenv.config(); // Load any remaining variables from standard .env


import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import { authRouter } from './modules/auth/auth.routes';
import { agencyRouter } from './modules/agency/agency.routes';
import { leadsRouter } from './modules/leads/leads.routes';
import { followUpsRouter } from './modules/follow-ups/follow-ups.routes';
import { salesRouter } from './modules/sales/sales.routes';
import { metaRouter } from './modules/meta/meta.routes';
import { googleSheetsRouter } from './modules/google-sheets/googleSheets.routes';
import { superAdminAgenciesRouter } from './modules/super-admin/agencies.routes';
import { telegramRouter, clientTelegramRouter } from './modules/telegram/telegram.routes';
import { authMiddleware } from './middleware/auth';
import { tenantScopeMiddleware } from './middleware/tenantScope';
import { errorHandler } from './middleware/errorHandler';
import { requireRoles } from './middleware/rbac';
import { initializeSocketIO } from './sockets';
import { generalLimiter } from './middleware/rateLimiter';
import { logger } from './utils/logger';

// Bull Board imports
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

// Queues, Schedulers, and Workers
import { redisConnection } from './utils/redis';
import { metaLeadsQueue, metaLeadsFailedQueue, scheduleMetaSync, metaLeadsWorker } from './queues/metaLeadsQueue';
import { tokenRefreshQueue, scheduleTokenRefresh, tokenRefreshWorker } from './queues/tokenRefreshQueue';
import { notificationsQueue, notificationsWorker } from './modules/notifications/notification.queue';
import { trialExpiryQueue, scheduleDailyTrialSweep, trialExpiryWorker } from './queues/trialExpiryQueue';
import { startSpreadsheetScheduler } from './modules/google-sheets/spreadsheetScheduler.service';
import { startPipelineAutomationScheduler } from './modules/leads/automationScheduler.service';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Create HTTP server (required for Socket.IO integration)
const server = http.createServer(app);
const io = initializeSocketIO(server);

// Bind Socket.IO server onto express instance
app.set('io', io);

// Configure Bull Board dashboard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const boardQueues = [
  metaLeadsQueue && new BullMQAdapter(metaLeadsQueue),
  metaLeadsFailedQueue && new BullMQAdapter(metaLeadsFailedQueue),
  tokenRefreshQueue && new BullMQAdapter(tokenRefreshQueue),
  notificationsQueue && new BullMQAdapter(notificationsQueue),
  trialExpiryQueue && new BullMQAdapter(trialExpiryQueue),
].filter((q): q is BullMQAdapter => Boolean(q));

createBullBoard({
  queues: boardQueues as any,
  serverAdapter: serverAdapter,
});

const sanitizeOrigin = (url: string) => {
  return url.replace(/^["']|["']$/g, '').replace(/\/+$/, '').trim();
};

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  process.env.FRONTEND_URL,
]
  .filter((o): o is string => Boolean(o))
  .map(sanitizeOrigin);

// Support comma-separated origins in FRONTEND_URL
if (process.env.FRONTEND_URL && process.env.FRONTEND_URL.includes(',')) {
  const additional = process.env.FRONTEND_URL.split(',').map((o) => sanitizeOrigin(o)).filter(Boolean);
  allowedOrigins.push(...additional);
}

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps, curl, or postman)
    if (!origin) {
      callback(null, true);
      return;
    }
    
    const isAllowed = allowedOrigins.some((allowed) => {
      return origin === allowed || (allowed.startsWith('http://localhost') && origin.startsWith('http://localhost'));
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error(`Not allowed by CORS: Origin '${origin}' is not registered in allowed origins.`));
    }
  },
  credentials: true,
};

// Global Security headers
app.use(helmet());
app.use(cors(corsOptions));

// Meta webhook and OAuth routes (Mounted before express.json() for raw webhook signature verification)
app.use('/v1/meta', metaRouter);

// Base parser middleware
app.use(express.json());

// Root health endpoint
app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    application: "FlowNest CRM API",
    status: "Running",
    environment: process.env.NODE_ENV,
    version: "1.0.0"
  });
});

// Public health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'UP',
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV
    },
    meta: {}
  });
});

// Authentication routes (Public, with internal rate limits)
app.use('/v1/auth', authRouter);

// Agency Management routes (Protected, Agency Admin only, rate limited)
app.use('/v1/agency', generalLimiter, agencyRouter);

// Leads pipeline routes (Protected, Agency Admin or Client Owner, rate limited)
app.use('/v1/leads', generalLimiter, leadsRouter);

// Follow-ups management routes (Protected, Agency Admin or Client Owner, rate limited)
app.use('/v1/follow-ups', generalLimiter, followUpsRouter);

// Sales management routes (Protected, Client Owner only, rate limited)
app.use('/v1/sales', generalLimiter, salesRouter);

// Google Sheets Connector routes (Protected, Client Owner or Agency Admin, rate limited)
app.use('/v1/google', generalLimiter, googleSheetsRouter);

// Telegram Connector routes (Agency Bot management, public webhooks)
app.use('/v1/telegram', generalLimiter, telegramRouter);

// Client Telegram recipient endpoints (Protected)
app.use('/v1/client/telegram', generalLimiter, clientTelegramRouter);

// Agencies management routes (Protected, Super Admin only, rate limited)
app.use('/v1/agencies', generalLimiter, superAdminAgenciesRouter);

// Queue Dashboard (Protected, Super Admin only)
app.use('/admin/queues', authMiddleware, requireRoles(['super_admin']), serverAdapter.getRouter());

// System diagnostics endpoint for background workers
app.get('/system/workers', (req: Request, res: Response) => {
  res.status(200).json({
    spreadsheetScheduler: 'running',
    metaWorker: metaLeadsWorker ? 'running' : 'disabled',
    notificationWorker: notificationsWorker ? 'running' : 'disabled',
    tokenRefreshWorker: tokenRefreshWorker ? 'running' : 'disabled',
    trialWorker: trialExpiryWorker ? 'running' : 'disabled',
  });
});

// Standardized Error Handler (Catches validation, auth, and system errors)
app.use(errorHandler);

// Start listening if not imported as module (e.g. for testing)
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, async () => {
    console.log(`🚀 FlowNest CRM API is running at http://localhost:${PORT}`);
    
    const enableMeta = process.env.ENABLE_META_WORKER === 'true';
    const enableNotification = process.env.ENABLE_NOTIFICATION_WORKER === 'true';
    const enableTokenRefresh = process.env.ENABLE_TOKEN_REFRESH_WORKER === 'true';
    const enableTrial = process.env.ENABLE_TRIAL_WORKER === 'true';

    console.log('\n========================================');
    console.log('Background Workers Startup Status:');
    console.log(`Spreadsheet Scheduler: ENABLED (node-cron)`);
    console.log(`Meta Worker: ${enableMeta ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Notification Worker: ${(enableMeta && enableNotification) ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Token Refresh Worker: ${(enableMeta && enableTokenRefresh) ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Trial Worker: ${(enableMeta && enableTrial) ? 'ENABLED' : 'DISABLED'}`);
    console.log('========================================\n');

    // Always start the Google Sheets scheduler
    try {
      startSpreadsheetScheduler();
    } catch (err: any) {
      console.error('Failed to start spreadsheet scheduler:', err.message);
    }

    // Always start the Pipeline Automation scheduler
    try {
      startPipelineAutomationScheduler();
    } catch (err: any) {
      console.error('Failed to start pipeline automation scheduler:', err.message);
    }

    if (enableMeta) {
      if (enableTrial) {
        logger.info('AppStartup', 'Scheduling daily trial sweep cron...');
        try {
          await scheduleDailyTrialSweep();
        } catch (err: any) {
          console.error('Failed to schedule startup daily trial sweep:', err.message);
        }
      } else {
        logger.info('AppStartup', 'Cleaning up stale Trial Expiry repeatable jobs from Redis...');
        try {
          const { Queue } = require('bullmq');
          const tempQueue = new Queue('trial-expiry', { connection: redisConnection as any });
          const repeatable = await tempQueue.getRepeatableJobs();
          for (const job of repeatable) {
            await tempQueue.removeRepeatableByKey(job.key);
            logger.info('AppStartup', `Cleaned up stale Trial Expiry cron job: ${job.key}`);
          }
          await tempQueue.close();
        } catch (err: any) {
          console.error('Failed to clean up stale Trial Expiry repeatable jobs:', err.message);
        }
      }

      if (enableTokenRefresh) {
        logger.info('AppStartup', 'Scheduling daily token refresh cron...');
        try {
          await scheduleTokenRefresh();
        } catch (err: any) {
          console.error('Failed to schedule startup token refresh:', err.message);
        }
      } else {
        logger.info('AppStartup', 'Cleaning up stale Token Refresh repeatable jobs from Redis...');
        try {
          const { Queue } = require('bullmq');
          const tempQueue = new Queue('token-refresh', { connection: redisConnection as any });
          const repeatable = await tempQueue.getRepeatableJobs();
          for (const job of repeatable) {
            await tempQueue.removeRepeatableByKey(job.key);
            logger.info('AppStartup', `Cleaned up stale Token Refresh cron job: ${job.key}`);
          }
          await tempQueue.close();
        } catch (err: any) {
          console.error('Failed to clean up stale Token Refresh repeatable jobs:', err.message);
        }
      }

      logger.info('AppStartup', 'Scheduling Meta ad accounts sync cron...');
      try {
        await scheduleMetaSync();
      } catch (err: any) {
        console.error('Failed to schedule startup Meta sync cron:', err.message);
      }
    } else {
      logger.info('AppStartup', 'Redis background workers are disabled (ENABLE_META_WORKER=false). Skipping BullMQ setup and cleanups.');
    }
  });

  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 [Shutdown] Received ${signal}. Starting graceful shutdown...`);

    // 1. Close HTTP Server
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log('✔ [Shutdown] HTTP server closed');
          resolve();
        });
      });
    }

    // 2. Close all workers first (stops processing & polling)
    console.log('⏳ [Shutdown] Closing workers...');
    const workers = [
      { name: 'metaLeadsWorker', worker: metaLeadsWorker },
      { name: 'tokenRefreshWorker', worker: tokenRefreshWorker },
      { name: 'notificationsWorker', worker: notificationsWorker },
      { name: 'trialExpiryWorker', worker: trialExpiryWorker },
    ];

    for (const item of workers) {
      if (item.worker) {
        try {
          await item.worker.close();
          console.log(`✔ [Shutdown] Worker closed: ${item.name}`);
        } catch (err: any) {
          console.error(`❌ [Shutdown] Failed to close worker: ${item.name}`, err.message);
        }
      }
    }

    // 3. Close all queues
    console.log('⏳ [Shutdown] Closing queues...');
    const queues = [
      { name: 'metaLeadsQueue', queue: metaLeadsQueue },
      { name: 'metaLeadsFailedQueue', queue: metaLeadsFailedQueue },
      { name: 'tokenRefreshQueue', queue: tokenRefreshQueue },
      { name: 'notificationsQueue', queue: notificationsQueue },
      { name: 'trialExpiryQueue', queue: trialExpiryQueue },
    ];

    for (const item of queues) {
      if (item.queue) {
        try {
          await item.queue.close();
          console.log(`✔ [Shutdown] Queue closed: ${item.name}`);
        } catch (err: any) {
          console.error(`❌ [Shutdown] Failed to close queue: ${item.name}`, err.message);
        }
      }
    }

    // 4. Quit Redis connections
    if (redisConnection) {
      console.log('⏳ [Shutdown] Closing Redis connection pools...');
      try {
        await redisConnection.quit();
        console.log('✔ [Shutdown] Redis connections closed cleanly');
      } catch (err: any) {
        console.error('❌ [Shutdown] Failed to close Redis connections', err.message);
      }
    }

    console.log('👋 [Shutdown] Graceful shutdown complete. Exiting.');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Global safety handler for unhandled promise rejections (prevents crashes from transient Redis/network socket drops)
process.on('unhandledRejection', (reason: any) => {
  logger.error('UnhandledRejection', 'An unhandled promise rejection occurred', {
    message: reason?.message || reason,
    stack: reason?.stack
  });
});

export default app;

