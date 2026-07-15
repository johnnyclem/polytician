import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { conceptService } from './services/concept.service.js';
import { conversionService } from './services/conversion.service.js';
import { embeddingService } from './services/embedding.service.js';
import { VECTOR_DIMENSION } from './types/concept.js';
import { withRequestLogging } from './logger.js';
import { VersionConflictError } from './errors/index.js';
import { getConfig } from './config.js';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Wrap a payload in the MCP text-content envelope every tool returns. */
function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Error envelope: same shape as jsonResult but flagged so clients can branch on failure. */
function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

export async function createServer(): Promise<McpServer> {
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
      namespace: z
        .string()
        .optional()
        .describe('Namespace for agent isolation (default: "default")'),
      expectedVersion: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Expected version for optimistic concurrency control. If provided and does not match the current version, the update is rejected.'
        ),
      markdown: z.string().optional().describe('Markdown text representation'),
      thoughtform: z.any().optional().describe('ThoughtForm JSON representation'),
      embedding: z
        .array(z.number())
        .optional()
        .describe(`Vector embedding (${VECTOR_DIMENSION} dimensions)`),
      tags: z.array(z.string()).optional().describe('Tags for the concept (merged on update)'),
    },
    async ({ id, namespace, expectedVersion, markdown, thoughtform, embedding, tags }) => {
      return withRequestLogging('save_concept', uuidv4(), async () => {
        try {
          const result = await conceptService.save({
            id,
            namespace,
            expectedVersion,
            markdown,
            thoughtform,
            embedding,
            tags,
          });
          return jsonResult(result);
        } catch (error) {
          if (error instanceof VersionConflictError) {
            return errorResult({
              error: error.message,
              code: error.code,
              currentVersion: error.currentVersion,
            });
          }
          throw error;
        }
      });
    }
  );

  server.tool(
    'read_concept',
    'Read all available representations for a concept. Optionally filter to specific representations.',
    {
      id: z.string().uuid().describe('Concept UUID'),
      representations: z
        .array(z.enum(['vector', 'markdown', 'thoughtform']))
        .optional()
        .describe('Filter to specific representations'),
    },
    async ({ id, representations }) => {
      return withRequestLogging('read_concept', uuidv4(), async () => {
        const result = await conceptService.read(id, representations);
        return jsonResult(result);
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
        return jsonResult({ deleted: id });
      });
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
      return withRequestLogging('list_concepts', uuidv4(), async () => {
        const result = await conceptService.list({ namespace, limit, offset, tags });
        return jsonResult(result);
      });
    }
  );

  server.tool(
    'batch_save_concepts',
    'Bulk create or update concepts. Concepts are saved sequentially; when autoEmbed is true, embedding generation is batched (batchSize controls the embedding batch size).',
    {
      concepts: z
        .array(
          z.object({
            id: z.string().uuid().optional().describe('Concept UUID. Auto-generated if omitted.'),
            markdown: z.string().optional().describe('Markdown text representation'),
            thoughtform: z.any().optional().describe('ThoughtForm JSON representation'),
            embedding: z
              .array(z.number())
              .optional()
              .describe(`Vector embedding (${VECTOR_DIMENSION} dimensions)`),
            tags: z.array(z.string()).optional().describe('Tags for the concept'),
          })
        )
        .min(1)
        .describe('Array of concepts to save'),
      autoEmbed: z
        .boolean()
        .optional()
        .describe(
          'Auto-generate embeddings from markdown for entries that lack an embedding (default false)'
        ),
      batchSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Embedding batch size when autoEmbed is set (default 50)'),
    },
    async ({ concepts: entries, autoEmbed, batchSize }) => {
      return withRequestLogging('batch_save_concepts', uuidv4(), async () => {
        // Auto-embed markdown entries if requested
        if (autoEmbed) {
          const needsEmbedding = entries.filter(
            (e): e is typeof e & { markdown: string } => Boolean(e.markdown) && !e.embedding
          );
          if (needsEmbedding.length > 0) {
            const texts = needsEmbedding.map(e => e.markdown);
            const embeddings = await embeddingService.embedBatch(texts, batchSize ?? 50);
            needsEmbedding.forEach((entry, i) => {
              entry.embedding = embeddings[i];
            });
          }
        }

        const result = await conceptService.saveBatch(entries);
        return jsonResult({
          count: result.count,
          ids: result.saved.map(c => c.id),
        });
      });
    }
  );

  // --- Search ---

  server.tool(
    'search_concepts',
    'Semantic similarity search. Provide a text query (auto-embedded) or a raw vector. Results default to namespace-scoped; set crossNamespace to true for global search.',
    {
      query: z.string().optional().describe('Text query (will be embedded automatically)'),
      vector: z
        .array(z.number())
        .optional()
        .describe(`Raw vector (${VECTOR_DIMENSION} dimensions)`),
      k: z.number().int().positive().max(100).optional().describe('Number of results (default 10)'),
      tags: z.array(z.string()).optional().describe('Filter results by tags'),
      namespace: z.string().optional().describe('Namespace to search within (default: "default")'),
      crossNamespace: z
        .boolean()
        .optional()
        .describe('Search across all namespaces (default: false, requires explicit opt-in)'),
    },
    async ({ query, vector, k, tags, namespace, crossNamespace }) => {
      return withRequestLogging('search_concepts', uuidv4(), async () => {
        let queryEmbedding: number[];
        if (query) {
          queryEmbedding = await embeddingService.embed(query);
        } else if (vector) {
          queryEmbedding = vector;
        } else {
          return errorResult({ error: 'Provide either query (text) or vector' });
        }
        const results = await conceptService.search(queryEmbedding, k ?? 10, tags, {
          namespace,
          crossNamespace,
        });
        return jsonResult(results);
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
        return jsonResult({ converted: { from, to }, concept: updated });
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
        return jsonResult({ dimension: embedding.length, embedding });
      });
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
      return withRequestLogging('health_check', uuidv4(), async () => {
        const stats = await conceptService.getStats(namespace);
        const embeddingLoaded = await embeddingService.isLoaded();
        const llmProvider = conversionService.getLLMProviderName();
        return jsonResult({
          server: 'ok',
          embedding: {
            loaded: embeddingLoaded,
            model: getConfig().embeddingModel,
            dimension: VECTOR_DIMENSION,
          },
          llm: { provider: llmProvider },
          database: stats,
        });
      });
    }
  );

  server.tool(
    'get_stats',
    'Concept count, vector count, representation breakdown.',
    {
      namespace: z.string().optional().describe('Namespace for stats (default: "default")'),
    },
    async ({ namespace }) => {
      return withRequestLogging('get_stats', uuidv4(), async () => {
        const stats = await conceptService.getStats(namespace);
        return jsonResult(stats);
      });
    }
  );

  // --- AgentVault Backup ---

  const { registerBackupTool } = await import('./mcp/tools/agentvault.js');
  registerBackupTool(server);

  // Register AgentVault tools if integration is configured
  const cfg = getConfig();
  if (cfg.agentVault) {
    const { registerVaultTools } = await import('./integrations/agent-vault/tools/vault-tools.js');
    registerVaultTools(server, cfg.agentVault);
  }

  return server;
}
