/**
 * Lightweight structured logger for FlowNest CRM.
 * Outputs JSON-formatted log lines with timestamp, level, component, message, and optional metadata.
 * No external packages required.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogMeta {
  clientId?: string;
  agencyId?: string;
  pageId?: string;
  formId?: string;
  leadgenId?: string;
  jobId?: string | undefined;
  attempt?: number;
  [key: string]: unknown;
}

function log(level: LogLevel, component: string, message: string, meta?: LogMeta) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    component,
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (component: string, message: string, meta?: LogMeta) => log('info', component, message, meta),
  warn: (component: string, message: string, meta?: LogMeta) => log('warn', component, message, meta),
  error: (component: string, message: string, meta?: LogMeta) => log('error', component, message, meta),
  debug: (component: string, message: string, meta?: LogMeta) => log('debug', component, message, meta),
};
