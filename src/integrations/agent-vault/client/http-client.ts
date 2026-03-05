import type { AgentVaultConfig } from '../config.js';
import type { AVErrorResponse } from '../types.js';
import { logger } from '../../../logger.js';

export class AVHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly avCode: string,
    message: string,
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
    timeoutMs?: number,
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
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const start = Date.now();
    try {
      const res = await fetch(url, init);
      const latencyMs = Date.now() - start;
      logger.debug('av-http request', { method, path, status: res.status, latencyMs });

      if (!res.ok) {
        let errorBody: AVErrorResponse = { error: res.statusText, code: 'UNKNOWN' };
        try {
          errorBody = await res.json() as AVErrorResponse;
        } catch { /* ignore parse error */ }
        throw new AVHttpError(res.status, errorBody.code, errorBody.error);
      }

      return await res.json() as T;
    } catch (err) {
      if (err instanceof AVHttpError) throw err;
      logger.error('av-http error', err, { method, path });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
