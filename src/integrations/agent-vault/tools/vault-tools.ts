import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { AgentVaultConfig } from '../config.js';
import { InferenceClient } from '../client/inference-client.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { SecretClient } from '../client/secret-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { embeddingService } from '../../../services/embedding.service.js';
import { getAdapter } from '../../../db/client.js';
import type { ThoughtForm } from '../../../types/thoughtform.js';

/**
 * Shape of a serialized concept inside a vault bundle.
 */
interface BundleConcept {
  id: string;
  namespace?: string;
  markdown?: string | null;
  thoughtform?: Record<string, unknown> | null;
  embedding?: number[] | null;
  tags?: string[];
}

interface VaultBundle {
  version: number;
  exportedAt: string;
  concepts: BundleConcept[];
}

/**
 * Deserialize a raw bundle (JSON object or string) into a typed VaultBundle.
 * Validates required structure and returns the parsed bundle.
 */
function deserializeBundle(raw: unknown): VaultBundle {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (!obj || typeof obj !== 'object') {
    throw new Error('Bundle must be a JSON object');
  }

  const bundle = obj as Record<string, unknown>;

  if (!Array.isArray(bundle.concepts)) {
    throw new Error('Bundle must contain a "concepts" array');
  }

  const concepts = (bundle.concepts as Record<string, unknown>[]).map((c, i) => {
    if (!c.id || typeof c.id !== 'string') {
      throw new Error(`Bundle concept at index ${i} is missing a valid "id"`);
    }
    return {
      id: c.id,
      namespace: typeof c.namespace === 'string' ? c.namespace : undefined,
      markdown: typeof c.markdown === 'string' ? c.markdown : null,
      thoughtform: c.thoughtform && typeof c.thoughtform === 'object'
        ? (c.thoughtform as Record<string, unknown>)
        : null,
      embedding: Array.isArray(c.embedding) ? (c.embedding as number[]) : null,
      tags: Array.isArray(c.tags)
        ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    } satisfies BundleConcept;
  });

  return {
    version: typeof bundle.version === 'number' ? bundle.version : 1,
    exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : new Date().toISOString(),
    concepts,
  };
}

/**
 * Rebuild the vector index for a set of concept IDs by re-upserting their
 * embeddings into the adapter's vector table.
 */
async function rebuildVectorIndex(conceptIds: string[]): Promise<number> {
  const adapter = getAdapter();
  let rebuilt = 0;

  for (const id of conceptIds) {
    const row = await adapter.findConcept(id);
    if (row?.embedding) {
      await adapter.upsertVector(id, row.embedding);
      rebuilt++;
    }
  }

  return rebuilt;
}

export function registerVaultTools(server: McpServer, config: AgentVaultConfig): void {
  const inferClient = new InferenceClient(config);
  const memClient = new MemoryRepoClient(config);
  const arweaveClient = new ArweaveUploadClient(config);
  const secretClient = new SecretClient(config);

  // --- vault_infer ---

  server.tool(
    'vault_infer',
    'Run a prompt through AgentVault\'s inference fallback chain (Bittensor -> Venice AI -> local) and optionally save the result as a concept.',
    {
      prompt: z.string().min(1).describe('Prompt text to send to the inference chain'),
      systemPrompt: z.string().optional().describe('Optional system prompt'),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(2).optional(),
      saveAsConceptNamespace: z.string().optional().describe(
        'If set, save the inference result as a markdown concept in this namespace'
      ),
      tags: z.array(z.string()).optional(),
    },
    async ({ prompt, systemPrompt, maxTokens, temperature, saveAsConceptNamespace, tags }) => {
      try {
        const res = await inferClient.infer({
          prompt, systemPrompt, maxTokens, temperature,
          preferredBackend: config.inference.preferredBackend,
        });

        let savedConceptId: string | undefined;
        if (saveAsConceptNamespace) {
          const embedding = await embeddingService.embed(res.text).catch(() => undefined);
          const concept = await conceptService.save({
            namespace: saveAsConceptNamespace,
            markdown: res.text,
            embedding,
            tags: tags ?? [],
          });
          savedConceptId = concept.id;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ text: res.text, backend: res.backend, latencyMs: res.latencyMs, savedConceptId }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_memory_push ---

  server.tool(
    'vault_memory_push',
    'Push a Polytician concept to AgentVault\'s memory_repo canister immediately.',
    {
      conceptId: z.string().uuid().describe('Concept UUID to push'),
    },
    async ({ conceptId }) => {
      try {
        const concept = await conceptService.read(conceptId);
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
          content: [{ type: 'text' as const, text: JSON.stringify({ pushed: true, sha: commit.sha }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_memory_pull ---

  server.tool(
    'vault_memory_pull',
    'Pull all entries from AgentVault\'s memory_repo branch into Polytician concepts.',
    {},
    async () => {
      try {
        const branch = await memClient.getBranchState();
        let imported = 0;
        const mdEntries = branch.entries.filter(
          e => e.key.startsWith('concepts/') && e.key.endsWith('/markdown')
        );
        for (const entry of mdEntries) {
          const cid = entry.key.split('/')[1];
          if (!cid) continue;
          await conceptService.save({ id: cid, markdown: entry.data, tags: entry.tags });
          imported++;
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ pulled: true, branch: branch.branch, headSha: branch.headSha, imported }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_archive_concept ---

  server.tool(
    'vault_archive_concept',
    'Archive a concept to Arweave permanently via AgentVault. Returns the Arweave transaction ID and URL.',
    {
      conceptId: z.string().uuid().describe('Concept UUID to archive'),
    },
    async ({ conceptId }) => {
      try {
        const concept = await conceptService.read(conceptId);
        const content = concept.markdown ?? JSON.stringify(concept.thoughtform);
        if (!content) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Concept has no archivable content' }) }],
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
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ archived: true, txId: receipt.txId, url: receipt.url, size: receipt.size }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_get_secret ---

  server.tool(
    'vault_get_secret',
    'Retrieve a named secret from AgentVault\'s secret provider. Returns metadata only, never the raw value.',
    {
      name: z.string().min(1).describe('Secret name in AgentVault'),
    },
    async ({ name }) => {
      try {
        const secret = await secretClient.getSecret(name);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              name: secret.name,
              provider: secret.provider,
              rotatedAt: secret.rotatedAt,
              valueLength: secret.value.length,
            }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_memory_repo_log ---

  server.tool(
    'vault_memory_repo_log',
    'Read the current state of the AgentVault memory_repo branch for this Polytician namespace.',
    {},
    async () => {
      try {
        const branch = await memClient.getBranchState();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              branch: branch.branch,
              headSha: branch.headSha,
              entryCount: branch.entries.length,
              conceptKeys: branch.entries
                .filter(e => e.key.startsWith('concepts/'))
                .map(e => e.key),
            }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );

  // --- vault_restore ---

  server.tool(
    'vault_restore',
    'Restore concepts and vector index from a vault bundle. Accepts either inline bundle JSON or a file path to a bundle. Deserializes all concepts, saves them, and rebuilds the FAISS vector index.',
    {
      bundle: z.any().optional().describe(
        'Inline bundle JSON object containing { version, exportedAt, concepts: [...] }'
      ),
      path: z.string().optional().describe(
        'File path to a JSON bundle file. Mutually exclusive with "bundle".'
      ),
    },
    async ({ bundle, path }) => {
      try {
        if (!bundle && !path) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Provide either "bundle" (inline JSON) or "path" (file path)' }),
            }],
          };
        }

        if (bundle && path) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: '"bundle" and "path" are mutually exclusive — provide one, not both' }),
            }],
          };
        }

        // Load raw bundle data
        let raw: unknown;
        if (path) {
          const fileContents = await readFile(path, 'utf-8');
          raw = JSON.parse(fileContents);
        } else {
          raw = bundle;
        }

        // Deserialize bundle
        const parsed = deserializeBundle(raw);

        // Restore concepts
        const restoredIds: string[] = [];
        const errors: Array<{ id: string; error: string }> = [];

        for (const entry of parsed.concepts) {
          try {
            await conceptService.save({
              id: entry.id,
              namespace: entry.namespace,
              markdown: entry.markdown ?? undefined,
              thoughtform: entry.thoughtform ? (entry.thoughtform as ThoughtForm) : undefined,
              embedding: entry.embedding ?? undefined,
              tags: entry.tags,
            });
            restoredIds.push(entry.id);
          } catch (err) {
            errors.push({ id: entry.id, error: String(err) });
          }
        }

        // Rebuild vector index for restored concepts
        const vectorsRebuilt = await rebuildVectorIndex(restoredIds);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              restored: true,
              bundleVersion: parsed.version,
              exportedAt: parsed.exportedAt,
              conceptsRestored: restoredIds.length,
              vectorsRebuilt,
              errors: errors.length > 0 ? errors : undefined,
            }),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        };
      }
    }
  );
}
