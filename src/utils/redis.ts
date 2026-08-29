import IORedis, { RedisOptions } from 'ioredis';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const enableMeta = process.env.ENABLE_META_WORKER === 'true';

export let redisConnection: IORedis | null = null;

if (enableMeta) {
  let redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  // Strip potential quotes around the URL string (often parsed by dotenv if double-quoted in .env)
  redisUrl = redisUrl.replace(/^["']|["']$/g, '').trim();

  // Production startup safety check
  if (redisUrl.startsWith('https://') || redisUrl.startsWith('http://')) {
    const errMsg = `Redis configuration violation: REDIS_URL starts with an HTTP protocol ('${redisUrl.split('://')[0]}://'). ` +
      `IORedis is a TCP client and does not support HTTP/REST endpoints. For Upstash Redis, please use the Redis Connection String ` +
      `format (starting with 'rediss://' for secure TLS, e.g. rediss://default:password@endpoint.upstash.io:6379) instead.`;
    logger.error('RedisManager', errMsg);
    throw new Error(errMsg);
  }

  logger.info('RedisManager', 'Initializing centralized connection handlers...', {
    host: redisUrl.includes('@') ? redisUrl.split('@')[1] : redisUrl,
    tls: redisUrl.startsWith('rediss://')
  });

  // Track the last encountered Redis error globally to determine if we should abort retries
  let lastGlobalError: Error | null = null;

  // Configure base options for resilient connections
  const baseRedisOptions: RedisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    lazyConnect: true, // Do not connect on startup to save connections
    reconnectOnError: function(err: Error) {
      lastGlobalError = err;
      const targetError = err.message.toUpperCase();
      if (targetError.includes('READONLY')) {
        logger.warn('RedisManager', 'Reconnect on error check triggered for READONLY error', { error: err.message });
        return true;
      }

      // Check for terminal errors to proactively disconnect
      if (
        targetError.includes('MAX REQUESTS LIMIT EXCEEDED') ||
        targetError.includes('QUOTA EXCEEDED') ||
        targetError.includes('AUTH') ||
        targetError.includes('WRONGPASS') ||
        targetError.includes('NOAUTH') ||
        targetError.includes('CREDENTIAL')
      ) {
        logger.error('RedisManager', 'Terminal error detected in command execution. Proactively disconnecting client.', { error: err.message });
        const client = this as any;
        if (client && typeof client.disconnect === 'function') {
          process.nextTick(() => {
            try {
              client.disconnect();
              logger.error('RedisManager', 'Successfully disconnected client due to terminal error.');
            } catch (disconnectErr: any) {
              logger.error('RedisManager', 'Failed to disconnect client', { error: disconnectErr.message });
            }
          });
        }
      }

      // Return false for auth, quota, max requests, invalid credentials, and standard failures
      logger.error('RedisManager', 'No reconnect for error', { error: err.message });
      return false;
    },
    retryStrategy: (times: number) => {
      if (lastGlobalError) {
        const errMsg = lastGlobalError.message.toUpperCase();
        if (
          errMsg.includes('MAX REQUESTS LIMIT EXCEEDED') ||
          errMsg.includes('QUOTA EXCEEDED') ||
          errMsg.includes('AUTH') ||
          errMsg.includes('WRONGPASS') ||
          errMsg.includes('NOAUTH') ||
          errMsg.includes('CREDENTIAL')
        ) {
          logger.error('RedisManager', `Aborting reconnect retry strategy due to terminal error: ${lastGlobalError.message}`);
          return null; // Stops retrying completely
        }
      }
      const delay = Math.min(250 * Math.pow(2, times - 1), 30000);
      logger.info('RedisManager', `Retrying connection (attempt #${times}) in ${delay}ms...`);
      return delay;
    }
  };

  // Client connection specifically shared by all BullMQ workers and queues (requires maxRetriesPerRequest = null)
  redisConnection = new IORedis(redisUrl, {
    ...baseRedisOptions,
    maxRetriesPerRequest: null
  });

  // Register Event listeners for structured audit tracking
  const registerEventLoggers = (client: IORedis, name: string) => {
    client.on('connect', () => {
      logger.info('RedisManager', `✨ [${name}] Socket connected successfully`);
      // Clear last error on successful connection
      lastGlobalError = null;
    });

    client.on('ready', () => {
      logger.info('RedisManager', `🚀 [${name}] Client is fully initialized and ready`);
    });

    client.on('error', (err) => {
      lastGlobalError = err;
      logger.error('RedisManager', `❌ [${name}] Connection encountered an error`, { error: err.message });
    });

    client.on('reconnecting', () => {
      logger.warn('RedisManager', `🔌 [${name}] Client is attempting to reconnect...`);
    });

    client.on('close', () => {
      logger.warn('RedisManager', `🔌 [${name}] Client socket closed`);
    });

    client.on('end', () => {
      logger.info('RedisManager', `💤 [${name}] Connection pool closed (ended)`);
    });
  };

  registerEventLoggers(redisConnection, 'QueueClient');
} else {
  logger.info('RedisManager', 'Redis and background worker queues are disabled (ENABLE_META_WORKER is false). No Redis connection pool will be created.');
}

