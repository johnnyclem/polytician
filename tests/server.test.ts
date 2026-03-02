import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
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
import type { ThoughtForm } from '../src/types/thoughtform.js';

let client: Client;

function makeThoughtForm(id: string): ThoughtForm {
  return {
    id,
    rawText: 'Marie Curie pioneered research on radioactivity.',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      author: null,
      tags: ['science'],
      source: 'user_input',
    },
    entities: [
      { id: 'ent_0', text: 'Marie Curie', type: 'PERSON', confidence: 0.97, offset: { start: 0, end: 11 } },
      { id: 'ent_1', text: 'radioactivity', type: 'CONCEPT', confidence: 0.94, offset: { start: 35, end: 48 } },
    ],
    relationships: [
      { subjectId: 'ent_0', predicate: 'pioneered', objectId: 'ent_1', confidence: 0.91 },
    ],
    contextGraph: { ent_0: ['ent_1'] },
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe('MCP Server — Tool integration', () => {
  beforeEach(async () => {
    setupTestDb();
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- Tool discovery ---

  it('should list all expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'convert_concept',
      'delete_concept',
      'embed_text',
      'get_stats',
      'health_check',
      'list_concepts',
      'read_concept',
      'save_concept',
      'search_concepts',
    ]);
  });

  // --- save → read round-trip ---

  it('should save and read a concept via MCP tools', async () => {
    const saved = await callTool('save_concept', {
      markdown: '# Test concept via MCP',
      tags: ['mcp-test'],
    }) as { id: string; namespace: string; version: number };
    expect(saved.id).toBeDefined();
    expect(saved.namespace).toBe('default');
    expect(saved.version).toBe(1);

    const read = await callTool('read_concept', { id: saved.id }) as { markdown: string; tags: string[]; version: number };
    expect(read.markdown).toBe('# Test concept via MCP');
    expect(read.tags).toContain('mcp-test');
    expect(read.version).toBe(1);
  });

  // --- convert_concept: thoughtform → markdown ---

  it('should convert thoughtform → markdown via MCP tool', async () => {
    const id = '11111111-1111-4111-a111-111111111111';
    const tf = makeThoughtForm(id);
    await callTool('save_concept', { id, thoughtform: tf });

    const result = await callTool('convert_concept', {
      id,
      from: 'thoughtform',
      to: 'markdown',
    }) as { converted: { from: string; to: string }; concept: { markdown: string } };

    expect(result.converted.from).toBe('thoughtform');
    expect(result.converted.to).toBe('markdown');
    expect(result.concept.markdown).toContain('Marie Curie');
    expect(result.concept.markdown).toContain('## Entities');
    expect(result.concept.markdown).toContain('**pioneered**');
  });

  // --- convert_concept: markdown → vector ---

  it('should convert markdown → vector via MCP tool', async () => {
    const id = '22222222-2222-4222-a222-222222222222';
    await callTool('save_concept', { id, markdown: '# Quantum physics overview' });

    const result = await callTool('convert_concept', {
      id,
      from: 'markdown',
      to: 'vector',
    }) as { converted: { from: string; to: string }; concept: { embedding: number[] } };

    expect(result.converted.from).toBe('markdown');
    expect(result.converted.to).toBe('vector');
    expect(result.concept.embedding).toHaveLength(VECTOR_DIMENSION);
  });

  // --- convert_concept: thoughtform → vector ---

  it('should convert thoughtform → vector via MCP tool', async () => {
    const id = '33333333-3333-4333-a333-333333333333';
    const tf = makeThoughtForm(id);
    await callTool('save_concept', { id, thoughtform: tf });

    const result = await callTool('convert_concept', {
      id,
      from: 'thoughtform',
      to: 'vector',
    }) as { converted: { from: string; to: string }; concept: { embedding: number[] } };

    expect(result.concept.embedding).toHaveLength(VECTOR_DIMENSION);
  });

  // --- Full pipeline: save → convert → convert → search ---

  it('should run the full pipeline: save thoughtform → convert to md → convert to vec → search', async () => {
    const id = '44444444-4444-4444-a444-444444444444';
    const tf = makeThoughtForm(id);

    // Save with thoughtform
    await callTool('save_concept', { id, thoughtform: tf, tags: ['science'] });

    // Convert to markdown
    await callTool('convert_concept', { id, from: 'thoughtform', to: 'markdown' });

    // Convert to vector
    await callTool('convert_concept', { id, from: 'markdown', to: 'vector' });

    // Search
    const results = await callTool('search_concepts', {
      query: 'Marie Curie radioactivity',
      k: 5,
    }) as Array<{ id: string; representations: { vector: boolean; markdown: boolean; thoughtform: boolean } }>;

    expect(Array.isArray(results)).toBe(true);
    const found = results.find(r => r.id === id);
    expect(found).toBeDefined();
    expect(found!.representations.vector).toBe(true);
    expect(found!.representations.markdown).toBe(true);
    expect(found!.representations.thoughtform).toBe(true);
  });

  // --- LLM conversion errors surface through MCP ---

  it('should return MCP error for LLM-dependent conversion without provider', async () => {
    const id = '55555555-5555-4555-a555-555555555555';
    await callTool('save_concept', { id, markdown: '# Needs LLM' });

    // MCP SDK returns isError: true content rather than rejecting
    const result = await client.callTool({
      name: 'convert_concept',
      arguments: { id, from: 'markdown', to: 'thoughtform' },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/LLM provider|requires.*provider/i);
  });

  // --- health_check reports LLM status ---

  it('should report LLM provider as none in health_check', async () => {
    const health = await callTool('health_check', {}) as {
      server: string;
      llm: { provider: string };
      embedding: { dimension: number };
    };

    expect(health.server).toBe('ok');
    expect(health.llm.provider).toBe('none');
    expect(health.embedding.dimension).toBe(VECTOR_DIMENSION);
  });

  // --- embed_text standalone ---

  it('should embed text without creating a concept', async () => {
    const result = await callTool('embed_text', { text: 'standalone embedding test' }) as {
      dimension: number;
      embedding: number[];
    };

    expect(result.dimension).toBe(VECTOR_DIMENSION);
    expect(result.embedding).toHaveLength(VECTOR_DIMENSION);
  });

  // --- delete ---

  it('should delete a concept via MCP tool', async () => {
    const saved = await callTool('save_concept', { markdown: '# To be deleted' }) as { id: string };

    const deleted = await callTool('delete_concept', { id: saved.id }) as { deleted: string };
    expect(deleted.deleted).toBe(saved.id);

    // MCP returns isError content for not-found, not a rejected promise
    const result = await client.callTool({
      name: 'read_concept',
      arguments: { id: saved.id },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not found/i);
  });

  // --- list with pagination ---

  it('should list and paginate concepts', async () => {
    // Create 3 concepts
    await callTool('save_concept', { markdown: '# One', tags: ['batch'] });
    await callTool('save_concept', { markdown: '# Two', tags: ['batch'] });
    await callTool('save_concept', { markdown: '# Three', tags: ['batch'] });

    const page1 = await callTool('list_concepts', { limit: 2, offset: 0, tags: ['batch'] }) as {
      concepts: unknown[];
      total: number;
    };
    expect(page1.concepts).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await callTool('list_concepts', { limit: 2, offset: 2, tags: ['batch'] }) as {
      concepts: unknown[];
      total: number;
    };
    expect(page2.concepts).toHaveLength(1);
  });

  // --- get_stats ---

  it('should return database stats', async () => {
    await callTool('save_concept', { markdown: '# Stats test' });

    const stats = await callTool('get_stats', {}) as {
      conceptCount: number;
      vectorCount: number;
      representationCounts: { markdown: number; thoughtform: number; vector: number };
    };

    expect(stats.conceptCount).toBeGreaterThanOrEqual(1);
    expect(stats.representationCounts.markdown).toBeGreaterThanOrEqual(1);
  });

  // --- Namespace isolation via MCP ---

  it('should save concepts with namespace via MCP tools', async () => {
    const saved = await callTool('save_concept', {
      namespace: 'agent-x',
      markdown: '# Agent X concept',
    }) as { id: string; namespace: string };

    expect(saved.namespace).toBe('agent-x');
  });

  it('should scope list_concepts to namespace via MCP', async () => {
    await callTool('save_concept', { namespace: 'agent-a', markdown: '# A' });
    await callTool('save_concept', { namespace: 'agent-b', markdown: '# B' });

    const listA = await callTool('list_concepts', { namespace: 'agent-a' }) as {
      concepts: Array<{ namespace: string }>;
      total: number;
    };
    expect(listA.total).toBe(1);
    expect(listA.concepts[0]!.namespace).toBe('agent-a');
  });

  it('should scope search_concepts to namespace via MCP', async () => {
    await callTool('save_concept', { namespace: 'agent-a', markdown: '# Agent A data' });
    await callTool('convert_concept', {
      id: ((await callTool('list_concepts', { namespace: 'agent-a' })) as { concepts: Array<{ id: string }> }).concepts[0]!.id,
      from: 'markdown',
      to: 'vector',
    });
    await callTool('save_concept', { namespace: 'agent-b', markdown: '# Agent B data' });

    const results = await callTool('search_concepts', {
      query: 'Agent data',
      namespace: 'agent-a',
      k: 10,
    }) as Array<{ namespace: string }>;

    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.namespace).toBe('agent-a');
    }
  });

  it('should allow cross-namespace search via MCP', async () => {
    const savedA = await callTool('save_concept', {
      namespace: 'agent-a',
      markdown: '# Cross namespace test A',
    }) as { id: string };
    await callTool('convert_concept', { id: savedA.id, from: 'markdown', to: 'vector' });

    const savedB = await callTool('save_concept', {
      namespace: 'agent-b',
      markdown: '# Cross namespace test B',
    }) as { id: string };
    await callTool('convert_concept', { id: savedB.id, from: 'markdown', to: 'vector' });

    const results = await callTool('search_concepts', {
      query: 'Cross namespace test',
      crossNamespace: true,
      k: 10,
    }) as Array<{ namespace: string }>;

    expect(Array.isArray(results)).toBe(true);
    const namespaces = new Set(results.map(r => r.namespace));
    expect(namespaces.size).toBeGreaterThanOrEqual(2);
  });

  // --- Optimistic concurrency via MCP ---

  it('should return version in save_concept response', async () => {
    const saved = await callTool('save_concept', { markdown: '# Version test' }) as { version: number };
    expect(saved.version).toBe(1);
  });

  it('should accept expectedVersion for optimistic concurrency via MCP', async () => {
    const saved = await callTool('save_concept', { markdown: '# V1' }) as { id: string; version: number };
    const updated = await callTool('save_concept', {
      id: saved.id,
      expectedVersion: 1,
      markdown: '# V2',
    }) as { version: number; markdown: string };

    expect(updated.version).toBe(2);
    expect(updated.markdown).toBe('# V2');
  });

  it('should return error for version conflict via MCP', async () => {
    const saved = await callTool('save_concept', { markdown: '# V1' }) as { id: string };
    await callTool('save_concept', { id: saved.id, markdown: '# V2' }); // Now at version 2

    const result = await client.callTool({
      name: 'save_concept',
      arguments: { id: saved.id, expectedVersion: 1, markdown: '# Stale' },
    }) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const errorBody = JSON.parse(result.content[0]!.text) as { code: string; currentVersion: number };
    expect(errorBody.code).toBe('VERSION_CONFLICT');
    expect(errorBody.currentVersion).toBe(2);
  });

  // --- Namespace-scoped stats via MCP ---

  it('should return namespace-scoped stats', async () => {
    await callTool('save_concept', { namespace: 'agent-a', markdown: '# A1' });
    await callTool('save_concept', { namespace: 'agent-a', markdown: '# A2' });
    await callTool('save_concept', { namespace: 'agent-b', markdown: '# B1' });

    const statsA = await callTool('get_stats', { namespace: 'agent-a' }) as { conceptCount: number };
    expect(statsA.conceptCount).toBe(2);

    const statsB = await callTool('get_stats', { namespace: 'agent-b' }) as { conceptCount: number };
    expect(statsB.conceptCount).toBe(1);
  });
});
