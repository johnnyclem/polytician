import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'sampling' | 'none';
  model?: string;
  apiKey?: string;
}

export type DbBackend = 'sqlite' | 'postgres';

export interface PolyticianConfig {
  dataDir: string;
  dbPath: string;
  dbBackend: DbBackend;
  postgresUrl: string;
  modelsDir: string;
  embeddingModel: string;
  llm: LLMConfig;
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

  cachedConfig = {
    dataDir,
    dbPath: join(dataDir, 'concepts.db'),
    dbBackend: (process.env['POLYTICIAN_DB_BACKEND'] as DbBackend) ??
      (fileConfig as Record<string, unknown>).dbBackend ?? 'sqlite',
    postgresUrl: process.env['POLYTICIAN_POSTGRES_URL'] ??
      (fileConfig as Record<string, unknown>).postgresUrl as string ?? '',
    modelsDir: join(dataDir, 'models'),
    embeddingModel: process.env['POLYTICIAN_EMBEDDING_MODEL'] ?? fileConfig.embeddingModel ?? 'Xenova/all-MiniLM-L6-v2',
    llm: {
      provider: (process.env['POLYTICIAN_LLM_PROVIDER'] as LLMConfig['provider']) ?? fileConfig.llm?.provider ?? 'none',
      model: process.env['POLYTICIAN_LLM_MODEL'] ?? fileConfig.llm?.model,
      apiKey: resolveEnvVar(process.env['POLYTICIAN_LLM_API_KEY'] ?? fileConfig.llm?.apiKey),
    },
  };

  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
