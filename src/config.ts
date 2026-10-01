import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import {
  AgentVaultConfigSchema,
  type AgentVaultConfig,
} from './integrations/agent-vault/config.js';
import { ConfigurationError } from './errors/index.js';
import { NAMESPACE_PATTERN } from './types/limits.js';

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
 * Default port of the HTTP transport (--http) and of the opt-in stdio health
 * server. Not 8787, which stenographer's REST daemon uses.
 */
export const DEFAULT_HTTP_PORT = 8788;

/** MCP over Streamable HTTP (`--http`); stdio is the default transport. */
export interface HttpConfig {
  enabled: boolean;
  /** Interface to bind (default 127.0.0.1). */
  host: string;
  port: number;
  /**
   * Bearer token clients must send. From POLYTICIAN_HTTP_TOKEN, else read
   * from (or generated into) `tokenFile` at startup.
   */
  token: string | null;
  tokenFile: string;
  /**
   * Accepted Host header names (DNS-rebinding protection). Defaults to the
   * loopback names when bound to loopback; required otherwise.
   */
  allowedHosts: readonly string[] | null;
  /** Browser origins allowed to call the server; requests from any other Origin are refused. */
  allowedOrigins: readonly string[];
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
  /** stdio mode only: serve /health on this port (off when null, the default). */
  healthPort: number | null;
  /** Interface the stdio-mode health server binds (default 127.0.0.1). */
  healthHost: string;
  http: HttpConfig;
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

  const file = fileConfig as Record<string, unknown>;
  const healthPort = parsePort(
    'POLYTICIAN_HEALTH_PORT',
    process.env['POLYTICIAN_HEALTH_PORT'] ?? file['healthPort'],
    null
  );
  const http = parseHttpConfig(file, dataDir);

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
    healthPort,
    healthHost: process.env['POLYTICIAN_HEALTH_HOST'] ?? stringOr(file['healthHost'], '127.0.0.1'),
    http,
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
      // At least 1: pruning to 0 would delete the auto-backup just written.
      retain: parseCount(
        'POLYTICIAN_BACKUP_RETAIN',
        process.env['POLYTICIAN_BACKUP_RETAIN'] ??
          (fileConfig as Record<string, unknown>).backupRetain,
        10,
        1
      ),
    },
  };

  return cachedConfig;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** True when `host` only accepts connections from this machine. */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host) || host.startsWith('127.');
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Comma-separated string or string array; unset or empty means null. */
function parseList(raw: unknown): string[] | null {
  const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null;
  if (!items) return null;
  const list = items
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(v => v.length > 0);
  return list.length > 0 ? list : null;
}

/** A TCP port 1-65535; unset means `fallback`, anything else invalid is an error. */
function parsePort<T extends number | null>(name: string, raw: unknown, fallback: T): number | T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigurationError(`${name} must be a port number between 1 and 65535`);
  }
  return value;
}

/**
 * `--http` (or POLYTICIAN_TRANSPORT=http) selects the HTTP transport. Bound
 * to a non-loopback interface it needs an explicit Host allowlist, since the
 * loopback default would refuse every legitimate request.
 */
function parseHttpConfig(file: Record<string, unknown>, dataDir: string): HttpConfig {
  const fileHttp = (file['http'] ?? {}) as Record<string, unknown>;
  const transport = process.env['POLYTICIAN_TRANSPORT'] ?? file['transport'];
  if (transport !== undefined && transport !== 'stdio' && transport !== 'http') {
    throw new ConfigurationError('POLYTICIAN_TRANSPORT (transport) must be stdio or http');
  }
  const enabled = process.argv.includes('--http') || transport === 'http';
  const host = process.env['POLYTICIAN_HTTP_HOST'] ?? stringOr(fileHttp['host'], '127.0.0.1');
  const port = parsePort(
    'POLYTICIAN_HTTP_PORT',
    process.env['POLYTICIAN_HTTP_PORT'] ?? fileHttp['port'],
    DEFAULT_HTTP_PORT
  );
  const configuredHosts = parseList(
    process.env['POLYTICIAN_HTTP_ALLOWED_HOSTS'] ?? fileHttp['allowedHosts']
  );
  const allowedHosts = configuredHosts ?? (isLoopbackHost(host) ? LOOPBACK_HOSTS : null);
  if (enabled && allowedHosts === null) {
    throw new ConfigurationError(
      `POLYTICIAN_HTTP_ALLOWED_HOSTS is required when the HTTP transport binds ${host}: list the host names clients use to reach this server`
    );
  }
  const token = process.env['POLYTICIAN_HTTP_TOKEN'];
  if (token !== undefined && token.length < 32) {
    throw new ConfigurationError('POLYTICIAN_HTTP_TOKEN must be at least 32 characters');
  }
  return {
    enabled,
    host,
    port,
    token: token ?? null,
    tokenFile:
      process.env['POLYTICIAN_HTTP_TOKEN_FILE'] ??
      stringOr(fileHttp['tokenFile'], join(dataDir, 'http-token')),
    allowedHosts,
    allowedOrigins:
      parseList(process.env['POLYTICIAN_HTTP_ALLOWED_ORIGINS'] ?? fileHttp['allowedOrigins']) ?? [],
  };
}

/**
 * `'*'`, a comma-separated string or a string array of namespace names; only
 * an absent setting means "no allowlist". A value that is set but names no
 * namespace, or names an invalid one, is an error: reading it as unset would
 * silently lift the restriction the operator meant to set.
 */
function parseNamespaces(raw: unknown): NamespaceAllowlist {
  if (raw === undefined || raw === null) return null;
  if (raw === '*') return '*';
  const invalid = (problem: string): never => {
    throw new ConfigurationError(
      `POLYTICIAN_NAMESPACES (namespaces) ${problem}: set it to * or to namespace names separated by commas (each matching ${NAMESPACE_PATTERN.source}), or leave it unset for no allowlist`
    );
  };
  let list: string[];
  if (typeof raw === 'string') {
    list = raw
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0);
  } else if (Array.isArray(raw)) {
    list = raw.map(n => (typeof n === 'string' ? n.trim() : invalid('must list names as strings')));
  } else {
    return invalid('must be * or a list of namespace names');
  }
  if (list.length === 0) invalid('is set but names no namespace');
  if (list.includes('*')) return '*';
  const bad = list.find(n => !NAMESPACE_PATTERN.test(n));
  if (bad !== undefined) invalid(`names an invalid namespace '${bad}'`);
  return [...new Set(list)];
}

/** An integer setting of at least `min`; unset means `fallback`, anything else invalid is an error. */
function parseCount(name: string, raw: unknown, fallback: number, min = 0): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigurationError(
      `${name} must be a ${min > 0 ? 'positive' : 'non-negative'} integer`
    );
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
