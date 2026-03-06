import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { conceptService } from '../../services/concept.service.js';
import { logger } from '../../logger.js';

/**
 * In-memory tracker for the last successful backup timestamp.
 * Falls back to 0 (epoch) when no prior backup has been performed
 * in this server session.
 */
let lastBackupTimestamp = 0;

export interface BackupBundle {
  version: 1;
  createdAt: string;
  lastSynced: number;
  concepts: Array<{
    id: string;
    namespace: string;
    version: number;
    createdAt: number;
    updatedAt: number;
    tags: string[];
    markdown: string | null;
    thoughtform: unknown;
    embedding: number[] | null;
  }>;
}

/**
 * Serializes all concepts (optionally filtered by namespace) into a
 * portable JSON backup bundle.  Returns the bundle along with its
 * byte-size and SHA-256 hash.
 */
async function serializeBackupBundle(
  namespace: string | undefined,
  lastSynced: number,
): Promise<{ bundle: BackupBundle; json: string; sizeBytes: number; sha256: string }> {
  const PAGE_SIZE = 100;
  const allConcepts: BackupBundle['concepts'] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const page = await conceptService.list({ namespace, limit: PAGE_SIZE, offset });
    total = page.total;

    for (const summary of page.concepts) {
      // Fetch the full concept with all representations
      const full = await conceptService.read(summary.id);
      allConcepts.push({
        id: full.id,
        namespace: full.namespace ?? 'default',
        version: full.version ?? 1,
        createdAt: full.createdAt ?? 0,
        updatedAt: full.updatedAt ?? 0,
        tags: full.tags ?? [],
        markdown: full.markdown ?? null,
        thoughtform: full.thoughtform ?? null,
        embedding: full.embedding ?? null,
      });
    }
    offset += PAGE_SIZE;
  }

  const bundle: BackupBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    lastSynced,
    concepts: allConcepts,
  };

  const json = JSON.stringify(bundle);
  const sizeBytes = Buffer.byteLength(json, 'utf-8');
  const sha256 = createHash('sha256').update(json).digest('hex');

  return { bundle, json, sizeBytes, sha256 };
}

/**
 * Registers the `agentvault_backup` tool on the given MCP server.
 */
export function registerBackupTool(server: McpServer): void {
  server.tool(
    'agentvault_backup',
    'Create a full backup bundle of all Polytician concepts. Serializes concepts into a portable JSON bundle, logs bundle size and SHA-256 hash, and returns success metadata.',
    {
      namespace: z
        .string()
        .optional()
        .describe('Namespace to back up. Omit for the default namespace.'),
    },
    async ({ namespace }) => {
      try {
        const lastSynced = lastBackupTimestamp;
        const { sizeBytes, sha256, bundle } = await serializeBackupBundle(namespace, lastSynced);

        logger.info('agentvault_backup: bundle created', {
          conceptCount: bundle.concepts.length,
          sizeBytes,
          sha256,
          namespace: namespace ?? 'default',
        });

        // Update the in-memory last-backup timestamp on success
        lastBackupTimestamp = Date.now();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  conceptCount: bundle.concepts.length,
                  sizeBytes,
                  sha256,
                  namespace: namespace ?? 'default',
                  lastSynced,
                  createdAt: bundle.createdAt,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        logger.error('agentvault_backup: failed', err);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
        };
      }
    },
  );
}
