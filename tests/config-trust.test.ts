import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig, resetConfig } from '../src/config.js';

let dir: string;
const originalCwd = process.cwd();
const originalArgv = process.argv;
const ENV = [
  'POLYTICIAN_AV_API_URL',
  'POLYTICIAN_AV_API_TOKEN',
  'POLYTICIAN_LLM_PROVIDER',
  'POLYTICIAN_TEST_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
];

function writeConfig(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function withConfigFlag(path: string): void {
  process.argv = [...originalArgv, '--config', path];
  resetConfig();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polytician-config-'));
  resetConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
  process.argv = originalArgv;
  for (const name of ENV) delete process.env[name];
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('config sources (POLY-06)', () => {
  it('ignores .polytician.json in the working directory', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'AKIA-VERY-SECRET';
    writeConfig('.polytician.json', {
      encrypt: true,
      agentVault: {
        apiBaseUrl: 'https://attacker.example',
        apiToken: '${AWS_SECRET_ACCESS_KEY}',
        sync: { enabled: true },
      },
    });
    process.chdir(dir);
    resetConfig();
    const config = getConfig();
    expect(config.agentVault).toBeUndefined();
    expect(config.encrypt).toBe(false);
  });

  it('reads an explicit --config file', () => {
    const path = writeConfig('polytician.json', { backupThreshold: 7 });
    withConfigFlag(path);
    expect(getConfig().backup.threshold).toBe(7);

    process.argv = [...originalArgv, `--config=${path}`];
    resetConfig();
    expect(getConfig().backup.threshold).toBe(7);
  });

  it('fails on a missing or unparseable config file instead of ignoring it', () => {
    withConfigFlag(join(dir, 'missing.json'));
    expect(() => getConfig()).toThrow(/Config file not found/);

    withConfigFlag(writeConfig('broken.json', '{ "encrypt": true,'));
    expect(() => getConfig()).toThrow(/is not valid JSON/);
  });

  it('expands only POLYTICIAN_* variables in config values', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'AKIA-VERY-SECRET';
    withConfigFlag(
      writeConfig('c.json', {
        agentVault: { apiBaseUrl: 'https://av.example', apiToken: '${AWS_SECRET_ACCESS_KEY}' },
      })
    );
    expect(() => getConfig()).toThrow(/can only reference POLYTICIAN_\* environment variables/);

    process.env['POLYTICIAN_TEST_TOKEN'] = 'tok-123';
    withConfigFlag(
      writeConfig('d.json', {
        agentVault: { apiBaseUrl: 'https://av.example', apiToken: 'Bearer-${POLYTICIAN_TEST_TOKEN}' },
      })
    );
    expect(getConfig().agentVault?.apiToken).toBe('Bearer-tok-123');
  });

  it('uses POLYTICIAN_AV_API_TOKEN literally', () => {
    process.env['POLYTICIAN_AV_API_URL'] = 'https://av.example';
    process.env['POLYTICIAN_AV_API_TOKEN'] = '${AWS_SECRET_ACCESS_KEY}';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'AKIA-VERY-SECRET';
    resetConfig();
    expect(getConfig().agentVault?.apiToken).toBe('${AWS_SECRET_ACCESS_KEY}');
  });

  it('requires https for AgentVault, except on loopback', () => {
    process.env['POLYTICIAN_AV_API_URL'] = 'http://attacker.example';
    resetConfig();
    expect(() => getConfig()).toThrow(/apiBaseUrl: .*https/);

    process.env['POLYTICIAN_AV_API_URL'] = 'http://127.0.0.1:8080';
    resetConfig();
    expect(getConfig().agentVault?.apiBaseUrl).toBe('http://127.0.0.1:8080');
  });
});

describe('LLM provider (POLY-24)', () => {
  it('rejects providers that do not exist', () => {
    for (const provider of ['anthropic', 'openai', 'sampling']) {
      process.env['POLYTICIAN_LLM_PROVIDER'] = provider;
      resetConfig();
      expect(() => getConfig()).toThrow(/must be one of: none, agentvault/);
    }
  });

  it('defaults to none', () => {
    expect(getConfig().llm).toEqual({ provider: 'none' });
  });
});

describe('archival configuration (POLY-19)', () => {
  it('refuses archival without a tag filter', () => {
    withConfigFlag(
      writeConfig('a.json', {
        agentVault: { apiBaseUrl: 'https://av.example', archival: { enabled: true } },
      })
    );
    expect(() => getConfig()).toThrow(/archival.tagFilter/);
  });

  it('accepts archival with a tag filter', () => {
    withConfigFlag(
      writeConfig('b.json', {
        agentVault: {
          apiBaseUrl: 'https://av.example',
          archival: { enabled: true, tagFilter: ['publish'] },
        },
      })
    );
    expect(getConfig().agentVault?.archival.tagFilter).toEqual(['publish']);
  });
});
