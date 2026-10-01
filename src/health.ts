import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getAdapter } from './db/client.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { VECTOR_DIMENSION } from './types/concept.js';
import { serializeEmbedding } from './db/embedding-codec.js';

type CheckStatus = 'ok' | 'error';

interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: { status: CheckStatus };
    vector_index: { status: CheckStatus };
  };
  timestamp: string;
}

/**
 * Run one check. Failures are logged here; the HTTP response only says
 * "error", so a network peer learns nothing about the database.
 */
async function check(name: string, fn: () => Promise<unknown>): Promise<{ status: CheckStatus }> {
  try {
    await fn();
    return { status: 'ok' };
  } catch (err) {
    logger.warn('health check failed', {
      check: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'error' };
  }
}

/** Readiness: the database answers and a 1-NN vector query runs. */
export async function readiness(): Promise<{ statusCode: number; body: HealthResponse }> {
  const [database, vectorIndex] = await Promise.all([
    check('database', async () => getAdapter().getStats()),
    check('vector_index', async () => {
      const probe = new Array<number>(VECTOR_DIMENSION).fill(0);
      probe[0] = 1;
      return getAdapter().vectorSearch(serializeEmbedding(probe), 1, { namespaces: null });
    }),
  ]);
  const ok = database.status === 'ok' && vectorIndex.status === 'ok';
  return {
    statusCode: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded',
      checks: { database, vector_index: vectorIndex },
      timestamp: new Date().toISOString(),
    },
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Serve `GET /health` (readiness: database and vector index) and
 * `GET /health/live` (liveness: the process answers). Returns false for
 * any other request so the caller can route it.
 */
export function handleHealthRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health' && path !== '/health/live') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  if (path === '/health/live') {
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return true;
  }
  readiness()
    .then(({ statusCode, body }) => sendJson(res, statusCode, body))
    .catch((err: unknown) => {
      logger.error('health check failed', err);
      sendJson(res, 500, { status: 'error' });
    });
  return true;
}

/**
 * The stdio transport's optional health endpoint: off unless
 * POLYTICIAN_HEALTH_PORT is set, bound to POLYTICIAN_HEALTH_HOST (default
 * 127.0.0.1). A port that is already taken (say, by another polytician
 * started by a second MCP client) is logged and the MCP server keeps running.
 * The HTTP transport serves the same endpoints on its own port.
 */
export function startHealthServer(): Server | null {
  const config = getConfig();
  if (config.healthPort === null) return null;
  const port = config.healthPort;
  const host = config.healthHost;

  const server = createServer((req, res) => {
    if (!handleHealthRequest(req, res)) sendJson(res, 404, { error: 'Not found' });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.warn('health server not started; MCP over stdio continues', {
      host,
      port,
      error: err.code ?? err.message,
    });
  });
  server.listen(port, host, () => {
    logger.info('health server started', { host, port });
  });
  return server;
}
