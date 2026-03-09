import { z } from 'zod';

export const AgentVaultConfigSchema = z.object({
  /** Base URL of the AgentVault API gateway. */
  apiBaseUrl: z.string().url(),
  /** Bearer token for authenticating with AgentVault. Supports ${ENV_VAR} syntax. */
  apiToken: z.string().optional(),
  /** Agent principal / canister ID for agent_vault canister. */
  agentPrincipal: z.string().optional(),
  /** Branch in memory_repo to sync concepts into. */
  memoryRepoBranch: z.string().default('polytician-main'),

  inference: z
    .object({
      preferredBackend: z.enum(['bittensor', 'venice', 'local']).optional(),
      timeoutMs: z.number().int().positive().default(30_000),
      maxRetries: z.number().int().min(0).default(2),
    })
    .default({}),

  secrets: z
    .object({
      llmApiKey: z.string().optional(),
    })
    .default({}),

  sync: z
    .object({
      enabled: z.boolean().default(false),
      direction: z.enum(['push', 'pull', 'bidirectional']).default('push'),
      pullIntervalMs: z.number().int().min(0).default(0),
    })
    .default({}),

  archival: z
    .object({
      enabled: z.boolean().default(false),
      tagFilter: z.array(z.string()).default([]),
      debounceMs: z.number().int().min(0).default(5_000),
      /** Arweave wallet JWK path or inline JSON. Path supports ${ENV_VAR} syntax. */
      arweaveJwk: z.string().optional(),
    })
    .default({}),
});

export type AgentVaultConfig = z.infer<typeof AgentVaultConfigSchema>;

export function parseAgentVaultConfig(raw: unknown): AgentVaultConfig | null {
  if (raw === undefined || raw === null) return null;
  return AgentVaultConfigSchema.parse(raw);
}
