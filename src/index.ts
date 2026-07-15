#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initializeDatabaseAsync, closeDatabase } from './db/client.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { indexSyncService } from './services/index-sync.service.js';
import { conversionService } from './services/conversion.service.js';
import { backupService } from './services/backup.service.js';
import { getConfig, resetConfig } from './config.js';
import type { AgentVaultEventBridge } from './integrations/agent-vault/connectors/event-bridge.js';

async function main(): Promise<void> {
  // Initialize database (creates tables, loads sqlite-vec or pgvector)
  await initializeDatabaseAsync();
  logger.info('database initialized');

  // Start HTTP health check server
  const healthServer = startHealthServer();

  // Load config
  let config = getConfig();

  // Optional: inject secrets from AgentVault before config is cached
  if (config.agentVault?.secrets.llmApiKey) {
    const { AgentVaultSecretProvider } =
      await import('./integrations/agent-vault/providers/agentvault-secret.provider.js');
    const secretProvider = new AgentVaultSecretProvider(config.agentVault);
    await secretProvider.injectSecrets();
    resetConfig();
    config = getConfig();
  }

  // Wire AgentVault LLM provider if configured
  if (
    config.agentVault &&
    (config.llm.provider === 'agentvault' || config.llm.provider === 'none')
  ) {
    const { AgentVaultLLMProvider } =
      await import('./integrations/agent-vault/providers/agentvault-llm.provider.js');
    conversionService.setLLMProvider(new AgentVaultLLMProvider(config.agentVault));
    logger.info('llm provider set to agentvault');
  }

  // Wire the configured NLP pipeline (used by markdown→thoughtform conversion)
  if (config.nlp.pipeline === 'rule-based') {
    const { RuleBasedNLPPipeline } = await import('./providers/rule-based-nlp.pipeline.js');
    conversionService.setNLPPipeline(new RuleBasedNLPPipeline());
    logger.info('nlp pipeline set to rule-based');
  }

  // Start async index synchronisation if enabled
  if (config.distributed.asyncIndexSync) {
    indexSyncService.start();
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

  // Start auto-backup service (always active; threshold=0 disables it)
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
    indexSyncService.stop();
    healthServer.close();
    try {
      // Drain queued vector-index updates, then close the DB (async for Postgres).
      await indexSyncService.waitForPending();
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
