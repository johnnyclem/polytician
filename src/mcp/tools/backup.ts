import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConfig } from '../../config.js';
import { isNamespaceAllowed, resolveNamespace } from '../../services/namespace-policy.js';
import { exportBackup, importBackup } from '../../services/backup.service.js';
import { backupsDir, listBackupFiles } from '../../backup/files.js';
import { NamespaceSchema } from '../../types/concept.js';
import { jsonResult, runTool } from '../tool-result.js';

/**
 * Registers export_backup, import_backup and list_backups. Backups are files
 * in {dataDir}/backups in the versioned JSONL format of src/backup/format.ts.
 */
export function registerBackupTools(server: McpServer): void {
  server.registerTool(
    'export_backup',
    {
      description:
        "Write a backup file of the concept store into the server's backups directory (mode 0600) and return its file name, per-namespace counts and SHA-256. Covers every namespace the server serves unless one is named, and includes vectors (with the embedding model id), tags, thoughtforms and provenance. Encrypted with AES-256-GCM when encrypt is true or the operator set POLYTICIAN_ENCRYPT; fails if encryption is requested and no backup key is configured.",
      inputSchema: z
        .object({
          namespace: NamespaceSchema.optional().describe(
            'Only back up this namespace (default: every namespace the server serves)'
          ),
          encrypt: z
            .boolean()
            .optional()
            .describe(
              'Encrypt with the configured backup key (default: POLYTICIAN_ENCRYPT; false is refused when that is set)'
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ namespace, encrypt }) =>
      runTool('export_backup', async () => {
        const allowed = getConfig().namespaces;
        const namespaces =
          namespace !== undefined
            ? [resolveNamespace(namespace)]
            : allowed === null || allowed === '*'
              ? '*'
              : allowed;
        return jsonResult(await exportBackup({ namespaces, encrypt }));
      })
  );

  server.registerTool(
    'import_backup',
    {
      description:
        'Restore concepts from a backup file in the server\'s backups directory (name it as export_backup or list_backups report it). The file is verified (checksum, and the AES-GCM tag if encrypted) and every concept validated before anything is written; then all concepts are written in one transaction with their ids, namespaces, timestamps, tags, vectors and provenance. An existing concept is replaced only when the backup copy is newer (onConflict "newer", the default), always ("overwrite") or never ("skip"), and never across namespaces.',
      inputSchema: z
        .object({
          file: z
            .string()
            .min(1)
            .max(256)
            .describe('Backup file name inside the backups directory (no path)'),
          namespace: NamespaceSchema.optional().describe(
            'Only restore concepts from this namespace (default: all in the file)'
          ),
          onConflict: z
            .enum(['newer', 'overwrite', 'skip'])
            .optional()
            .describe('When a concept already exists (default "newer": last write wins)'),
          reembed: z
            .boolean()
            .optional()
            .describe(
              "Drop the backup's vectors and derive new ones from text. Needed when the backup was embedded with a different model."
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ file, namespace, onConflict, reembed }) =>
      runTool('import_backup', async () => {
        const result = await importBackup(file, {
          namespace: namespace !== undefined ? resolveNamespace(namespace) : undefined,
          onConflict,
          reembed,
          allowNamespace: isNamespaceAllowed,
        });
        return jsonResult(result);
      })
  );

  server.registerTool(
    'list_backups',
    {
      description:
        "List the backup files in the server's backups directory, newest first, from their headers: file name, size, creation time, embedding model, and whether (and with which key id) each is encrypted.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool('list_backups', async () =>
        jsonResult({ directory: backupsDir(), backups: listBackupFiles() })
      )
  );
}
