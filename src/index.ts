#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initializeDatabaseAsync, closeDatabase } from './db/client.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { backupService } from './services/backup.service.js';
import { getConfig } from './config.js';
import { configureProviders } from './providers/configure.js';
import { requireBackupKey } from './backup/key.js';
import type { AgentVaultEventBridge } from './integrations/agent-vault/connectors/event-bridge.js';

async function main(): Promise<void> {
  // Initialize database (creates tables, loads sqlite-vec or pgvector)
  await initializeDatabaseAsync();
  logger.info('database initialized');

  // Start HTTP health check server
  const healthServer = startHealthServer();

  // Load config (env, --config or ~/.polytician/config.json; never the cwd)
  const config = getConfig();

  await configureProviders(config);

  // Encryption was requested: refuse to run rather than fail every backup later.
  if (config.encrypt) requireBackupKey('POLYTICIAN_ENCRYPT');

  if (config.agentVault) {
    // Every off-box destination, so operators can see where data may go.
    logger.info('agentvault integration enabled', {
      endpoint: config.agentVault.apiBaseUrl,
      llm: config.llm.provider === 'agentvault',
      sync: config.agentVault.sync.enabled ? config.agentVault.sync.direction : 'off',
      archival: config.agentVault.archival.enabled
        ? { tagFilter: config.agentVault.archival.tagFilter }
        : 'off',
    });
  }

  // Start AgentVault event bridge if configured
  let avBridge: AgentVaultEventBridge | null = null;
  if (config.agentVault && (config.agentVault.sync.enabled || config.agentVault.archival.enabled)) {
    const { AgentVaultEventBridge: Bridge } =
      await import('./integrations/agent-vault/connectors/event-bridge.js');
    avBridge = new Bridge(config.agentVault);
    avBridge.start();
    avBridge.initialPull().catch((err: unknown) => {
      logger.warn('av-bridge initial pull failed', { error: String(err) });
    });
  }

  // Start auto-backup service (writes nothing unless POLYTICIAN_BACKUP_THRESHOLD > 0)
  backupService.start();

  // Create MCP server with all tools registered
  const server = await createServer();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp server connected', { transport: 'stdio' });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown initiated');
    backupService.stop();
    avBridge?.stop();
    healthServer.close();
    try {
      // Close the DB (async for Postgres).
      await closeDatabase();
    } catch (err) {
      logger.error('shutdown cleanup failed', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(error => {
  logger.error('failed to start polytician', error);
  process.exit(1);
});
