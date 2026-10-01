import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { parseAgentVaultConfig, type AgentVaultConfig } from './integrations/agent-vault/config.js';
import { ConfigurationError } from './errors/index.js';

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'sampling' | 'agentvault' | 'none';
  model?: string;
  apiKey?: string;
}

export interface NLPConfig {
  pipeline: 'rule-based' | 'llm' | 'none';
  entityTypes?: string[];
  minConfidence?: number;
}

export type DbBackend = 'sqlite' | 'postgres';

/**
 * Configuration for distributed / multi-node deployments.
 */
export interface DistributedConfig {
  nodeId: string;
  externalStateUrl: string | null;
  vectorIndexUrl: string | null;
}

/**
 * Namespaces this server may address.
 * - `null` (unset): any namespace; cross-namespace search is refused.
 * - `'*'`: any namespace; cross-namespace search spans all of them.
 * - a list: only these namespaces; cross-namespace search spans the list.
 */
export type NamespaceAllowlist = readonly string[] | '*' | null;

export interface BackupConfig {
  /** Write an auto-backup after this many saves. 0 (the default) disables auto-backup. */
  threshold: number;
  /** Auto-backups to keep; older ones are deleted after each auto-backup. */
  retain: number;
}

export interface PolyticianConfig {
  dataDir: string;
  dbPath: string;
  dbBackend: DbBackend;
  postgresUrl: string;
  modelsDir: string;
  embeddingModel: string;
  llm: LLMConfig;
  nlp: NLPConfig;
  healthPort: number;
  sidecarUrl: string | null;
  distributed: DistributedConfig;
  namespaces: NamespaceAllowlist;
  agentVault?: AgentVaultConfig;
  /** Require every backup file to be encrypted (AES-256-GCM with the backup key). */
  encrypt: boolean;
  backup: BackupConfig;
}

const DEFAULT_DATA_DIR = join(homedir(), '.polytician');

let cachedConfig: PolyticianConfig | null = null;

function loadConfigFile(): Partial<PolyticianConfig> & {
  llm?: Partial<LLMConfig>;
  nlp?: Partial<NLPConfig>;
} {
  const paths = [join(process.cwd(), '.polytician.json'), join(homedir(), '.polytician.json')];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        return JSON.parse(raw) as Partial<PolyticianConfig> & {
          llm?: Partial<LLMConfig>;
          nlp?: Partial<NLPConfig>;
        };
      } catch {
        // Ignore parse errors, use defaults
      }
    }
  }

  return {};
}

function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
}

export function getConfig(): PolyticianConfig {
  if (cachedConfig) return cachedConfig;

  const fileConfig = loadConfigFile();
  const dataDir = process.env['POLYTICIAN_DATA_DIR'] ?? fileConfig.dataDir ?? DEFAULT_DATA_DIR;

  const healthPortRaw =
    process.env['POLYTICIAN_HEALTH_PORT'] ?? String(fileConfig.healthPort ?? '8787');
  const sidecarUrl =
    process.env['POLYTICIAN_SIDECAR_URL'] ?? (fileConfig.sidecarUrl as string | undefined) ?? null;
  const distFile = (fileConfig as { distributed?: Partial<DistributedConfig> }).distributed ?? {};

  // AgentVault integration config (optional, sync Zod parse)
  const rawAv = (fileConfig as Record<string, unknown>).agentVault;
  const avApiBase = process.env['POLYTICIAN_AV_API_URL'];
  const avApiToken =
    resolveEnvVar(process.env['POLYTICIAN_AV_API_TOKEN']) ??
    resolveEnvVar((rawAv as Record<string, string> | undefined)?.apiToken);
  let agentVaultConfig: AgentVaultConfig | undefined;
  if (rawAv || avApiBase) {
    try {
      const merged = {
        ...((rawAv as Record<string, unknown>) ?? {}),
        ...(avApiBase ? { apiBaseUrl: avApiBase } : {}),
        ...(avApiToken ? { apiToken: avApiToken } : {}),
      };
      agentVaultConfig = parseAgentVaultConfig(merged) ?? undefined;
    } catch {
      // AgentVault config parse failed — continue without it
    }
  }

  const encryptFlag =
    process.argv.includes('--encrypt') ||
    parseBool(process.env['POLYTICIAN_ENCRYPT']) ||
    (fileConfig as Record<string, unknown>).encrypt === true;

  cachedConfig = {
    dataDir,
    dbPath: join(dataDir, 'concepts.db'),
    dbBackend:
      (process.env['POLYTICIAN_DB_BACKEND'] as DbBackend) ??
      (fileConfig as Record<string, unknown>).dbBackend ??
      'sqlite',
    postgresUrl:
      process.env['POLYTICIAN_POSTGRES_URL'] ??
      ((fileConfig as Record<string, unknown>).postgresUrl as string) ??
      '',
    modelsDir: join(dataDir, 'models'),
    embeddingModel:
      process.env['POLYTICIAN_EMBEDDING_MODEL'] ??
      fileConfig.embeddingModel ??
      'Xenova/all-MiniLM-L6-v2',
    llm: {
      provider:
        (process.env['POLYTICIAN_LLM_PROVIDER'] as LLMConfig['provider']) ??
        fileConfig.llm?.provider ??
        'none',
      model: process.env['POLYTICIAN_LLM_MODEL'] ?? fileConfig.llm?.model,
      apiKey: resolveEnvVar(process.env['POLYTICIAN_LLM_API_KEY'] ?? fileConfig.llm?.apiKey),
    },
    nlp: {
      pipeline:
        (process.env['POLYTICIAN_NLP_PIPELINE'] as NLPConfig['pipeline']) ??
        fileConfig.nlp?.pipeline ??
        'none',
      entityTypes: fileConfig.nlp?.entityTypes,
      minConfidence: fileConfig.nlp?.minConfidence,
    },
    healthPort: parseInt(healthPortRaw, 10) || 8787,
    sidecarUrl,
    distributed: {
      nodeId: process.env['POLYTICIAN_NODE_ID'] ?? distFile.nodeId ?? generateNodeId(),
      externalStateUrl:
        process.env['POLYTICIAN_EXTERNAL_STATE_URL'] ?? distFile.externalStateUrl ?? null,
      vectorIndexUrl: process.env['POLYTICIAN_VECTOR_INDEX_URL'] ?? distFile.vectorIndexUrl ?? null,
    },
    namespaces: parseNamespaces(
      process.env['POLYTICIAN_NAMESPACES'] ?? (fileConfig as Record<string, unknown>).namespaces
    ),
    agentVault: agentVaultConfig,
    encrypt: !!encryptFlag,
    backup: {
      threshold: parseCount(
        'POLYTICIAN_BACKUP_THRESHOLD',
        process.env['POLYTICIAN_BACKUP_THRESHOLD'] ??
          (fileConfig as Record<string, unknown>).backupThreshold,
        0
      ),
      retain: parseCount(
        'POLYTICIAN_BACKUP_RETAIN',
        process.env['POLYTICIAN_BACKUP_RETAIN'] ??
          (fileConfig as Record<string, unknown>).backupRetain,
        10
      ),
    },
  };

  return cachedConfig;
}

function generateNodeId(): string {
  return `node-${Math.random().toString(36).slice(2, 10)}`;
}

/** Accepts `'*'`, a comma-separated string, or a string array; anything else means unset. */
function parseNamespaces(raw: unknown): NamespaceAllowlist {
  if (raw === undefined || raw === null) return null;
  if (raw === '*') return '*';
  const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null;
  if (!items) return null;
  const list = items
    .filter((n): n is string => typeof n === 'string')
    .map(n => n.trim())
    .filter(n => n.length > 0);
  if (list.includes('*')) return '*';
  return list.length > 0 ? [...new Set(list)] : null;
}

/** A non-negative integer setting; unset means `fallback`, anything else invalid is an error. */
function parseCount(name: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

export function resetConfig(): void {
  cachedConfig = null;
}
