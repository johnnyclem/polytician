import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = Math.sin(hash + i) * 0.5 + 0.01;
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { resetConfig } from '../src/config.js';

let client: Client;
let dataDir: string;

const SECRET = 'sk-live-AB12-very-secret';

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  const text = result.content[0]!.text;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { error: text };
  }
  return { body, isError: result.isError === true };
}

async function connect(): Promise<void> {
  setupTestDb();
  const server = await createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'polytician-backup-tools-'));
  process.env['POLYTICIAN_DATA_DIR'] = dataDir;
  await connect();
});

afterEach(() => {
  teardownTestDb();
  for (const name of ['POLYTICIAN_DATA_DIR', 'POLYTICIAN_NAMESPACES', 'POLYTICIAN_BACKUP_KEY']) {
    delete process.env[name];
  }
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('backup tools', () => {
  it('replace agentvault_backup', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['export_backup', 'import_backup', 'list_backups']));
    expect(names).not.toContain('agentvault_backup');
    const importTool = (await client.listTools()).tools.find(t => t.name === 'import_backup');
    expect(importTool?.annotations?.destructiveHint).toBe(true);
  });

  it('export_backup persists a file that import_backup restores (POLY-01)', async () => {
    const saved = await call('save_concept', { markdown: '# Before the migration', tags: ['keep'] });
    const work = await call('save_concept', { namespace: 'work', markdown: '# Other agent memory' });
    const id = saved.body['id'] as string;
    const workId = work.body['id'] as string;

    const exported = await call('export_backup');
    expect(exported.isError).toBe(false);
    expect(exported.body).toMatchObject({
      conceptCount: 2,
      namespaces: { default: 1, work: 1 },
      encrypted: false,
    });
    const file = exported.body['file'] as string;
    const path = join(dataDir, 'backups', file);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const listed = await call('list_backups');
    expect((listed.body['backups'] as Array<{ file: string }>).map(b => b.file)).toEqual([file]);

    await call('delete_concept', { id });
    await call('delete_concept', { id: workId, namespace: 'work' });

    const imported = await call('import_backup', { file });
    expect(imported.isError).toBe(false);
    expect(imported.body).toMatchObject({ inserted: 2, updated: 0, skipped: [] });

    const read = await call('read_concept', { id });
    expect(read.body['markdown']).toBe('# Before the migration');
    expect(read.body['tags']).toEqual(['keep']);
    const search = await call('search_concepts', { query: '# Other agent memory', namespace: 'work', k: 1 });
    expect((search.body as unknown as Array<{ id: string }>)[0]?.id).toBe(workId);
  });

  it('exports only the allowlisted namespaces when POLYTICIAN_NAMESPACES is a list', async () => {
    await call('save_concept', { namespace: 'work', markdown: 'w' });
    await call('save_concept', { namespace: 'personal', markdown: 'p' });
    process.env['POLYTICIAN_NAMESPACES'] = 'work';
    resetConfig();
    const exported = await call('export_backup');
    expect(exported.body['namespaces']).toEqual({ work: 1 });
    const denied = await call('export_backup', { namespace: 'personal' });
    expect(denied.isError).toBe(true);
    expect(denied.body['code']).toBe('NAMESPACE_DENIED');
  });

  it('skips records outside the namespace allowlist on import', async () => {
    await call('save_concept', { namespace: 'work', markdown: 'w' });
    await call('save_concept', { namespace: 'personal', markdown: 'p' });
    const { body } = await call('export_backup');
    teardownTestDb();
    process.env['POLYTICIAN_NAMESPACES'] = 'work';
    await connect();
    const imported = await call('import_backup', { file: body['file'] });
    expect(imported.body['inserted']).toBe(1);
    expect(imported.body['skipped']).toEqual([
      expect.objectContaining({ namespace: 'personal', reason: 'namespace-not-allowed' }),
    ]);
  });

  it('encrypts on request and fails closed without a key (POLY-03)', async () => {
    await call('save_concept', { markdown: `memory ${SECRET}` });
    const noKey = await call('export_backup', { encrypt: true });
    expect(noKey.isError).toBe(true);
    expect(noKey.body['code']).toBe('CONFIG_ERROR');

    process.env['POLYTICIAN_BACKUP_KEY'] = randomBytes(32).toString('base64');
    const exported = await call('export_backup', { encrypt: true });
    expect(exported.body['encrypted']).toBe(true);
    const text = readFileSync(join(dataDir, 'backups', exported.body['file'] as string), 'utf-8');
    expect(text).not.toContain(SECRET);
  });
});

describe('import_backup reads only backups (POLY-20)', () => {
  const messageOf = async (args: Record<string, unknown>): Promise<string> => {
    const result = await call('import_backup', args);
    expect(result.isError).toBe(true);
    return String(result.body['error']);
  };

  it('refuses paths outside the backups directory', async () => {
    const outside = join(dataDir, 'secret.txt');
    writeFileSync(outside, SECRET);
    for (const file of ['../secret.txt', outside, 'sub/x.jsonl', '.hidden', '..']) {
      const message = await messageOf({ file });
      expect(message).toMatch(/file must be the name of a backup/);
    }
  });

  it('refuses a symlink that leads out of the backups directory', async () => {
    const outside = join(dataDir, 'secret.txt');
    writeFileSync(outside, SECRET);
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    symlinkSync(outside, join(dataDir, 'backups', 'link.jsonl'));
    const message = await messageOf({ file: 'link.jsonl' });
    expect(message).toMatch(/regular file inside the backups directory/);
    expect(message).not.toContain('sk-live');
  });

  it('does not echo the bytes of a file that is not a backup', async () => {
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    writeFileSync(join(dataDir, 'backups', 'notes.txt'), `${SECRET}\n`);
    const message = await messageOf({ file: 'notes.txt' });
    expect(message).toMatch(/line 1 is not valid JSON/);
    expect(message).not.toContain('sk-live');

    writeFileSync(
      join(dataDir, 'backups', 'staged.json'),
      JSON.stringify({ version: 1, concepts: [{ id: 'x', markdown: 'injected memory' }] }) + '\n'
    );
    expect(await messageOf({ file: 'staged.json' })).toBe('Not a Polytician backup file');
  });

  it('reports a missing backup as NOT_FOUND', async () => {
    const result = await call('import_backup', { file: 'nope.jsonl' });
    expect(result.body['code']).toBe('NOT_FOUND');
  });
});
