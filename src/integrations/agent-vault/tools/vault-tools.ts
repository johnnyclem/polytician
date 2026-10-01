import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentVaultConfig } from '../config.js';
import { InferenceClient } from '../client/inference-client.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { SecretClient } from '../client/secret-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { embeddingService } from '../../../services/embedding.service.js';
import { resolveNamespace } from '../../../services/namespace-policy.js';
import { NamespaceSchema, TagsSchema } from '../../../types/concept.js';
import { LIMITS } from '../../../types/limits.js';
import { errorPayload } from '../../../mcp/tool-result.js';

const namespaceArg = NamespaceSchema.optional().describe(
  'Namespace the concept lives in (default: "default")'
);

/** Error result carrying the error's stable code, when it has one. */
function toolError(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err)) }],
  };
}

export function registerVaultTools(server: McpServer, config: AgentVaultConfig): void {
  const inferClient = new InferenceClient(config);
  const memClient = new MemoryRepoClient(config);
  const arweaveClient = new ArweaveUploadClient(config);
  const secretClient = new SecretClient(config);

  // --- vault_infer ---

  server.registerTool(
    'vault_infer',
    {
      description:
        "Run a prompt through AgentVault's inference fallback chain (Bittensor -> Venice AI -> local) and optionally save the result as a concept.",
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
    },
    async ({ prompt, systemPrompt, maxTokens, temperature, saveAsConceptNamespace, tags }) => {
      try {
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
          });
          savedConceptId = concept.id;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                text: res.text,
                backend: res.backend,
                latencyMs: res.latencyMs,
                savedConceptId,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
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
    },
    async ({ conceptId, namespace }) => {
      try {
        const concept = await conceptService.read(conceptId, undefined, {
          namespace: resolveNamespace(namespace),
        });
        const entries = [];
        if (concept.markdown) {
          entries.push({
            key: `concepts/${conceptId}/markdown`,
            contentType: 'markdown' as const,
            data: concept.markdown,
            tags: concept.tags ?? [],
            metadata: { conceptId, updatedAt: concept.updatedAt },
          });
        }
        if (concept.thoughtform) {
          entries.push({
            key: `concepts/${conceptId}/thoughtform`,
            contentType: 'json' as const,
            data: JSON.stringify(concept.thoughtform),
            tags: concept.tags ?? [],
            metadata: { conceptId, updatedAt: concept.updatedAt },
          });
        }
        const commit = await memClient.commit(`polytician: manual push ${conceptId}`, entries);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ pushed: true, sha: commit.sha }) },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- vault_memory_pull ---

  server.registerTool(
    'vault_memory_pull',
    {
      description:
        "Pull all entries from AgentVault's memory_repo branch into Polytician concepts in one namespace. Entries whose concept lives in another namespace are skipped.",
      inputSchema: z.object({ namespace: namespaceArg }).strict(),
    },
    async ({ namespace }) => {
      try {
        const ns = resolveNamespace(namespace);
        const branch = await memClient.getBranchState();
        let imported = 0;
        const skipped: Array<{ id: string; error: string }> = [];
        const mdEntries = branch.entries.filter(
          e => e.key.startsWith('concepts/') && e.key.endsWith('/markdown')
        );
        for (const entry of mdEntries) {
          const cid = entry.key.split('/')[1];
          if (!cid) continue;
          try {
            await conceptService.save({
              id: cid,
              namespace: ns,
              markdown: entry.data,
              tags: entry.tags,
            });
            imported++;
          } catch (err) {
            skipped.push({ id: cid, error: String(errorPayload(err).error) });
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                pulled: true,
                branch: branch.branch,
                headSha: branch.headSha,
                imported,
                skipped: skipped.length > 0 ? skipped : undefined,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- vault_archive_concept ---

  server.registerTool(
    'vault_archive_concept',
    {
      description:
        'Archive a concept to Arweave permanently via AgentVault. Returns the Arweave transaction ID and URL.',
      inputSchema: z
        .object({
          conceptId: z.string().uuid().describe('Concept UUID to archive'),
          namespace: namespaceArg,
        })
        .strict(),
    },
    async ({ conceptId, namespace }) => {
      try {
        const concept = await conceptService.read(conceptId, undefined, {
          namespace: resolveNamespace(namespace),
        });
        const content = concept.markdown ?? JSON.stringify(concept.thoughtform);
        if (!content) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Concept has no archivable content' }),
              },
            ],
          };
        }
        const receipt = await arweaveClient.upload({
          content,
          contentType: concept.markdown ? 'markdown' : 'json',
          tags: concept.tags ?? [],
          metadata: {
            conceptId,
            namespace: concept.namespace ?? 'default',
            version: concept.version,
            archivedAt: Date.now(),
          },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                archived: true,
                txId: receipt.txId,
                url: receipt.url,
                size: receipt.size,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

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
    },
    async ({ name }) => {
      try {
        const secret = await secretClient.getSecret(name);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                name: secret.name,
                provider: secret.provider,
                rotatedAt: secret.rotatedAt,
                valueLength: secret.value.length,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // --- vault_memory_repo_log ---

  server.registerTool(
    'vault_memory_repo_log',
    {
      description:
        'Read the current state of the AgentVault memory_repo branch for this Polytician namespace.',
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        const branch = await memClient.getBranchState();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                branch: branch.branch,
                headSha: branch.headSha,
                entryCount: branch.entries.length,
                conceptKeys: branch.entries
                  .filter(e => e.key.startsWith('concepts/'))
                  .map(e => e.key),
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
