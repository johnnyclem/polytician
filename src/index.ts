#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initializeDatabase, closeDatabase } from './db/client.js';

async function main(): Promise<void> {
  // Initialize database (creates tables, loads sqlite-vec)
  initializeDatabase();

  // Create MCP server with all tools registered
  const server = createServer();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = (): void => {
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start Polytician:', error);
  process.exit(1);
});
