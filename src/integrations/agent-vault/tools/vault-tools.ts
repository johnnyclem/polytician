import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentVaultConfig } from '../config.js';
import { InferenceClient } from '../client/inference-client.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { SecretClient } from '../client/secret-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { embeddingService } from '../../../services/embedding.service.js';

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
}
