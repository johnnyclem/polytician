import { PolyticianError } from './errors/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getConfiguredLevel(): LogLevel {
  const raw = process.env['LOG_LEVEL']?.toLowerCase();
  if (raw && raw in LEVELS) return raw as LogLevel;
  return 'info';
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  operation?: string;
  duration_ms?: number;
  error?: {
    type: string;
    code: string;
    message: string;
  };
  [key: string]: unknown;
}

function write(entry: LogEntry): void {
  const minLevel = LEVELS[getConfiguredLevel()];
  if (LEVELS[entry.level] < minLevel) return;
  // Write to stderr so it doesn't interfere with MCP stdio on stdout
  process.stderr.write(JSON.stringify(entry) + '\n');
}

function classifyError(err: unknown): LogEntry['error'] {
  if (err instanceof PolyticianError) {
    return { type: err.name, code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { type: err.name, code: 'INTERNAL_ERROR', message: err.message };
  }
  return { type: 'UnknownError', code: 'UNKNOWN', message: String(err) };
}

export const logger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    write({ timestamp: new Date().toISOString(), level: 'debug', message, ...fields });
  },
  info(message: string, fields?: Record<string, unknown>): void {
    write({ timestamp: new Date().toISOString(), level: 'info', message, ...fields });
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    write({ timestamp: new Date().toISOString(), level: 'warn', message, ...fields });
  },
  error(message: string, err?: unknown, fields?: Record<string, unknown>): void {
    write({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      ...(err !== undefined ? { error: classifyError(err) } : {}),
      ...fields,
    });
  },
};

/**
 * Wraps an async handler function with structured request logging.
 * Records requestId, operation name, duration_ms, and error classification.
 */
export async function withRequestLogging<T>(
  operation: string,
  requestId: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  logger.debug('request.start', { requestId, operation });
  try {
    const result = await fn();
    const duration_ms = Date.now() - start;
    logger.info('request.complete', { requestId, operation, duration_ms });
    return result;
  } catch (err) {
    const duration_ms = Date.now() - start;
    logger.error('request.error', err, { requestId, operation, duration_ms });
    throw err;
  }
}
