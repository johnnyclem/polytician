#!/usr/bin/env tsx

/**
 * agentvault-sync CLI
 *
 * Top-level CLI for managing Polytician backups and Polytician <-> AgentVault
 * synchronisation.
 *
 * Subcommands:
 *   backup  — Write a backup file (all namespaces unless --namespace is given)
 *   restore — Restore concepts from a backup file
 *   sync    — Bidirectional sync with AgentVault memory_repo
 *
 * Usage:
 *   npx tsx bin/agentvault-sync.ts backup  [--out <path>] [--namespace <ns>] [--encrypt]
 *   npx tsx bin/agentvault-sync.ts restore --file <path> [--namespace <ns>] [--on-conflict newer|overwrite|skip] [--reembed]
 *   npx tsx bin/agentvault-sync.ts sync    [--direction push|pull|bidirectional] [--namespace <ns>]
 *
 * Backups use the versioned JSONL format in src/backup/format.ts, the same
 * files the export_backup / import_backup tools read and write.
 */

import { existsSync, readFileSync } from 'node:fs';
import { initializeDatabase, closeDatabase, getAdapter } from '../src/db/client.js';
import { getConfig } from '../src/config.js';
import {
  exportBackup,
  exportBackupTo,
  importBackupBytes,
  type ExportResult,
} from '../src/services/backup.service.js';
import type { RestoreConflictPolicy } from '../src/services/concept.service.js';
// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = node/tsx, argv[1] = script path, argv[2..] = user args
  const args = argv.slice(2);
  const subcommand = args[0] ?? '';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  return { subcommand, flags };
}

class UsageError extends Error {}

/** Every concept id, in one namespace or (namespace undefined) in all of them. */
async function listIds(namespace: string | undefined): Promise<string[]> {
  const { rows } = await getAdapter().listConcepts({
    limit: 2_147_483_647,
    offset: 0,
    namespace,
  });
  return rows.map(r => r.id);
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

async function backup(flags: Record<string, string>): Promise<void> {
  const namespace = flags['namespace'];
  const options = { namespaces: namespace ? [namespace] : ('*' as const) };

  console.log(
    `[agentvault-sync] backup: exporting ${namespace ? `namespace ${namespace}` : 'all namespaces'} ...`
  );
  // --encrypt is read by getConfig() (POLYTICIAN_ENCRYPT); without a key the export fails.
  const result: ExportResult = flags['out']
    ? await exportBackupTo(flags['out'], options)
    : await exportBackup(options);

  const counts = Object.entries(result.namespaces)
    .map(([ns, n]) => `${ns}=${n}`)
    .join(', ');
  console.log(
    `[agentvault-sync] backup: wrote ${result.conceptCount} concepts${counts ? ` (${counts})` : ''} to ${result.path}`
  );
  console.log(
    `[agentvault-sync] backup: ${result.encrypted ? `encrypted with key ${result.keyId}` : 'not encrypted'}, sha256 ${result.sha256}`
  );
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

async function restore(flags: Record<string, string>): Promise<void> {
  const filePath = flags['file'];
  if (!filePath) throw new UsageError('restore: --file <path> is required');
  if (!existsSync(filePath)) throw new UsageError(`restore: file not found: ${filePath}`);

  const onConflict = flags['on-conflict'];
  if (onConflict !== undefined && !['newer', 'overwrite', 'skip'].includes(onConflict)) {
    throw new UsageError('restore: --on-conflict must be newer, overwrite or skip');
  }

  console.log(`[agentvault-sync] restore: reading ${filePath} ...`);
  const result = await importBackupBytes(readFileSync(filePath), {
    namespace: flags['namespace'],
    onConflict: onConflict as RestoreConflictPolicy | undefined,
    reembed: flags['reembed'] === 'true',
  });

  console.log(
    `[agentvault-sync] restore: imported ${result.inserted + result.updated} concepts (${result.inserted} new, ${result.updated} replaced), skipped ${result.skipped.length}`
  );
  for (const s of result.skipped) {
    console.log(`[agentvault-sync] restore: skipped ${s.namespace}/${s.id}: ${s.reason}`);
  }
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function sync(flags: Record<string, string>): Promise<void> {
  const config = getConfig();

  if (!config.agentVault) {
    throw new UsageError(
      'sync: AgentVault integration is not configured. Configure agentVault in the config file, or set POLYTICIAN_AV_API_URL / POLYTICIAN_AV_API_TOKEN.'
    );
  }

  const direction = (flags['direction'] ?? config.agentVault.sync.direction ?? 'bidirectional') as
    | 'push'
    | 'pull'
    | 'bidirectional';

  console.log(`[agentvault-sync] sync: direction=${direction}`);

  const { MemorySyncConnector } =
    await import('../src/integrations/agent-vault/connectors/memory-sync.connector.js');

  const connector = new MemorySyncConnector(config.agentVault);

  try {
    if (direction === 'pull' || direction === 'bidirectional') {
      console.log('[agentvault-sync] sync: pulling from AgentVault ...');
      await connector.pullAll();
      console.log('[agentvault-sync] sync: pull complete');
    }

    if (direction === 'push' || direction === 'bidirectional') {
      console.log('[agentvault-sync] sync: pushing to AgentVault ...');
      let pushed = 0;
      for (const id of await listIds(flags['namespace'])) {
        await connector.pushConcept(id);
        pushed++;
      }

      console.log(`[agentvault-sync] sync: pushed ${pushed} concepts`);
    }
  } finally {
    connector.stop();
  }

  console.log('[agentvault-sync] sync: done');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `
Usage: agentvault-sync <subcommand> [options]

Subcommands:
  backup   Write a backup file (versioned JSONL)
  restore  Restore concepts from a backup file
  sync     Bidirectional sync with AgentVault memory_repo

Options (backup):
  --out <path>         Output file (default: <dataDir>/backups/polytician-backup-<time>.jsonl)
  --namespace <ns>     Only back up this namespace (default: all namespaces)
  --encrypt            Encrypt with the backup key (POLYTICIAN_BACKUP_KEY or <dataDir>/backup.key)

Options (restore):
  --file <path>        Backup file to restore (required)
  --namespace <ns>     Only restore concepts from this namespace
  --on-conflict <p>    newer (default: keep the newer copy) | overwrite | skip
  --reembed            Derive new vectors from text (needed if the embedding model changed)

Options (sync):
  --direction <dir>    push | pull | bidirectional (default: from config or bidirectional)
  --namespace <ns>     Namespace to push (default: all namespaces)
`.trim();

async function main(): Promise<void> {
  const { subcommand, flags } = parseArgs(process.argv);

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Initialize database before any operation
  initializeDatabase();

  let exitCode = 0;
  try {
    switch (subcommand) {
      case 'backup':
        await backup(flags);
        break;
      case 'restore':
        await restore(flags);
        break;
      case 'sync':
        await sync(flags);
        break;
      default:
        console.error(`Unknown subcommand: ${subcommand}\n`);
        console.log(USAGE);
        exitCode = 1;
    }
  } catch (err) {
    console.error(`[agentvault-sync] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    await closeDatabase();
  }
  process.exit(exitCode);
}

main().catch(err => {
  console.error('[agentvault-sync] fatal error:', err);
  process.exit(1);
});
