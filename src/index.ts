#!/usr/bin/env node

import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initializeDatabaseAsync, closeDatabase } from './db/client.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { backupService } from './services/backup.service.js';
import { getConfig } from './config.js';
import { configureProviders } from './providers/configure.js';
import { requireBackupKey } from './backup/key.js';
import {
  loadOrCreateHttpToken,
  startHttpServer,
  type RunningHttpServer,
} from './transport/http.js';
import type { AgentVaultEventBridge } from './integrations/agent-vault/connectors/event-bridge.js';

/** Settings 3.0 removed; still setting them is almost certainly a stale deployment file. */
const REMOVED_SETTINGS = [
  'POLYTICIAN_SIDECAR_URL',
  'POLYTICIAN_NODE_ID',
  'POLYTICIAN_EXTERNAL_STATE_URL',
  'POLYTICIAN_VECTOR_INDEX_URL',
];

async function main(): Promise<void> {
  // Load config (env, --config or ~/.polytician/config.json; never the cwd)
  const config = getConfig();
  for (const name of REMOVED_SETTINGS.filter(n => process.env[n] !== undefined)) {
    logger.warn('setting removed in 3.0 is ignored', { setting: name });
  }

  // Initialize database (creates tables, loads sqlite-vec or pgvector)
  await initializeDatabaseAsync();
  logger.info('database initialized');

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

  let healthServer: Server | null = null;
  let httpServer: RunningHttpServer | null = null;

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown initiated', { reason });
    backupService.stop();
    avBridge?.stop();
    healthServer?.close();
    await httpServer?.close();
    try {
      // Close the DB (async for Postgres).
      await closeDatabase();
    } catch (err) {
      logger.error('shutdown cleanup failed', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.http.enabled) {
    // MCP over Streamable HTTP, with /health on the same port.
    const { host, port, allowedHosts, allowedOrigins } = config.http;
    httpServer = await startHttpServer({
      host,
      port,
      token: loadOrCreateHttpToken(config.http),
      allowedHosts: allowedHosts ?? [],
      allowedOrigins,
    });
    logger.info('mcp server listening', {
      transport: 'http',
      url: `${httpServer.url}/mcp`,
      token: config.http.token ? 'POLYTICIAN_HTTP_TOKEN' : config.http.tokenFile,
    });
    return;
  }

  // stdio: one client per process. Health is opt-in (POLYTICIAN_HEALTH_PORT).
  healthServer = startHealthServer();
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp server connected', { transport: 'stdio' });

  // The client closing our stdin means it is gone: exit rather than linger
  // as an orphan holding the database (and the health port, if enabled).
  process.stdin.once('end', () => void shutdown('stdin closed'));
  process.stdin.once('close', () => void shutdown('stdin closed'));
}

main().catch(error => {
  logger.error('failed to start polytician', error);
  process.exit(1);
});
