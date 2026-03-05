#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initializeDatabase, closeDatabase } from './db/client.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { indexSyncService } from './services/index-sync.service.js';
import { conversionService } from './services/conversion.service.js';
import { getConfig, resetConfig } from './config.js';
import type { AgentVaultEventBridge } from './integrations/agent-vault/connectors/event-bridge.js';

async function main(): Promise<void> {
  // Initialize database (creates tables, loads sqlite-vec)
  initializeDatabase();
  logger.info('database initialized');

  // Start HTTP health check server
  const healthServer = startHealthServer();

  // Load config
  let config = getConfig();

  // Optional: inject secrets from AgentVault before config is cached
  if (config.agentVault?.secrets.llmApiKey) {
    const { AgentVaultSecretProvider } = await import(
      './integrations/agent-vault/providers/agentvault-secret.provider.js'
    );
    const secretProvider = new AgentVaultSecretProvider(config.agentVault);
    await secretProvider.injectSecrets();
    resetConfig();
    config = getConfig();
  }

  // Wire AgentVault LLM provider if configured
  if (config.agentVault && (config.llm.provider === 'agentvault' || config.llm.provider === 'none')) {
    const { AgentVaultLLMProvider } = await import(
      './integrations/agent-vault/providers/agentvault-llm.provider.js'
    );
    conversionService.setLLMProvider(new AgentVaultLLMProvider(config.agentVault));
    logger.info('llm provider set to agentvault');
  }

  // Start async index synchronisation if enabled
  if (config.distributed.asyncIndexSync) {
    indexSyncService.start();
  }

  // Start AgentVault event bridge if configured
  let avBridge: AgentVaultEventBridge | null = null;
  if (config.agentVault && (config.agentVault.sync.enabled || config.agentVault.archival.enabled)) {
    const { AgentVaultEventBridge: Bridge } = await import(
      './integrations/agent-vault/connectors/event-bridge.js'
    );
    avBridge = new Bridge(config.agentVault);
    avBridge.start();
    avBridge.initialPull().catch((err: unknown) => {
      logger.warn('av-bridge initial pull failed', { error: String(err) });
    });
  }

  // Create MCP server with all tools registered
  const server = await createServer();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp server connected', { transport: 'stdio' });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('shutdown initiated');
    avBridge?.stop();
    indexSyncService.stop();
    healthServer.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('failed to start polytician', error);
  process.exit(1);
});
