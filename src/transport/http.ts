import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { handleHealthRequest } from '../health.js';
import { logger } from '../logger.js';
import { ConfigurationError } from '../errors/index.js';
import type { HttpConfig } from '../config.js';

/** Path of the MCP endpoint. */
export const MCP_PATH = '/mcp';

/**
 * Largest request body read. A single save can carry 1,000,000 characters of
 * markdown plus a 2,000,000-character thoughtform; bigger batches must be split.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface HttpServerOptions {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

export interface RunningHttpServer {
  server: Server;
  /** Base URL, e.g. http://127.0.0.1:8788 */
  url: string;
  close(): Promise<void>;
}

/**
 * The bearer token: POLYTICIAN_HTTP_TOKEN if set, else the token file. A
 * missing file is created with a fresh 256-bit token, mode 0600; an existing
 * file that group or other users can read is refused.
 */
export function loadOrCreateHttpToken(http: Pick<HttpConfig, 'token' | 'tokenFile'>): string {
  if (http.token) return http.token;
  const file = http.tokenFile;
  if (existsSync(file)) {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
      throw new ConfigurationError(
        `HTTP token file ${file} is readable by other users; restrict it to its owner (chmod 0600 ${file})`
      );
    }
    const token = readFileSync(file, 'utf-8').trim();
    if (token.length < 32) {
      throw new ConfigurationError(`HTTP token file ${file} must hold at least 32 characters`);
    }
    return token;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  logger.info('generated HTTP bearer token', { tokenFile: file });
  return token;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Host header without its port, lower-cased ("[::1]:8788" → "[::1]"). */
function hostName(header: string | undefined): string | null {
  if (!header) return null;
  const host = header.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? null : host.slice(0, end + 1);
  }
  return host.split(':')[0] ?? null;
}

function hostAllowed(header: string | undefined, allowed: readonly string[]): boolean {
  const name = hostName(header);
  if (!name) return false;
  const bare = name.startsWith('[') ? name.slice(1, -1) : name;
  return allowed.some(a => {
    const entry = a.toLowerCase();
    return entry === name || entry === bare;
  });
}

function reject(res: ServerResponse, status: number, message: string, headers = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: message }));
}

/**
 * MCP over Streamable HTTP (stateless: every POST gets a fresh server and
 * transport, so replicas behind a load balancer need no session affinity),
 * plus /health and /health/live on the same port.
 *
 * /mcp requires, in order: a Host header naming an allowed host (DNS
 * rebinding), no Origin or an allowed one (browsers), and
 * `Authorization: Bearer <token>`. The health endpoints need none of these
 * and reveal only ok/error.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const expected = digest(options.token);

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected);
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host, options.allowedHosts)) {
      reject(res, 403, 'Host not allowed');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      reject(res, 403, 'Origin not allowed');
      return;
    }
    if (!authorized(req)) {
      reject(res, 401, 'Missing or invalid bearer token', {
        'WWW-Authenticate': 'Bearer realm="polytician"',
      });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
      reject(res, 405, 'Method not allowed', { Allow: 'POST' });
      return;
    }

    const server = await createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createHttpServer((req, res) => {
    if (handleHealthRequest(req, res)) return;
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      reject(res, 404, 'Not found');
      return;
    }
    handleMcp(req, res).catch((err: unknown) => {
      logger.error('mcp http request failed', err);
      if (!res.headersSent) reject(res, 500, 'Internal error');
      else res.end();
    });
  });

  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
  server.on('error', err => logger.error('http server error', err));

  const { port } = server.address() as AddressInfo;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    server,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
