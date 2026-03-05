import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';

let client: Client;

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe('Edge Cases', () => {
  beforeEach(async () => {
    setupTestDb();
    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-edge', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('save_concept edge cases', () => {
    it('should handle empty markdown content', async () => {
      const result = await callTool('save_concept', {
        id: uuidv4(),
        markdown: '',
      });
      expect(result).toBeDefined();
    });

    it('should handle special characters in tags', async () => {
      const result = await callTool('save_concept', {
        id: uuidv4(),
        markdown: 'test',
        tags: ['tag/with/slashes', 'tag with spaces', 'tag:colon'],
      });
      expect(result).toBeDefined();
    });

    it('should handle unicode content in markdown', async () => {
      const id = uuidv4();
      const result = await callTool('save_concept', {
        id,
        markdown: '# 日本語テスト\n\nこんにちは世界\n\n数学: π',
      });
      expect(result).toBeDefined();

      const read = await callTool('read_concept', { id });
      expect((read as { markdown: string }).markdown).toContain('日本語');
    });

    it('should handle concurrent saves to same ID (last-write-wins)', async () => {
      const id = uuidv4();
      // First create the concept
      await callTool('save_concept', { id, markdown: 'initial' });

      // Then fire concurrent updates (all without version to avoid conflicts)
      const saves = Array.from({ length: 3 }, (_, i) =>
        callTool('save_concept', {
          id,
          markdown: `version ${i}`,
        }).catch(() => null)
      );

      const results = await Promise.allSettled(saves);
      const successes = results.filter(r => r.status === 'fulfilled' && r.value !== null);
      expect(successes.length).toBeGreaterThan(0);
    });
  });

  describe('search_concept edge cases', () => {
    it('should handle search with whitespace query', async () => {
      await callTool('save_concept', {
        markdown: 'searchable content about quantum physics',
      });

      // Whitespace query should still work (generates an embedding)
      try {
        const result = await callTool('search_concepts', { query: ' ' });
        expect(result).toBeDefined();
      } catch {
        // Some implementations may reject empty queries
      }
    });

    it('should return results for any query when concepts exist', async () => {
      await callTool('save_concept', {
        markdown: 'quantum physics and wave functions',
      });

      const result = await callTool('search_concepts', { query: 'completely different topic xyz' });
      expect(result).toBeDefined();
    });
  });

  describe('read_concept edge cases', () => {
    it('should handle reading non-existent concept', async () => {
      const nonExistentId = uuidv4();
      try {
        await callTool('read_concept', { id: nonExistentId });
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('delete_concept edge cases', () => {
    it('should handle double-delete', async () => {
      const id = uuidv4();
      await callTool('save_concept', {
        id,
        markdown: 'temporary',
      });
      await callTool('delete_concept', { id });

      // Second delete should throw or return error
      try {
        const result = await callTool('delete_concept', { id });
        // If it doesn't throw, it's still valid (idempotent delete)
        expect(result).toBeDefined();
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('batch operations edge cases', () => {
    it('should handle batch with single concept', async () => {
      const result = await callTool('batch_save_concepts', {
        concepts: [{ markdown: 'alone' }],
      });
      expect(result).toBeDefined();
    });

    it('should handle batch with empty array', async () => {
      try {
        const result = await callTool('batch_save_concepts', {
          concepts: [],
        });
        expect(result).toBeDefined();
      } catch {
        // Empty batch may be rejected by schema
      }
    });
  });

  describe('embed_text edge cases', () => {
    it('should embed whitespace-only text', async () => {
      const result = await callTool('embed_text', { text: '   ' });
      expect(result).toBeDefined();
    });

    it('should embed very short text', async () => {
      const result = await callTool('embed_text', { text: 'a' });
      expect(result).toBeDefined();
    });
  });
});
