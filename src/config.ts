import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import {
  AgentVaultConfigSchema,
  type AgentVaultConfig,
} from './integrations/agent-vault/config.js';
import { ConfigurationError } from './errors/index.js';

/**
 * LLM used by conversions that generate content. 'agentvault' sends the text
 * being converted (and neighbouring concepts' text) to AgentVault's
 * inference chain, so it is only used when chosen explicitly.
 */
export interface LLMConfig {
  provider: 'agentvault' | 'none';
}

const LLM_PROVIDERS: readonly LLMConfig['provider'][] = ['none', 'agentvault'];

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

type FileConfig = Partial<PolyticianConfig> & {
  llm?: Partial<LLMConfig>;
  nlp?: Partial<NLPConfig>;
};

/** The default config file. Nothing is read from the working directory. */
export const DEFAULT_CONFIG_FILE = join(homedir(), '.polytician', 'config.json');

/** `--config <path>` or `--config=<path>` from the command line, if given. */
function configFlag(): string | null {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const path = argv[i + 1];
      if (!path || path.startsWith('--'))
        throw new ConfigurationError('--config needs a file path');
      return resolve(path);
    }
    if (arg?.startsWith('--config=')) return resolve(arg.slice('--config='.length));
  }
  return null;
}

/**
 * Settings from `--config <path>`, else ~/.polytician/config.json. The
 * working directory is never consulted: MCP clients start servers with the
 * opened project as cwd, so a file there is not trusted. A file that exists
 * but cannot be parsed is an error rather than silently ignored.
 */
function loadConfigFile(): FileConfig {
  const explicit = configFlag();
  const path = explicit ?? DEFAULT_CONFIG_FILE;
  if (!existsSync(path)) {
    if (explicit) throw new ConfigurationError(`Config file not found: ${path}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new ConfigurationError(`Config file ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationError(`Config file ${path} must hold a JSON object`);
  }
  return parsed as FileConfig;
}

/**
 * Expand `${NAME}` references in a config-file value. Only POLYTICIAN_*
 * variables may be referenced, so a config value cannot pull an unrelated
 * secret (say AWS_SECRET_ACCESS_KEY) out of the environment.
 */
export function expandConfigValue(value: string, field: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!name.startsWith('POLYTICIAN_')) {
      throw new ConfigurationError(
        `${field} references \${${name}}; config values can only reference POLYTICIAN_* environment variables`
      );
    }
    return process.env[name] ?? '';
  });
}

function parseLLMProvider(raw: unknown): LLMConfig['provider'] {
  const value = raw ?? 'none';
  if (!LLM_PROVIDERS.includes(value as LLMConfig['provider'])) {
    throw new ConfigurationError(
      `POLYTICIAN_LLM_PROVIDER (llm.provider) must be one of: ${LLM_PROVIDERS.join(', ')}`
    );
  }
  return value as LLMConfig['provider'];
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

  // AgentVault integration config (optional). An invalid configuration is an
  // error: silently dropping it would also drop its egress restrictions.
  const rawAv = (fileConfig as Record<string, unknown>).agentVault as
    | Record<string, unknown>
    | undefined;
  const avApiBase = process.env['POLYTICIAN_AV_API_URL'];
  const fileToken = typeof rawAv?.['apiToken'] === 'string' ? rawAv['apiToken'] : undefined;
  const avApiToken =
    process.env['POLYTICIAN_AV_API_TOKEN'] ??
    (fileToken !== undefined ? expandConfigValue(fileToken, 'agentVault.apiToken') : undefined);
  let agentVaultConfig: AgentVaultConfig | undefined;
  if (rawAv || avApiBase) {
    const merged = {
      ...(rawAv ?? {}),
      ...(avApiBase ? { apiBaseUrl: avApiBase } : {}),
      ...(avApiToken ? { apiToken: avApiToken } : {}),
    };
    const parsed = AgentVaultConfigSchema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ConfigurationError(
        `AgentVault configuration is invalid: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`
      );
    }
    agentVaultConfig = parsed.data;
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
      provider: parseLLMProvider(
        process.env['POLYTICIAN_LLM_PROVIDER'] ?? fileConfig.llm?.provider
      ),
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
