import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { conceptService } from './services/concept.service.js';
import { conversionService } from './services/conversion.service.js';
import { embeddingService } from './services/embedding.service.js';
import { VECTOR_DIMENSION } from './types/concept.js';
import { withRequestLogging } from './logger.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'polytician',
    version: '2.0.0',
  });

  // --- CRUD Tools ---

  server.tool(
    'save_concept',
    'Create or update a concept with one or more representations (vector, markdown, thoughtform). Tags are merged on update.',
    {
      id: z.string().uuid().optional().describe('Concept UUID. Auto-generated if omitted.'),
      markdown: z.string().optional().describe('Markdown text representation'),
      thoughtform: z.any().optional().describe('ThoughtForm JSON representation'),
      embedding: z.array(z.number()).optional().describe(`Vector embedding (${VECTOR_DIMENSION} dimensions)`),
      tags: z.array(z.string()).optional().describe('Tags for the concept (merged on update)'),
    },
    async ({ id, markdown, thoughtform, embedding, tags }) => {
      return withRequestLogging('save_concept', uuidv4(), async () => {
        const result = await conceptService.save({ id, markdown, thoughtform, embedding, tags });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
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
      return withRequestLogging('read_concept', uuidv4(), async () => {
        const result = await conceptService.read(id, representations);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'delete_concept',
    'Delete a concept and all its representations.',
    {
      id: z.string().uuid().describe('Concept UUID'),
    },
    async ({ id }) => {
      return withRequestLogging('delete_concept', uuidv4(), async () => {
        await conceptService.delete(id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: id }) }] };
      });
    }
  );

  server.tool(
    'list_concepts',
    'List concepts with pagination and optional tag filtering.',
    {
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
    },
    async ({ limit, offset, tags }) => {
      return withRequestLogging('list_concepts', uuidv4(), async () => {
        const result = await conceptService.list({ limit, offset, tags });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  // --- Search ---

  server.tool(
    'search_concepts',
    'Semantic similarity search. Provide a text query (auto-embedded) or a raw vector.',
    {
      query: z.string().optional().describe('Text query (will be embedded automatically)'),
      vector: z.array(z.number()).optional().describe(`Raw vector (${VECTOR_DIMENSION} dimensions)`),
      k: z.number().int().positive().max(100).optional().describe('Number of results (default 10)'),
      tags: z.array(z.string()).optional().describe('Filter results by tags'),
    },
    async ({ query, vector, k, tags }) => {
      return withRequestLogging('search_concepts', uuidv4(), async () => {
        let queryEmbedding: number[];
        if (query) {
          queryEmbedding = await embeddingService.embed(query);
        } else if (vector) {
          queryEmbedding = vector;
        } else {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide either query (text) or vector' }) }] };
        }
        const results = await conceptService.search(queryEmbedding, k ?? 10, tags);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      });
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
      return withRequestLogging('convert_concept', uuidv4(), async () => {
        await conversionService.convert(id, from, to);
        const updated = await conceptService.read(id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ converted: { from, to }, concept: updated }, null, 2) }] };
      });
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
      return withRequestLogging('embed_text', uuidv4(), async () => {
        const embedding = await embeddingService.embed(text);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ dimension: embedding.length, embedding }) }] };
      });
    }
  );

  // --- Health & Diagnostics ---

  server.tool(
    'health_check',
    'Server status, embedding model status, DB stats, LLM provider status.',
    {},
    async () => {
      return withRequestLogging('health_check', uuidv4(), async () => {
        const stats = await conceptService.getStats();
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
      });
    }
  );

  server.tool(
    'get_stats',
    'Concept count, vector count, representation breakdown.',
    {},
    async () => {
      return withRequestLogging('get_stats', uuidv4(), async () => {
        const stats = await conceptService.getStats();
        return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
      });
    }
  );

  return server;
}
