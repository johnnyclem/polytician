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

export class AVHttpClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(config: AgentVaultConfig) {
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, '');
    this.token = config.apiToken;
    this.defaultTimeoutMs = config.inference.timeoutMs;
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
    if (body !== undefined) {
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > MAX_BODY_SIZE) {
        throw new Error(`Request body too large: ${bodyStr.length} > ${MAX_BODY_SIZE}`);
      }
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

      const json = (await res.json()) as {
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
    } catch (err) {
      if (err instanceof AVHttpError) throw err;
      logger.error('av-http error', err, { method, path });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
