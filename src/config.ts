import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'sampling' | 'none';
  model?: string;
  apiKey?: string;
}

/**
 * Configuration for distributed / multi-node deployments.
 *
 * In a single-node setup all fields can be left at their defaults.
 *
 * For stateless horizontal scaling behind a load balancer:
 *   - Set `externalStateUrl` to a shared PostgreSQL or other supported
 *     backend so that all nodes share the same concept store.
 *   - Set `vectorIndexUrl` to a shared vector service (e.g. pgvector,
 *     Qdrant, Weaviate) so that the index is consistent across nodes.
 *
 * When `asyncIndexSync` is true the IndexSyncService processes vector
 * index updates from the event bus asynchronously, which is the required
 * pattern for event-driven synchronisation across nodes.
 */
export interface DistributedConfig {
  /** Unique identifier for this server instance (auto-generated if unset). */
  nodeId: string;
  /**
   * URL of the shared concept state backend.
   * Supports `sqlite://path` (default, single-node) and `postgres://…`.
   */
  externalStateUrl: string | null;
  /**
   * URL of a shared vector index service.
   * When null the local sqlite-vec table is used.
   */
  vectorIndexUrl: string | null;
  /**
   * When true, the IndexSyncService subscribes to concept events and
   * applies vector index changes asynchronously via the event bus.
   */
  asyncIndexSync: boolean;
}

export interface PolyticianConfig {
  dataDir: string;
  dbPath: string;
  modelsDir: string;
  embeddingModel: string;
  llm: LLMConfig;
  healthPort: number;
  sidecarUrl: string | null;
  distributed: DistributedConfig;
}

const DEFAULT_DATA_DIR = join(homedir(), '.polytician');

let cachedConfig: PolyticianConfig | null = null;

function loadConfigFile(): Partial<PolyticianConfig> & { llm?: Partial<LLMConfig> } {
  const paths = [
    join(process.cwd(), '.polytician.json'),
    join(homedir(), '.polytician.json'),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        return JSON.parse(raw) as Partial<PolyticianConfig> & { llm?: Partial<LLMConfig> };
      } catch {
        // Ignore parse errors, use defaults
      }
    }
  }

  return {};
}

function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  // Support ${ENV_VAR} syntax in config values
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
}

export function getConfig(): PolyticianConfig {
  if (cachedConfig) return cachedConfig;

  const fileConfig = loadConfigFile();
  const dataDir = process.env['POLYTICIAN_DATA_DIR'] ?? fileConfig.dataDir ?? DEFAULT_DATA_DIR;

  const healthPortRaw = process.env['POLYTICIAN_HEALTH_PORT'] ?? String(fileConfig.healthPort ?? '8787');
  const sidecarUrl = process.env['POLYTICIAN_SIDECAR_URL'] ?? (fileConfig.sidecarUrl as string | undefined) ?? null;
  const distFile = (fileConfig as { distributed?: Partial<DistributedConfig> }).distributed ?? {};

  cachedConfig = {
    dataDir,
    dbPath: join(dataDir, 'concepts.db'),
    modelsDir: join(dataDir, 'models'),
    embeddingModel: process.env['POLYTICIAN_EMBEDDING_MODEL'] ?? fileConfig.embeddingModel ?? 'Xenova/all-MiniLM-L6-v2',
    llm: {
      provider: (process.env['POLYTICIAN_LLM_PROVIDER'] as LLMConfig['provider']) ?? fileConfig.llm?.provider ?? 'none',
      model: process.env['POLYTICIAN_LLM_MODEL'] ?? fileConfig.llm?.model,
      apiKey: resolveEnvVar(process.env['POLYTICIAN_LLM_API_KEY'] ?? fileConfig.llm?.apiKey),
    },
    healthPort: parseInt(healthPortRaw, 10) || 8787,
    sidecarUrl,
    distributed: {
      nodeId: process.env['POLYTICIAN_NODE_ID'] ?? distFile.nodeId ?? generateNodeId(),
      externalStateUrl: process.env['POLYTICIAN_EXTERNAL_STATE_URL'] ?? distFile.externalStateUrl ?? null,
      vectorIndexUrl: process.env['POLYTICIAN_VECTOR_INDEX_URL'] ?? distFile.vectorIndexUrl ?? null,
      asyncIndexSync: parseBool(process.env['POLYTICIAN_ASYNC_INDEX_SYNC']) ?? distFile.asyncIndexSync ?? false,
    },
  };

  return cachedConfig;
}

function generateNodeId(): string {
  // Stable within a process; a real deployment would persist this to disk or
  // derive it from the pod/container identity.
  return `node-${Math.random().toString(36).slice(2, 10)}`;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

export function resetConfig(): void {
  cachedConfig = null;
}
