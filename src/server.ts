import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { conceptService } from './services/concept.service.js';
import { conversionService } from './services/conversion.service.js';
import { embeddingService } from './services/embedding.service.js';
import { crossNamespaceScope, resolveNamespace } from './services/namespace-policy.js';
import {
  EmbeddingSchema,
  MarkdownSchema,
  NamespaceSchema,
  RepresentationTypeSchema,
  TagsSchema,
  ThoughtFormInputSchema,
  VECTOR_DIMENSION,
} from './types/concept.js';
import { LIMITS } from './types/limits.js';
import { ValidationError } from './errors/index.js';
import { getConfig } from './config.js';
import { jsonResult, runTool } from './mcp/tool-result.js';
import { registerBackupTools } from './mcp/tools/backup.js';

const namespaceArg = NamespaceSchema.optional().describe(
  'Namespace (default: "default"). Must be in POLYTICIAN_NAMESPACES when the operator set one.'
);

const conceptFields = {
  id: z.string().uuid().optional().describe('Concept UUID. Auto-generated if omitted.'),
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Expected current version. The write is rejected with VERSION_CONFLICT unless it matches.'
    ),
  markdown: MarkdownSchema.optional().describe('Markdown text representation'),
  thoughtform: ThoughtFormInputSchema.optional().describe(
    'ThoughtForm JSON: the native shape (ISO timestamps, entities with text) or a PolyVault v1 ThoughtForm'
  ),
  embedding: EmbeddingSchema.optional().describe(
    `Vector embedding (${VECTOR_DIMENSION} finite numbers, not all zero)`
  ),
  tags: TagsSchema.optional().describe(
    `Tags, merged on update (at most ${LIMITS.tags}, each ${LIMITS.tagChars} characters or fewer)`
  ),
};

const autoEmbedArg = z
  .boolean()
  .optional()
  .describe(
    'Derive the vector from the markdown (else the thoughtform text) when no embedding is given, so the concept is searchable (default true). Never replaces a caller-supplied vector.'
  );

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'polytician',
    version: '2.0.0',
  });

  // --- CRUD Tools ---

  server.registerTool(
    'save_concept',
    {
      description:
        'Create or update a concept with one or more representations (vector, markdown, thoughtform). A new concept needs at least one. Tags are merged on update. The vector is derived from the text unless autoEmbed is false. An update must name the namespace the concept lives in; expectedVersion guards against concurrent writers.',
      inputSchema: z
        .object({ ...conceptFields, namespace: namespaceArg, autoEmbed: autoEmbedArg })
        .strict(),
    },
    async ({ namespace, autoEmbed, ...fields }) =>
      runTool('save_concept', async () => {
        const result = await conceptService.save({
          ...fields,
          namespace: resolveNamespace(namespace),
          autoEmbed: autoEmbed ?? true,
        });
        return jsonResult(result);
      })
  );

  server.registerTool(
    'read_concept',
    {
      description:
        'Read all available representations for a concept in a namespace. Optionally filter to specific representations.',
      inputSchema: z
        .object({
          id: z.string().uuid().describe('Concept UUID'),
          namespace: namespaceArg,
          representations: z
            .array(RepresentationTypeSchema)
            .optional()
            .describe('Filter to specific representations'),
        })
        .strict(),
    },
    async ({ id, namespace, representations }) =>
      runTool('read_concept', async () => {
        const result = await conceptService.read(id, representations, {
          namespace: resolveNamespace(namespace),
        });
        return jsonResult(result);
      })
  );

  server.registerTool(
    'delete_concept',
    {
      description: 'Delete a concept (in the given namespace) and all its representations.',
      inputSchema: z
        .object({
          id: z.string().uuid().describe('Concept UUID'),
          namespace: namespaceArg,
        })
        .strict(),
    },
    async ({ id, namespace }) =>
      runTool('delete_concept', async () => {
        await conceptService.delete(id, { namespace: resolveNamespace(namespace) });
        return jsonResult({ deleted: id });
      })
  );

  server.registerTool(
    'list_concepts',
    {
      description:
        'List concepts with pagination and optional tag filtering (exact tag match). Results are scoped to the namespace.',
      inputSchema: z
        .object({
          namespace: namespaceArg,
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('Max results (default 50)'),
          offset: z.number().int().min(0).optional().describe('Pagination offset'),
          tags: TagsSchema.optional().describe('Only concepts carrying every one of these tags'),
        })
        .strict(),
    },
    async ({ namespace, limit, offset, tags }) =>
      runTool('list_concepts', async () => {
        const result = await conceptService.list({
          namespace: resolveNamespace(namespace),
          limit,
          offset,
          tags,
        });
        return jsonResult(result);
      })
  );

  server.registerTool(
    'batch_save_concepts',
    {
      description: `Create or update up to ${LIMITS.batchEntries} concepts in one namespace atomically: all entries are validated first and either all are saved or none are. Vectors are derived from text (once per entry, in batches of batchSize) unless autoEmbed is false.`,
      inputSchema: z
        .object({
          concepts: z
            .array(z.object(conceptFields).strict())
            .min(1)
            .max(LIMITS.batchEntries)
            .describe('Concepts to save'),
          namespace: namespaceArg,
          autoEmbed: autoEmbedArg,
          batchSize: z
            .number()
            .int()
            .positive()
            .max(LIMITS.batchEntries)
            .optional()
            .describe('Embedding batch size (default 50)'),
        })
        .strict(),
    },
    async ({ concepts: entries, namespace, autoEmbed, batchSize }) =>
      runTool('batch_save_concepts', async () => {
        const ns = resolveNamespace(namespace);
        const result = await conceptService.saveBatch(
          entries.map(entry => ({ ...entry, namespace: ns })),
          { autoEmbed: autoEmbed ?? true, batchSize }
        );
        return jsonResult({
          count: result.count,
          ids: result.saved.map(c => c.id),
        });
      })
  );

  // --- Search ---

  server.registerTool(
    'search_concepts',
    {
      description:
        'Semantic similarity search over one namespace. Provide a text query (auto-embedded) or a raw vector. Namespace and tag filters are applied inside the vector search. Results carry score = (1 + cosine similarity) / 2 in [0, 1], best first, ties by id. crossNamespace searches the namespaces the operator allowed via POLYTICIAN_NAMESPACES and is refused if none are configured.',
      inputSchema: z
        .object({
          query: z
            .string()
            .min(1)
            .max(LIMITS.queryChars)
            .optional()
            .describe('Text query (embedded automatically)'),
          vector: EmbeddingSchema.optional().describe(
            `Raw vector (${VECTOR_DIMENSION} dimensions)`
          ),
          k: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('Number of results (default 10)'),
          tags: TagsSchema.optional().describe('Only concepts carrying every one of these tags'),
          namespace: namespaceArg,
          crossNamespace: z
            .boolean()
            .optional()
            .describe(
              'Search every namespace the operator allowed (POLYTICIAN_NAMESPACES) instead of one'
            ),
        })
        .strict(),
    },
    async ({ query, vector, k, tags, namespace, crossNamespace }) =>
      runTool('search_concepts', async () => {
        const scope = crossNamespace
          ? { namespaces: crossNamespaceScope() }
          : { namespace: resolveNamespace(namespace) };
        let queryEmbedding: number[];
        if (query !== undefined && vector === undefined) {
          queryEmbedding = await embeddingService.embed(query);
        } else if (vector !== undefined && query === undefined) {
          queryEmbedding = vector;
        } else {
          throw new ValidationError('Provide exactly one of query (text) or vector');
        }
        const results = await conceptService.search(queryEmbedding, k ?? 10, tags, scope);
        return jsonResult(results);
      })
  );

  // --- Conversion ---

  server.registerTool(
    'convert_concept',
    {
      description:
        'Derive one representation of a concept from another and store it, marked as derived. Refuses to replace an authored (caller-written) representation unless overwrite is true. Non-LLM paths: markdown→vector, thoughtform→vector, thoughtform→markdown. LLM paths: markdown→thoughtform (or the rule-based NLP pipeline), vector→markdown and vector→thoughtform (from nearest neighbours in the same namespace).',
      inputSchema: z
        .object({
          id: z.string().uuid().describe('Concept UUID'),
          namespace: namespaceArg,
          from: RepresentationTypeSchema.describe('Source representation'),
          to: RepresentationTypeSchema.describe('Target representation'),
          overwrite: z
            .boolean()
            .optional()
            .describe('Replace an authored target representation (default false)'),
        })
        .strict(),
    },
    async ({ id, namespace, from, to, overwrite }) =>
      runTool('convert_concept', async () => {
        const ns = resolveNamespace(namespace);
        await conversionService.convert(id, from, to, { namespace: ns, overwrite });
        const updated = await conceptService.read(id, undefined, { namespace: ns });
        return jsonResult({ converted: { from, to }, concept: updated });
      })
  );

  // --- Embedding ---

  server.registerTool(
    'embed_text',
    {
      description:
        'Generate an embedding vector for arbitrary text without saving it as a concept.',
      inputSchema: z
        .object({
          text: z.string().min(1).max(LIMITS.queryChars).describe('Text to embed'),
        })
        .strict(),
    },
    async ({ text }) =>
      runTool('embed_text', async () => {
        const embedding = await embeddingService.embed(text);
        return jsonResult({ dimension: embedding.length, embedding });
      })
  );

  // --- Health & Diagnostics ---

  server.registerTool(
    'health_check',
    {
      description:
        'Server status, embedding model status, DB stats for a namespace, LLM provider status.',
      inputSchema: z.object({ namespace: namespaceArg }).strict(),
    },
    async ({ namespace }) =>
      runTool('health_check', async () => {
        const stats = await conceptService.getStats(resolveNamespace(namespace));
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
      })
  );

  server.registerTool(
    'get_stats',
    {
      description: 'Concept count, vector count, representation breakdown for a namespace.',
      inputSchema: z.object({ namespace: namespaceArg }).strict(),
    },
    async ({ namespace }) =>
      runTool('get_stats', async () => {
        const stats = await conceptService.getStats(resolveNamespace(namespace));
        return jsonResult(stats);
      })
  );

  // --- Backups ---

  registerBackupTools(server);

  // Register AgentVault tools if integration is configured
  const cfg = getConfig();
  if (cfg.agentVault) {
    const { registerVaultTools } = await import('./integrations/agent-vault/tools/vault-tools.js');
    registerVaultTools(server, cfg.agentVault);
  }

  return server;
}
