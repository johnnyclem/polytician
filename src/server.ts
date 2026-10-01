import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { conceptService } from './services/concept.service.js';
import { conversionService } from './services/conversion.service.js';
import { embeddingService } from './services/embedding.service.js';
import { crossNamespaceScope, resolveNamespace } from './services/namespace-policy.js';
import {
  AssertionStatusSchema,
  EmbeddingSchema,
  LedgerRefSchema,
  MarkdownSchema,
  NamespaceSchema,
  RepresentationTypeSchema,
  SourceSchema,
  TagsSchema,
  ThoughtFormInputSchema,
  VECTOR_DIMENSION,
} from './types/concept.js';
import { LIMITS } from './types/limits.js';
import { ValidationError } from './errors/index.js';
import { getConfig } from './config.js';
import { jsonResult, runTool, useCodedToolErrors } from './mcp/tool-result.js';
import {
  BatchSaveOut,
  ConceptOut,
  ConvertConceptOut,
  DeleteConceptOut,
  EmbedTextOut,
  GetStatsOut,
  HealthCheckOut,
  ListConceptsOut,
  ReembedOut,
  SearchConceptsOut,
} from './mcp/output-schemas.js';
import { registerBackupTools } from './mcp/tools/backup.js';
import { POLYTICIAN_VERSION } from './version.js';

const namespaceArg = NamespaceSchema.optional().describe(
  'Namespace (default: "default"). Must be in POLYTICIAN_NAMESPACES when the operator set one.'
);

const assertionStatusFilter = z
  .array(AssertionStatusSchema)
  .min(1)
  .max(4)
  .optional()
  .describe(
    'Only concepts whose assertionStatus is one of these (concepts without one are left out)'
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
  source: SourceSchema.optional().describe(
    'Provenance recorded on the representations this call writes (default origin "user")'
  ),
  assertionStatus: AssertionStatusSchema.nullable()
    .optional()
    .describe(
      'Truth status of a concept that records a claim (e.g. a stenographer TB/UV entry); null clears it, omitted keeps it. Stored as given, not checked.'
    ),
  ledgerRef: LedgerRefSchema.nullable()
    .optional()
    .describe('The ledger entry this concept mirrors (id, path#id or hash); null clears it'),
};

const autoEmbedArg = z
  .boolean()
  .optional()
  .describe(
    'Derive the vector from the markdown (else the thoughtform text) when no embedding is given, so the concept is searchable (default true). Never replaces a caller-supplied vector.'
  );

/** Hints for a tool that only reads local state. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'polytician',
    version: POLYTICIAN_VERSION,
  });
  useCodedToolErrors(server);

  const cfg = getConfig();
  const av = cfg.agentVault;
  // Writes reach AgentVault when the operator enabled sync push or archival.
  const writesLeaveBox = Boolean(
    av && ((av.sync.enabled && av.sync.direction !== 'pull') || av.archival.enabled)
  );
  const write = (destructive: boolean, idempotent: boolean): ToolAnnotations => ({
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: writesLeaveBox,
  });

  // --- CRUD Tools ---

  server.registerTool(
    'save_concept',
    {
      description:
        'Create or update a concept with one or more representations (vector, markdown, thoughtform). A new concept needs at least one. Tags are merged on update. The vector is derived from the text unless autoEmbed is false. An update must name the namespace the concept lives in; expectedVersion guards against concurrent writers. Each representation written records its provenance (source), and a concept can carry an assertionStatus and ledgerRef.',
      inputSchema: z
        .object({ ...conceptFields, namespace: namespaceArg, autoEmbed: autoEmbedArg })
        .strict(),
      outputSchema: ConceptOut,
      annotations: write(true, false),
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
        'Read all available representations for a concept in a namespace, with their provenance, assertionStatus and ledgerRef. Optionally filter to specific representations.',
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
      outputSchema: ConceptOut,
      annotations: READ_ONLY,
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
      outputSchema: DeleteConceptOut,
      annotations: write(true, true),
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
        'List concepts with pagination and optional tag (exact match) and assertionStatus filtering. Results are scoped to the namespace.',
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
          assertionStatus: assertionStatusFilter,
        })
        .strict(),
      outputSchema: ListConceptsOut,
      annotations: READ_ONLY,
    },
    async ({ namespace, limit, offset, tags, assertionStatus }) =>
      runTool('list_concepts', async () => {
        const result = await conceptService.list({
          namespace: resolveNamespace(namespace),
          limit,
          offset,
          tags,
          assertionStatus,
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
      outputSchema: BatchSaveOut,
      annotations: write(true, false),
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
        'Semantic similarity search over one namespace. Provide a text query (auto-embedded) or a raw vector. Namespace, tag and assertionStatus filters are applied inside the vector search. Returns { results }, each with score = (1 + cosine similarity) / 2 in [0, 1], best first, ties by id. crossNamespace (without namespace) searches the namespaces the operator allowed via POLYTICIAN_NAMESPACES and is refused if none are configured.',
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
          assertionStatus: assertionStatusFilter,
          namespace: namespaceArg,
          crossNamespace: z
            .boolean()
            .optional()
            .describe(
              'Search every namespace the operator allowed (POLYTICIAN_NAMESPACES) instead of one; cannot be combined with namespace'
            ),
        })
        .strict(),
      outputSchema: SearchConceptsOut,
      annotations: READ_ONLY,
    },
    async ({ query, vector, k, tags, assertionStatus, namespace, crossNamespace }) =>
      runTool('search_concepts', async () => {
        if (crossNamespace && namespace !== undefined) {
          throw new ValidationError(
            'Pass either namespace or crossNamespace: true; a cross-namespace search spans the allowlist, not one namespace'
          );
        }
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
        const results = await conceptService.search(queryEmbedding, k ?? 10, tags, {
          ...scope,
          assertionStatus,
        });
        return jsonResult({ results });
      })
  );

  // --- Conversion ---

  server.registerTool(
    'convert_concept',
    {
      description:
        'Derive one representation of a concept from another and store it, with provenance origin "derived" (or "llm" when an LLM wrote it). Refuses to replace an authored (caller-written or imported) representation unless overwrite is true. Non-LLM paths: markdown→vector, thoughtform→vector, thoughtform→markdown. LLM paths: markdown→thoughtform (or the rule-based NLP pipeline), vector→markdown and vector→thoughtform (from nearest neighbours in the same namespace).',
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
      outputSchema: ConvertConceptOut,
      annotations: {
        ...write(true, false),
        // LLM conversions send the concept's text to AgentVault inference.
        openWorldHint: writesLeaveBox || cfg.llm.provider === 'agentvault',
      },
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
      outputSchema: EmbedTextOut,
      annotations: READ_ONLY,
    },
    async ({ text }) =>
      runTool('embed_text', async () => {
        const embedding = await embeddingService.embed(text);
        return jsonResult({ dimension: embedding.length, embedding });
      })
  );

  server.registerTool(
    'reembed_concepts',
    {
      description:
        "Re-derive, from each concept's text, the vectors in a namespace that a different embedding model made (for example after POLYTICIAN_EMBEDDING_MODEL changed). search_concepts refuses a namespace holding such vectors (EMBEDDING_MODEL_MISMATCH) until they are re-embedded. Authored vectors are replaced only with overwrite: true; concepts without text are reported and left unchanged. Returns the ids re-embedded, the ones skipped and how many stale vectors remain.",
      inputSchema: z
        .object({
          namespace: namespaceArg,
          overwrite: z
            .boolean()
            .optional()
            .describe('Also replace authored (caller-supplied) vectors (default false)'),
          limit: z
            .number()
            .int()
            .positive()
            .max(LIMITS.batchEntries)
            .optional()
            .describe(`Most concepts to re-embed in this call (default ${LIMITS.batchEntries})`),
        })
        .strict(),
      outputSchema: ReembedOut,
      annotations: write(true, true),
    },
    async ({ namespace, overwrite, limit }) =>
      runTool('reembed_concepts', async () => {
        const result = await conceptService.reembed({
          namespace: resolveNamespace(namespace),
          overwrite,
          limit,
        });
        return jsonResult(result);
      })
  );

  // --- Health & Diagnostics ---

  server.registerTool(
    'health_check',
    {
      description:
        'Server status, embedding model status, DB stats for a namespace, LLM provider status.',
      inputSchema: z.object({ namespace: namespaceArg }).strict(),
      outputSchema: HealthCheckOut,
      annotations: READ_ONLY,
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
      outputSchema: GetStatsOut,
      annotations: READ_ONLY,
    },
    async ({ namespace }) =>
      runTool('get_stats', async () => {
        const stats = await conceptService.getStats(resolveNamespace(namespace));
        return jsonResult(stats);
      })
  );

  // --- Backups ---

  registerBackupTools(server, { writesLeaveBox });

  // Register AgentVault tools if integration is configured
  if (av) {
    const { registerVaultTools } = await import('./integrations/agent-vault/tools/vault-tools.js');
    registerVaultTools(server, av);
  }

  return server;
}
