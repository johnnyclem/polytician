import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createFaissRebuildClient,
  FaissRebuildError,
} from '../src/lib/polyvault/faiss-client.js';

// --- Tiny HTTP server to mock the Python sidecar ---

let server: Server;
let baseUrl: string;
let lastRequestBody: unknown = null;
let responseOverride: { status: number; body: unknown } | null = null;

function setResponse(status: number, body: unknown): void {
  responseOverride = { status, body };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      lastRequestBody = JSON.parse(body);

      if (responseOverride) {
        res.writeHead(responseOverride.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseOverride.body));
        responseOverride = null;
        return;
      }

      if (req.url === '/polyvault/faiss/rebuild' && req.method === 'POST') {
        const parsed = JSON.parse(body) as { thoughtforms: unknown[]; mode: string };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          rebuilt: true,
          vectorCount: (parsed.thoughtforms as unknown[]).length,
        }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  lastRequestBody = null;
  responseOverride = null;
});

describe('FaissRebuildClient', () => {
  it('sends thoughtforms and mode to the sidecar', async () => {
    const client = createFaissRebuildClient(baseUrl);

    const result = await client.rebuildIndex(
      [
        {
          schemaVersion: '1.0',
          id: 'tf_1',
          entities: [],
          relationships: [],
          contextGraph: {},
          metadata: {
            createdAtMs: 1000,
            updatedAtMs: 1000,
            source: 'test',
            contentHash: 'a'.repeat(64),
            redaction: { rawTextOmitted: false },
          },
        },
      ] as any[],
      'replace',
    );

    expect(result.rebuilt).toBe(true);
    expect(result.vectorCount).toBe(1);
    expect(lastRequestBody).toEqual(
      expect.objectContaining({
        mode: 'replace',
        thoughtforms: expect.arrayContaining([
          expect.objectContaining({ id: 'tf_1' }),
        ]),
      }),
    );
  });

  it('handles trailing slash in sidecar URL', async () => {
    const client = createFaissRebuildClient(`${baseUrl}/`);
    const result = await client.rebuildIndex([], 'replace');
    expect(result.rebuilt).toBe(true);
    expect(result.vectorCount).toBe(0);
  });

  it('throws FaissRebuildError on server error', async () => {
    setResponse(500, { error: 'Model not initialized', code: 'ERR_SERIALIZE' });

    const client = createFaissRebuildClient(baseUrl);

    await expect(
      client.rebuildIndex([], 'replace'),
    ).rejects.toThrow(FaissRebuildError);

    try {
      await client.rebuildIndex([], 'replace');
    } catch (err) {
      // responseOverride was consumed, set it again
    }
  });

  it('throws FaissRebuildError on validation error', async () => {
    setResponse(400, { error: 'Bad request', code: 'ERR_VALIDATION' });

    const client = createFaissRebuildClient(baseUrl);

    await expect(
      client.rebuildIndex([], 'replace'),
    ).rejects.toThrow(FaissRebuildError);
  });

  it('passes upsert mode correctly', async () => {
    const client = createFaissRebuildClient(baseUrl);
    await client.rebuildIndex([], 'upsert');

    expect(lastRequestBody).toEqual(
      expect.objectContaining({ mode: 'upsert' }),
    );
  });
});
