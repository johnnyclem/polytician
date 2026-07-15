import { createServer, type Server } from 'node:http';
import { getAdapter } from './db/client.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { VECTOR_DIMENSION } from './types/concept.js';
import { serializeEmbedding } from './db/embedding-codec.js';

type CheckStatus = 'ok' | 'error' | 'not_configured';

interface CheckResult {
  status: CheckStatus;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: CheckResult;
    vector_index: CheckResult;
    sidecar: CheckResult;
  };
  timestamp: string;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    const adapter = getAdapter();
    // Quick check: getStats works if DB is healthy
    await adapter.getStats();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkVectorIndex(): Promise<CheckResult> {
  try {
    const adapter = getAdapter();
    // Quick check: vector search with a zero query should not throw
    await adapter.vectorSearch(serializeEmbedding(new Array<number>(VECTOR_DIMENSION).fill(0)), 1);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSidecar(sidecarUrl: string | null): Promise<CheckResult> {
  if (!sidecarUrl) {
    return { status: 'not_configured' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // The sidecar serves its liveness probe on /health (there is no / route).
    const base = sidecarUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return { status: 'ok' };
    return { status: 'error', error: `HTTP ${res.status.toString()}` };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

export function startHealthServer(): Server {
  const config = getConfig();

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    Promise.all([checkDatabase(), checkVectorIndex(), checkSidecar(config.sidecarUrl)])
      .then(([db, vec, sidecar]) => {
        const allOk =
          db.status === 'ok' &&
          vec.status === 'ok' &&
          (sidecar.status === 'ok' || sidecar.status === 'not_configured');

        const body: HealthResponse = {
          status: allOk ? 'ok' : 'degraded',
          checks: { database: db, vector_index: vec, sidecar },
          timestamp: new Date().toISOString(),
        };

        const statusCode = allOk ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        logger.error('health check failed', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Health check failed' }));
      });
  });

  server.listen(config.healthPort, () => {
    logger.info('health server started', { port: config.healthPort });
  });

  return server;
}
