import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentVaultConfig } from '../config.js';
import { InferenceClient } from '../client/inference-client.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { SecretClient } from '../client/secret-client.js';
import { applyPulledEntries } from '../connectors/memory-sync.connector.js';
import { sharedArchivalConnector } from '../connectors/archival.connector.js';
import { conceptService } from '../../../services/concept.service.js';
import { embeddingService } from '../../../services/embedding.service.js';
import { isNamespaceAllowed, resolveNamespace } from '../../../services/namespace-policy.js';
import { PolyticianError, UpstreamError, ValidationError } from '../../../errors/index.js';
import { NamespaceSchema, TagsSchema } from '../../../types/concept.js';
import { LIMITS } from '../../../types/limits.js';
import { jsonResult, runTool, type ToolResult } from '../../../mcp/tool-result.js';
import {
  VaultArchiveOut,
  VaultGetSecretOut,
  VaultInferOut,
  VaultMemoryPullOut,
  VaultMemoryPushOut,
  VaultMemoryRepoLogOut,
} from '../../../mcp/output-schemas.js';

const namespaceArg = NamespaceSchema.optional().describe(
  'Namespace the concept lives in (default: "default")'
);

/**
 * Run a vault tool: Polytician errors keep their code, and any other failure
 * (an AgentVault HTTP error, a timeout) becomes UPSTREAM_ERROR.
 */
function runVaultTool(operation: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return runTool(operation, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PolyticianError) throw err;
      throw new UpstreamError(err instanceof Error ? err.message : String(err));
    }
  });
}

export function registerVaultTools(server: McpServer, config: AgentVaultConfig): void {
  const inferClient = new InferenceClient(config);
  const memClient = new MemoryRepoClient(config);
  const secretClient = new SecretClient(config);

  // --- vault_infer ---

  server.registerTool(
    'vault_infer',
    {
      description:
        'Run a prompt through AgentVault\'s inference fallback chain (Bittensor -> Venice AI -> local) and optionally save the result as a concept (provenance origin "llm").',
      inputSchema: z
        .object({
          prompt: z
            .string()
            .min(1)
            .max(LIMITS.markdownChars)
            .describe('Prompt text to send to the inference chain'),
          systemPrompt: z
            .string()
            .max(LIMITS.markdownChars)
            .optional()
            .describe('Optional system prompt'),
          maxTokens: z.number().int().positive().optional(),
          temperature: z.number().min(0).max(2).optional(),
          saveAsConceptNamespace: NamespaceSchema.optional().describe(
            'If set, save the inference result as a markdown concept in this namespace'
          ),
          tags: TagsSchema.optional(),
        })
        .strict(),
      outputSchema: VaultInferOut,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, systemPrompt, maxTokens, temperature, saveAsConceptNamespace, tags }) =>
      runVaultTool('vault_infer', async () => {
        const saveNamespace =
          saveAsConceptNamespace !== undefined
            ? resolveNamespace(saveAsConceptNamespace)
            : undefined;
        const res = await inferClient.infer({
          prompt,
          systemPrompt,
          maxTokens,
          temperature,
          preferredBackend: config.inference.preferredBackend,
        });

        let savedConceptId: string | undefined;
        if (saveNamespace) {
          const embedding = await embeddingService.embed(res.text).catch(() => undefined);
          const concept = await conceptService.save({
            namespace: saveNamespace,
            markdown: res.text,
            embedding,
            tags: tags ?? [],
            provenance: {
              markdown: { origin: 'llm', model: `agentvault:${res.backend}` },
              ...(embedding && {
                vector: {
                  origin: 'derived',
                  derivedFrom: 'markdown',
                  model: embeddingService.getModel(),
                },
              }),
            },
          });
          savedConceptId = concept.id;
        }

        return jsonResult({
          text: res.text,
          backend: res.backend,
          latencyMs: res.latencyMs,
          savedConceptId,
        });
      })
  );

  // --- vault_memory_push ---

  server.registerTool(
    'vault_memory_push',
    {
      description: "Push a Polytician concept to AgentVault's memory_repo canister immediately.",
      inputSchema: z
        .object({
          conceptId: z.string().uuid().describe('Concept UUID to push'),
          namespace: namespaceArg,
        })
        .strict(),
      outputSchema: VaultMemoryPushOut,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ conceptId, namespace }) =>
      runVaultTool('vault_memory_push', async () => {
        const concept = await conceptService.read(conceptId, undefined, {
          namespace: resolveNamespace(namespace),
        });
        // Namespace and updatedAt let a later pull place the entry and order it (last write wins).
        const metadata = {
          conceptId,
          namespace: concept.namespace,
          version: concept.version,
          updatedAt: concept.updatedAt,
        };
        const entries = [];
        if (concept.markdown) {
          entries.push({
            key: `concepts/${conceptId}/markdown`,
            contentType: 'markdown' as const,
            data: concept.markdown,
            tags: concept.tags ?? [],
            metadata,
          });
        }
        if (concept.thoughtform) {
          entries.push({
            key: `concepts/${conceptId}/thoughtform`,
            contentType: 'json' as const,
            data: JSON.stringify(concept.thoughtform),
            tags: concept.tags ?? [],
            metadata,
          });
        }
        const commit = await memClient.commit(`polytician: manual push ${conceptId}`, entries);
        return jsonResult({ pushed: true, sha: commit.sha });
      })
  );

  // --- vault_memory_pull ---

  server.registerTool(
    'vault_memory_pull',
    {
      description:
        'Pull markdown entries from AgentVault\'s memory_repo branch into concepts in one namespace (provenance origin "import"), last write wins: an entry replaces a local concept only when its updatedAt is newer, entries recorded for another namespace (or whose id lives in another namespace) are skipped, and ids must be UUIDs. Skipped entries are reported with a reason.',
      inputSchema: z.object({ namespace: namespaceArg }).strict(),
      outputSchema: VaultMemoryPullOut,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ namespace }) =>
      runVaultTool('vault_memory_pull', async () => {
        const ns = resolveNamespace(namespace);
        const branch = await memClient.getBranchState();
        const report = await applyPulledEntries(branch.entries, {
          namespace: ns,
          allowNamespace: isNamespaceAllowed,
        });
        return jsonResult({
          pulled: true,
          branch: branch.branch,
          headSha: branch.headSha,
          imported: report.imported.length,
          skipped: report.skipped.length > 0 ? report.skipped : undefined,
        });
      })
  );

  // --- vault_archive_concept ---

  // Only with archival enabled: the operator chose the tag filter and has a
  // backup key and an Arweave wallet configured.
  if (config.archival.enabled) {
    const archival = sharedArchivalConnector(config);
    server.registerTool(
      'vault_archive_concept',
      {
        description: `Archive the current version of a concept to Arweave via AgentVault: permanent, public and paid, so it cannot be undone. The content is encrypted with the backup key before upload. Only concepts carrying every archival tag (${config.archival.tagFilter.join(', ')}) can be archived, and each version is archived once. Returns the Arweave transaction ID and URL.`,
        inputSchema: z
          .object({
            conceptId: z.string().uuid().describe('Concept UUID to archive'),
            namespace: namespaceArg,
          })
          .strict(),
        outputSchema: VaultArchiveOut,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ conceptId, namespace }) =>
        runVaultTool('vault_archive_concept', async () => {
          const outcome = await archival.archive(conceptId, resolveNamespace(namespace));
          if (!outcome.archived) {
            const why = {
              'not-tagged': `the concept does not carry every archival tag (${config.archival.tagFilter.join(', ')})`,
              'no-content': 'the concept has no markdown or thoughtform to archive',
              'already-archived': 'this version of the concept is already archived',
            }[outcome.reason];
            throw new ValidationError(`Not archived: ${why}`);
          }
          const { receipt } = outcome;
          return jsonResult({
            archived: true,
            encrypted: true,
            txId: receipt.txId,
            url: receipt.url,
            size: receipt.size,
          });
        })
    );
  }

  // --- vault_get_secret ---

  server.registerTool(
    'vault_get_secret',
    {
      description:
        "Retrieve a named secret from AgentVault's secret provider. Returns metadata only, never the raw value.",
      inputSchema: z
        .object({
          name: z.string().min(1).max(256).describe('Secret name in AgentVault'),
        })
        .strict(),
      outputSchema: VaultGetSecretOut,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name }) =>
      runVaultTool('vault_get_secret', async () => {
        const secret = await secretClient.getSecret(name);
        return jsonResult({
          name: secret.name,
          provider: secret.provider,
          rotatedAt: secret.rotatedAt,
          valueLength: secret.value.length,
        });
      })
  );

  // --- vault_memory_repo_log ---

  server.registerTool(
    'vault_memory_repo_log',
    {
      description:
        'Read the current state of the AgentVault memory_repo branch for this Polytician namespace.',
      inputSchema: z.object({}).strict(),
      outputSchema: VaultMemoryRepoLogOut,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      runVaultTool('vault_memory_repo_log', async () => {
        const branch = await memClient.getBranchState();
        return jsonResult({
          branch: branch.branch,
          headSha: branch.headSha,
          entryCount: branch.entries.length,
          conceptKeys: branch.entries.filter(e => e.key.startsWith('concepts/')).map(e => e.key),
        });
      })
  );
}
