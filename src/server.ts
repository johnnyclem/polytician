import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { conceptService } from './services/concept.service.js';
import { conversionService } from './services/conversion.service.js';
import { embeddingService } from './services/embedding.service.js';
import { VECTOR_DIMENSION } from './types/concept.js';
import { VersionConflictError } from './errors/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'polytician',
    version: '2.0.0',
  });

  // --- CRUD Tools ---

  server.tool(
    'save_concept',
    'Create or update a concept with one or more representations (vector, markdown, thoughtform). Tags are merged on update. Supports namespace isolation and optimistic concurrency via expectedVersion.',
    {
      id: z.string().uuid().optional().describe('Concept UUID. Auto-generated if omitted.'),
      namespace: z.string().optional().describe('Namespace for agent isolation (default: "default")'),
      expectedVersion: z.number().int().positive().optional().describe('Expected version for optimistic concurrency control. If provided and does not match the current version, the update is rejected.'),
      markdown: z.string().optional().describe('Markdown text representation'),
      thoughtform: z.any().optional().describe('ThoughtForm JSON representation'),
      embedding: z.array(z.number()).optional().describe(`Vector embedding (${VECTOR_DIMENSION} dimensions)`),
      tags: z.array(z.string()).optional().describe('Tags for the concept (merged on update)'),
    },
    async ({ id, namespace, expectedVersion, markdown, thoughtform, embedding, tags }) => {
      try {
        const result = await conceptService.save({ id, namespace, expectedVersion, markdown, thoughtform, embedding, tags });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (error instanceof VersionConflictError) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: error.message,
                code: error.code,
                currentVersion: error.currentVersion,
              }),
            }],
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'read_concept',
    'Read all available representations for a concept. Optionally filter to specific representations.',
    {
      id: z.string().uuid().describe('Concept UUID'),
      representations: z.array(z.enum(['vector', 'markdown', 'thoughtform'])).optional().describe('Filter to specific representations'),
    },
    async ({ id, representations }) => {
      const result = await conceptService.read(id, representations);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'delete_concept',
    'Delete a concept and all its representations.',
    {
      id: z.string().uuid().describe('Concept UUID'),
    },
    async ({ id }) => {
      await conceptService.delete(id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: id }) }] };
    }
  );

  server.tool(
    'list_concepts',
    'List concepts with pagination and optional tag filtering. Results are scoped to the specified namespace.',
    {
      namespace: z.string().optional().describe('Namespace to list from (default: "default")'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
    },
    async ({ namespace, limit, offset, tags }) => {
      const result = await conceptService.list({ namespace, limit, offset, tags });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'batch_save_concepts',
    'Bulk create or update concepts. Processes embedding generation in batches and defers vector index updates until batch completion for improved throughput.',
    {
      concepts: z.array(z.object({
        id: z.string().uuid().optional().describe('Concept UUID. Auto-generated if omitted.'),
        markdown: z.string().optional().describe('Markdown text representation'),
        thoughtform: z.any().optional().describe('ThoughtForm JSON representation'),
        embedding: z.array(z.number()).optional().describe(`Vector embedding (${VECTOR_DIMENSION} dimensions)`),
        tags: z.array(z.string()).optional().describe('Tags for the concept'),
      })).min(1).describe('Array of concepts to save'),
      autoEmbed: z.boolean().optional().describe('Auto-generate embeddings from markdown for entries that lack an embedding (default false)'),
      batchSize: z.number().int().positive().optional().describe('Batch size for processing (default 50)'),
    },
    async ({ concepts: entries, autoEmbed, batchSize }) => {
      // Auto-embed markdown entries if requested
      if (autoEmbed) {
        const needsEmbedding = entries.filter(e => e.markdown && !e.embedding);
        if (needsEmbedding.length > 0) {
          const texts = needsEmbedding.map(e => e.markdown!);
          const embeddings = await embeddingService.embedBatch(texts, batchSize ?? 50);
          needsEmbedding.forEach((entry, i) => {
            entry.embedding = embeddings[i];
          });
        }
      }

      const result = await conceptService.saveBatch(entries, { batchSize });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            count: result.count,
            ids: result.saved.map(c => c.id),
          }, null, 2),
        }],
      };
    }
  );

  // --- Search ---

  server.tool(
    'search_concepts',
    'Semantic similarity search. Provide a text query (auto-embedded) or a raw vector. Results default to namespace-scoped; set crossNamespace to true for global search.',
    {
      query: z.string().optional().describe('Text query (will be embedded automatically)'),
      vector: z.array(z.number()).optional().describe(`Raw vector (${VECTOR_DIMENSION} dimensions)`),
      k: z.number().int().positive().max(100).optional().describe('Number of results (default 10)'),
      tags: z.array(z.string()).optional().describe('Filter results by tags'),
      namespace: z.string().optional().describe('Namespace to search within (default: "default")'),
      crossNamespace: z.boolean().optional().describe('Search across all namespaces (default: false, requires explicit opt-in)'),
    },
    async ({ query, vector, k, tags, namespace, crossNamespace }) => {
      let queryEmbedding: number[];
      if (query) {
        queryEmbedding = await embeddingService.embed(query);
      } else if (vector) {
        queryEmbedding = vector;
      } else {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide either query (text) or vector' }) }] };
      }
      const results = await conceptService.search(queryEmbedding, k ?? 10, tags, { namespace, crossNamespace });
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  // --- Conversion ---

  server.tool(
    'convert_concept',
    'Convert a concept from one representation to another. Non-LLM paths: markdown→vector, thoughtform→vector, thoughtform→markdown. LLM paths: markdown→thoughtform, vector→markdown, vector→thoughtform.',
    {
      id: z.string().uuid().describe('Concept UUID'),
      from: z.enum(['vector', 'markdown', 'thoughtform']).describe('Source representation'),
      to: z.enum(['vector', 'markdown', 'thoughtform']).describe('Target representation'),
    },
    async ({ id, from, to }) => {
      await conversionService.convert(id, from, to);
      const updated = await conceptService.read(id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ converted: { from, to }, concept: updated }, null, 2) }] };
    }
  );

  // --- Embedding ---

  server.tool(
    'embed_text',
    'Generate an embedding vector for arbitrary text without saving it as a concept.',
    {
      text: z.string().min(1).describe('Text to embed'),
    },
    async ({ text }) => {
      const embedding = await embeddingService.embed(text);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ dimension: embedding.length, embedding }) }] };
    }
  );

  // --- Health & Diagnostics ---

  server.tool(
    'health_check',
    'Server status, embedding model status, DB stats, LLM provider status.',
    {
      namespace: z.string().optional().describe('Namespace for stats (default: "default")'),
    },
    async ({ namespace }) => {
      const stats = await conceptService.getStats(namespace);
      const embeddingLoaded = await embeddingService.isLoaded();
      const llmProvider = conversionService.getLLMProviderName();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            server: 'ok',
            embedding: {
              loaded: embeddingLoaded,
              model: 'Xenova/all-MiniLM-L6-v2',
              dimension: VECTOR_DIMENSION,
            },
            llm: { provider: llmProvider },
            database: stats,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'get_stats',
    'Concept count, vector count, representation breakdown.',
    {
      namespace: z.string().optional().describe('Namespace for stats (default: "default")'),
    },
    async ({ namespace }) => {
      const stats = await conceptService.getStats(namespace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  return server;
}
