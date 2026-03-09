#!/usr/bin/env tsx

/**
 * agentvault-sync CLI
 *
 * Top-level CLI for managing Polytician ↔ AgentVault synchronisation.
 *
 * Subcommands:
 *   backup  — Export all concepts from the local database to a JSON file
 *   restore — Import concepts from a JSON backup file into the local database
 *   sync    — Bidirectional sync with AgentVault memory_repo
 *
 * Usage:
 *   npx tsx bin/agentvault-sync.ts backup  [--out <path>] [--namespace <ns>]
 *   npx tsx bin/agentvault-sync.ts restore [--file <path>]
 *   npx tsx bin/agentvault-sync.ts sync    [--direction push|pull|bidirectional] [--namespace <ns>]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeDatabase, closeDatabase } from '../src/db/client.js';
import { conceptService } from '../src/services/concept.service.js';
import { getConfig, resetConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
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

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

async function backup(flags: Record<string, string>): Promise<void> {
  const namespace = flags['namespace'] ?? undefined;
  const defaultFile = `polytician-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outPath = flags['out'] ?? join(process.cwd(), defaultFile);

  console.log(`[agentvault-sync] backup: exporting concepts${namespace ? ` (namespace: ${namespace})` : ''} ...`);

  // Paginate through all concepts
  const allConcepts: Array<Record<string, unknown>> = [];
  const pageSize = 100;
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await conceptService.list({ namespace, limit: pageSize, offset });
    if (page.concepts.length === 0) break;

    for (const summary of page.concepts) {
      const full = await conceptService.read(summary.id);
      allConcepts.push(full);
    }

    offset += page.concepts.length;
    if (offset >= page.total) break;
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    namespace: namespace ?? 'all',
    conceptCount: allConcepts.length,
    concepts: allConcepts,
  };

  const dir = join(outPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[agentvault-sync] backup: wrote ${allConcepts.length} concepts to ${outPath}`);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

interface BackupPayload {
  version: number;
  concepts: Array<{
    id?: string;
    namespace?: string;
    markdown?: string | null;
    thoughtform?: unknown;
    embedding?: number[] | null;
    tags?: string[];
  }>;
}

async function restore(flags: Record<string, string>): Promise<void> {
  const filePath = flags['file'];
  if (!filePath) {
    console.error('[agentvault-sync] restore: --file <path> is required');
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    console.error(`[agentvault-sync] restore: file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`[agentvault-sync] restore: reading ${filePath} ...`);
  const raw = readFileSync(filePath, 'utf-8');
  const payload = JSON.parse(raw) as BackupPayload;

  if (!payload.concepts || !Array.isArray(payload.concepts)) {
    console.error('[agentvault-sync] restore: invalid backup file — missing "concepts" array');
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  for (const entry of payload.concepts) {
    try {
      await conceptService.save({
        id: entry.id,
        namespace: entry.namespace,
        markdown: entry.markdown ?? undefined,
        thoughtform: entry.thoughtform as undefined,
        embedding: entry.embedding ?? undefined,
        tags: entry.tags ?? [],
      });
      imported++;
    } catch (err) {
      logger.warn('restore: failed to import concept', { id: entry.id, error: String(err) });
      skipped++;
    }
  }

  console.log(`[agentvault-sync] restore: imported ${imported} concepts, skipped ${skipped}`);
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function sync(flags: Record<string, string>): Promise<void> {
  const config = getConfig();

  if (!config.agentVault) {
    console.error(
      '[agentvault-sync] sync: AgentVault integration is not configured.\n' +
      'Set agentVault config in .polytician.json or via POLYTICIAN_AV_API_URL / POLYTICIAN_AV_API_TOKEN env vars.'
    );
    process.exit(1);
  }

  const direction = (flags['direction'] ?? config.agentVault.sync.direction ?? 'bidirectional') as
    'push' | 'pull' | 'bidirectional';

  console.log(`[agentvault-sync] sync: direction=${direction}`);

  const { MemorySyncConnector } = await import(
    '../src/integrations/agent-vault/connectors/memory-sync.connector.js'
  );

  const connector = new MemorySyncConnector(config.agentVault);

  try {
    if (direction === 'pull' || direction === 'bidirectional') {
      console.log('[agentvault-sync] sync: pulling from AgentVault ...');
      await connector.pullAll();
      console.log('[agentvault-sync] sync: pull complete');
    }

    if (direction === 'push' || direction === 'bidirectional') {
      console.log('[agentvault-sync] sync: pushing to AgentVault ...');
      const namespace = flags['namespace'] ?? undefined;
      const page = await conceptService.list({ namespace, limit: 100, offset: 0 });

      let pushed = 0;
      for (const summary of page.concepts) {
        await connector.pushConcept(summary.id);
        pushed++;
      }

      // Handle remaining pages
      let offset = page.concepts.length;
      while (offset < page.total) {
        const nextPage = await conceptService.list({ namespace, limit: 100, offset });
        for (const summary of nextPage.concepts) {
          await connector.pushConcept(summary.id);
          pushed++;
        }
        offset += nextPage.concepts.length;
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
  backup   Export all concepts to a JSON file
  restore  Import concepts from a JSON backup file
  sync     Bidirectional sync with AgentVault memory_repo

Options (backup):
  --out <path>        Output file path (default: ./polytician-backup-<timestamp>.json)
  --namespace <ns>    Only export concepts from this namespace

Options (restore):
  --file <path>       Path to backup JSON file (required)

Options (sync):
  --direction <dir>   push | pull | bidirectional (default: from config or bidirectional)
  --namespace <ns>    Namespace to sync
`.trim();

async function main(): Promise<void> {
  const { subcommand, flags } = parseArgs(process.argv);

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Initialize database before any operation
  initializeDatabase();

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
        process.exit(1);
    }
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('[agentvault-sync] fatal error:', err);
  process.exit(1);
});
