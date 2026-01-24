/**
 * MCP Server Setup
 *
 * Configures the Anthropic Model Context Protocol server with all tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { saveCommands } from "./commands/save.js";
import { readCommands } from "./commands/read.js";
import { convertCommands } from "./commands/convert.js";
import { conceptService } from "./services/concept.service.js";
import { pythonBridge } from "./services/python-bridge.js";
import { initializeDatabase, closeDatabase } from "./db/client.js";

// Combine all commands
const allCommands = {
  ...saveCommands,
  ...readCommands,
  ...convertCommands,
};

// Additional utility commands
const utilityCommands = {
  list_concepts: {
    description: "List all stored concepts with their available representations",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const concepts = await conceptService.listAll();
        const results = await Promise.all(
          concepts.map(async (c) => ({
            id: c.id,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            tags: c.tags,
            representations: {
              vectors: c.vectorBlob !== null,
              md: c.mdBlob !== null,
              thoughtForm: c.thoughtformBlob !== null,
            },
          }))
        );
        return { success: true, data: { concepts: results, count: results.length } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },
  get_representations: {
    description: "Check which representations exist for a concept",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", description: "Concept UUID" },
      },
      required: ["id"],
    },
    handler: async (input: unknown) => {
      try {
        const { id } = input as { id: string };
        const reps = await conceptService.getRepresentations(id);
        return { success: true, data: reps };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },
  delete_concept: {
    description: "Delete a concept and all its representations",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", description: "Concept UUID" },
      },
      required: ["id"],
    },
    handler: async (input: unknown) => {
      try {
        const { id } = input as { id: string };
        await conceptService.delete(id);
        return { success: true, data: { deleted: id } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  },
  generate_id: {
    description: "Generate a new UUID for a concept",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      const id = conceptService.generateId();
      return { success: true, data: { id } };
    },
  },
  health_check: {
    description: "Check the health of the server and Python sidecar",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const pythonHealth = await pythonBridge.getHealth();
        return {
          success: true,
          data: {
            server: "ok",
            python_sidecar: pythonHealth,
          },
        };
      } catch (error) {
        return {
          success: true,
          data: {
            server: "ok",
            python_sidecar: {
              status: "error",
              error: error instanceof Error ? error.message : "Unknown error",
            },
          },
        };
      }
    },
  },
};

// Merge all commands
const commands = { ...allCommands, ...utilityCommands };

// Type for command handlers
type CommandHandler = (input: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: "politician",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list_tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = Object.entries(commands).map(([name, cmd]) => ({
      name,
      description: cmd.description,
      inputSchema: cmd.inputSchema as Tool["inputSchema"],
    }));

    return { tools };
  });

  // Handle call_tool request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const command = commands[name as keyof typeof commands];

    if (!command) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }),
          },
        ],
      };
    }

    try {
      const handler = command.handler as CommandHandler;
      const result = await handler(args);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          },
        ],
      };
    }
  });

  return server;
}

/**
 * Start the MCP server
 */
export async function startServer(): Promise<void> {
  console.log("Starting Politician MCP Server...");

  // Initialize database
  initializeDatabase();

  // Start Python sidecar
  console.log("Starting Python sidecar...");
  await pythonBridge.start();

  // Create and start MCP server
  const server = createServer();
  const transport = new StdioServerTransport();

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await pythonBridge.stop();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  console.log("Politician MCP Server running on stdio");
}
