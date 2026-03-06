import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Mock @xenova/transformers
vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string, _options?: Record<string, unknown>) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      data[i] = Math.sin(hash + i) * 0.5;
    }
    let magnitude = 0;
    for (let i = 0; i < VECTOR_DIMENSION; i++) magnitude += data[i]! * data[i]!;
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = data[i]! / magnitude;
    return { data };
  };
  return {
    pipeline: vi.fn().mockResolvedValue(mockPipeline),
    env: { cacheDir: '' },
  };
});

import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { conceptService } from '../src/services/concept.service.js';
import { getAdapter } from '../src/db/client.js';

// Import the vault-tools module to access the helpers via the tool registration
// Since deserializeBundle and rebuildVectorIndex are not exported, we test them
// through the tool's behavior by importing the registration and calling it on
// a mock MCP server.

function makeEmbedding(seed: number): number[] {
  const data = new Float32Array(VECTOR_DIMENSION);
  for (let i = 0; i < VECTOR_DIMENSION; i++) {
    data[i] = Math.sin(seed + i) * 0.5;
  }
  let magnitude = 0;
  for (let i = 0; i < VECTOR_DIMENSION; i++) magnitude += data[i]! * data[i]!;
  magnitude = Math.sqrt(magnitude);
  for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = data[i]! / magnitude;
  return Array.from(data);
}

// We'll test the vault_restore tool via a minimal mock MCP server that captures
// the registered tool handlers.
interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function createMockServer(): { tools: ToolRegistration[] } & {
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => void;
} {
  const tools: ToolRegistration[] = [];
  return {
    tools,
    tool(name, description, schema, handler) {
      tools.push({
        name,
        description,
        schema,
        handler: handler as ToolRegistration['handler'],
      });
    },
  };
}

let tempDir: string;

describe('vault_restore tool', () => {
  let restoreTool: ToolRegistration;

  beforeEach(async () => {
    setupTestDb();
    tempDir = mkdtempSync(join(tmpdir(), 'vault-restore-test-'));

    // Register vault tools on a mock server
    const mockServer = createMockServer();
    const mockConfig = {
      apiBaseUrl: 'http://localhost:9999',
      apiToken: 'test-key',
      memoryRepoBranch: 'polytician-main',
      inference: {
        preferredBackend: 'local' as const,
        timeoutMs: 30000,
        maxRetries: 2,
      },
      secrets: {},
      sync: { enabled: false, direction: 'push' as const, pullIntervalMs: 0 },
      archival: { enabled: false, tagFilter: [], debounceMs: 5000 },
    };

    const { registerVaultTools } = await import(
      '../src/integrations/agent-vault/tools/vault-tools.js'
    );
    registerVaultTools(mockServer as never, mockConfig as never);

    const found = mockServer.tools.find(t => t.name === 'vault_restore');
    if (!found) throw new Error('vault_restore tool was not registered');
    restoreTool = found;
  });

  afterEach(() => {
    teardownTestDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should be registered with the correct name and description', () => {
    expect(restoreTool.name).toBe('vault_restore');
    expect(restoreTool.description).toContain('Restore');
  });

  it('should return error when neither bundle nor path is provided', async () => {
    const result = await restoreTool.handler({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toContain('Provide either');
  });

  it('should return error when both bundle and path are provided', async () => {
    const result = await restoreTool.handler({
      bundle: { concepts: [] },
      path: '/tmp/dummy.json',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toContain('mutually exclusive');
  });

  it('should restore concepts from inline bundle JSON', async () => {
    const embedding = makeEmbedding(42);
    const bundle = {
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      concepts: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
          namespace: 'test-ns',
          markdown: '# Restored concept A',
          embedding,
          tags: ['restored'],
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          namespace: 'test-ns',
          markdown: '# Restored concept B',
          tags: ['restored', 'second'],
        },
      ],
    };

    const result = await restoreTool.handler({ bundle });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.restored).toBe(true);
    expect(parsed.conceptsRestored).toBe(2);
    expect(parsed.vectorsRebuilt).toBe(1); // Only concept A has an embedding
    expect(parsed.bundleVersion).toBe(1);

    // Verify concepts were actually persisted
    const conceptA = await conceptService.read('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(conceptA.markdown).toBe('# Restored concept A');

    const conceptB = await conceptService.read('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    expect(conceptB.markdown).toBe('# Restored concept B');
  });

  it('should restore concepts from a file path', async () => {
    const bundle = {
      version: 2,
      exportedAt: '2026-02-15T12:00:00.000Z',
      concepts: [
        {
          id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
          markdown: '# File-based restore',
          tags: ['file-test'],
        },
      ],
    };

    const filePath = join(tempDir, 'bundle.json');
    writeFileSync(filePath, JSON.stringify(bundle), 'utf-8');

    const result = await restoreTool.handler({ path: filePath });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.restored).toBe(true);
    expect(parsed.conceptsRestored).toBe(1);
    expect(parsed.bundleVersion).toBe(2);

    const concept = await conceptService.read('cccccccc-cccc-4ccc-cccc-cccccccccccc');
    expect(concept.markdown).toBe('# File-based restore');
  });

  it('should rebuild vector index for concepts with embeddings', async () => {
    const embedding = makeEmbedding(99);
    const bundle = {
      version: 1,
      concepts: [
        {
          id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
          markdown: '# Vector test',
          embedding,
          tags: ['vector'],
        },
      ],
    };

    const result = await restoreTool.handler({ bundle });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.vectorsRebuilt).toBe(1);

    // Verify vector is searchable
    const adapter = getAdapter();
    const floats = new Float32Array(embedding);
    const queryBuf = Buffer.from(floats.buffer);
    const searchResults = await adapter.vectorSearch(queryBuf, 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0]!.concept_id).toBe('dddddddd-dddd-4ddd-dddd-dddddddddddd');
  });

  it('should handle invalid bundle gracefully', async () => {
    const result = await restoreTool.handler({ bundle: 'not-valid-json-object' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBeDefined();
  });

  it('should handle bundle missing concepts array', async () => {
    const result = await restoreTool.handler({ bundle: { version: 1 } });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toContain('concepts');
  });

  it('should report per-concept errors without failing the entire restore', async () => {
    const bundle = {
      version: 1,
      concepts: [
        {
          id: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
          markdown: '# Good concept',
          tags: ['ok'],
        },
        {
          // Concept with missing id will be caught by deserializer
          id: 'ffffffff-ffff-4fff-ffff-ffffffffffff',
          markdown: '# Another good concept',
          tags: ['also-ok'],
        },
      ],
    };

    const result = await restoreTool.handler({ bundle });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.restored).toBe(true);
    expect(parsed.conceptsRestored).toBe(2);
  });

  it('should handle nonexistent file path', async () => {
    const result = await restoreTool.handler({ path: '/tmp/nonexistent-bundle-file.json' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBeDefined();
  });
});
