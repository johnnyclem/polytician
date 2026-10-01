import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or plain http to this machine only (a local AgentVault during development). */
function isAllowedEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

export const AgentVaultConfigSchema = z
  .object({
    /** Base URL of the AgentVault API gateway: https, or http on localhost. */
    apiBaseUrl: z
      .string()
      .url()
      .refine(isAllowedEndpoint, 'must use https (plain http is allowed only for localhost)'),
    /**
     * Bearer token for authenticating with AgentVault. In the config file it
     * may reference POLYTICIAN_* environment variables as ${NAME}.
     */
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

    sync: z
      .object({
        enabled: z.boolean().default(false),
        direction: z.enum(['push', 'pull', 'bidirectional']).default('push'),
        pullIntervalMs: z.number().int().min(0).default(0),
      })
      .default({}),

    /**
     * Permanent, public archival to Arweave. Off by default. When enabled,
     * only concepts carrying every tag in tagFilter are archived, and the
     * content is always encrypted with the backup key before upload.
     */
    archival: z
      .object({
        enabled: z.boolean().default(false),
        tagFilter: z.array(z.string().min(1)).default([]),
        debounceMs: z.number().int().min(0).default(5_000),
        /**
         * Arweave wallet JWK: a file path, inline JSON, or ${POLYTICIAN_*}
         * naming an environment variable that holds either.
         */
        arweaveJwk: z.string().optional(),
        /** Upload timeout; uploads are never retried, since each one is a paid, permanent copy. */
        timeoutMs: z.number().int().positive().default(120_000),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    if (config.archival.enabled && config.archival.tagFilter.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['archival', 'tagFilter'],
        message:
          'archival.enabled requires a non-empty archival.tagFilter: archiving is permanent and public, so only concepts carrying every listed tag are archived',
      });
    }
  });

export type AgentVaultConfig = z.infer<typeof AgentVaultConfigSchema>;

export function parseAgentVaultConfig(raw: unknown): AgentVaultConfig | null {
  if (raw === undefined || raw === null) return null;
  return AgentVaultConfigSchema.parse(raw);
}
