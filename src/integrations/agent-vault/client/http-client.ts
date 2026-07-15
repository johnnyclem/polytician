import type { AgentVaultConfig } from '../config.js';
import type { AVErrorResponse } from '../types.js';
import { logger } from '../../../logger.js';

const MAX_URL_LENGTH = 2048;
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const ALLOWED_PATHS = [
  /^\/api\/inference$/,
  /^\/api\/memory-repo\/branches\/[^/]+$/,
  /^\/api\/memory-repo\/commits$/,
  /^\/api\/memory-repo\/tombstone$/,
  /^\/api\/archival\/upload$/,
  /^\/api\/secrets\/[^/]+$/,
];

function validatePath(path: string): void {
  if (path.length > MAX_URL_LENGTH) {
    throw new Error(`Path too long: ${path.length} > ${MAX_URL_LENGTH}`);
  }

  const normalized = path.split('?')[0] ?? path;
  const isAllowed = ALLOWED_PATHS.some(pattern => pattern.test(normalized));
  if (!isAllowed) {
    throw new Error(`Path not in allowlist: ${normalized}`);
  }
}

export class AVHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly avCode: string,
    message: string
  ) {
    super(message);
    this.name = 'AVHttpError';
  }
}

/** HTTP status codes considered transient and safe to retry. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AVHttpClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: AgentVaultConfig) {
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, '');
    this.token = config.apiToken;
    this.defaultTimeoutMs = config.inference.timeoutMs;
    this.maxRetries = config.inference.maxRetries;
  }

  async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>('GET', path, undefined, timeoutMs);
  }

  async post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>('POST', path, body, timeoutMs);
  }

  async delete<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>('DELETE', path, undefined, timeoutMs);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs?: number
  ): Promise<T> {
    validatePath(path);

    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      if (bodyStr.length > MAX_BODY_SIZE) {
        throw new Error(`Request body too large: ${bodyStr.length} > ${MAX_BODY_SIZE}`);
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(250 * 2 ** (attempt - 1));
        logger.debug('av-http retry', { method, path, attempt });
      }
      try {
        return await this.attempt<T>(method, path, bodyStr, timeoutMs);
      } catch (err) {
        lastError = err;
        // Only transient failures are retried: network errors/timeouts and
        // gateway-style 5xx. Application errors (4xx, envelope errors) are not.
        const retryable = !(err instanceof AVHttpError) || RETRYABLE_STATUSES.has(err.statusCode);
        if (!retryable || attempt === this.maxRetries) {
          logger.error('av-http error', err, { method, path, attempt });
          throw err;
        }
      }
    }
    // Unreachable: the loop always returns or throws.
    throw lastError;
  }

  private async attempt<T>(
    method: string,
    path: string,
    bodyStr: string | undefined,
    timeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'polytician-av-connector/1.0',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (bodyStr !== undefined) {
      init.body = bodyStr;
    }

    const start = Date.now();
    try {
      const res = await fetch(url, init);
      const latencyMs = Date.now() - start;
      logger.debug('av-http request', { method, path, status: res.status, latencyMs });

      if (!res.ok) {
        let errorBody: AVErrorResponse = { error: res.statusText, code: 'UNKNOWN' };
        try {
          errorBody = (await res.json()) as AVErrorResponse;
        } catch {
          /* ignore parse error */
        }
        throw new AVHttpError(res.status, errorBody.code, errorBody.error);
      }

      // Tolerate empty bodies (204 or bodyless 200) for void-style endpoints.
      const text = await res.text();
      if (res.status === 204 || text.length === 0) {
        return undefined as T;
      }

      const json = JSON.parse(text) as {
        success?: boolean;
        data?: T;
        error?: { message?: string };
      };

      if (json && typeof json === 'object' && 'success' in json) {
        if (json.success === false) {
          throw new AVHttpError(res.status, 'API_ERROR', json.error?.message ?? 'Unknown error');
        }
        if ('data' in json) {
          return json.data as T;
        }
      }

      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
