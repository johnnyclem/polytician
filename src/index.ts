/**
 * Politician MCP Server
 *
 * A local AI agent that stores concepts in three representations:
 * - Vectors (768-dim embeddings via sentence-transformers)
 * - Markdown (human-readable text)
 * - ThoughtForm (structured JSON with entities, relationships, context graph)
 *
 * Provides 12 commands for CRUD and conversion operations.
 */

import { startServer } from "./server.js";

// Start the MCP server
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
