import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  BackupFormatError,
  decodeBackup,
  encodeBackup,
  type BackupRecord,
} from '../src/backup/format.js';
import { backupKeyId, type BackupKey } from '../src/backup/key.js';
import { ConfigurationError } from '../src/errors/index.js';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

function makeKey(): BackupKey {
  const key = randomBytes(32);
  return { key, keyId: backupKeyId(key) };
}

function vector(seed: number): number[] {
  return Array.from({ length: VECTOR_DIMENSION }, (_, i) => Math.fround(Math.sin(seed + i)));
}

const SECRET = 'sk-live-THIS-MUST-NOT-LEAK';

function record(overrides: Partial<BackupRecord> = {}): BackupRecord {
  return {
    type: 'concept',
    id: '11111111-1111-4111-a111-111111111111',
    namespace: 'default',
    version: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    tags: ['b', 'with "quote"'],
    markdown: `# note\n${SECRET}`,
    thoughtform: null,
    embedding: vector(1),
    derived: { vector: { from: 'markdown' } },
    ...overrides,
  };
}

const MODEL = 'Xenova/all-MiniLM-L6-v2';

function encode(records: BackupRecord[], key: BackupKey | null = null): Buffer {
  return encodeBackup({ records, embeddingModel: MODEL, embeddingDimension: VECTOR_DIMENSION, key })
    .bytes;
}

describe('backup format v1 (JSONL)', () => {
  it('round-trips records with tags, thoughtform and embeddings as JSON values', () => {
    const records = [
      record(),
      record({
        id: '22222222-2222-4222-a222-222222222222',
        namespace: 'work',
        markdown: null,
        embedding: null,
        derived: {},
        thoughtform: {
          id: '22222222-2222-4222-a222-222222222222',
          rawText: 'Ada wrote the first program.',
          metadata: {
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            author: null,
            tags: [],
            source: 'user_input',
          },
          entities: [],
          relationships: [],
          contextGraph: {},
        },
      }),
    ];
    const bytes = encode(records);
    const lines = bytes.toString('utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    const first = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(Array.isArray(first['tags'])).toBe(true);
    expect(Array.isArray(first['embedding'])).toBe(true);
    expect(typeof (JSON.parse(lines[2]!) as Record<string, unknown>)['thoughtform']).toBe('object');

    const decoded = decodeBackup(bytes, () => null);
    expect(decoded.header.embeddingModel).toBe(MODEL);
    expect(decoded.header.encryption).toBeNull();
    expect(decoded.records).toEqual(records);
    expect(decoded.footer.namespaces).toEqual({ default: 1, work: 1 });
    // float32 values survive JSON exactly
    expect(decoded.records[0]!.embedding).toEqual(vector(1));
  });

  it('encrypts the concept lines with AES-256-GCM, nonce and AAD in the header', () => {
    const key = makeKey();
    const bytes = encode([record()], key);
    const text = bytes.toString('utf-8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('"tags"');

    const header = JSON.parse(text.split('\n')[0]!) as {
      encryption: { alg: string; keyId: string; nonce: string; aad: string };
      backupId: string;
    };
    expect(header.encryption.alg).toBe('AES-256-GCM');
    expect(Buffer.from(header.encryption.nonce, 'base64')).toHaveLength(12);
    expect(header.encryption.aad).toBe(`polytician-backup/1:${header.backupId}`);
    expect(header.encryption.keyId).toBe(key.keyId);

    expect(decodeBackup(bytes, () => key).records).toEqual([record()]);
  });

  it('uses a fresh nonce for every backup', () => {
    const key = makeKey();
    const nonce = (b: Buffer): string =>
      (JSON.parse(b.toString('utf-8').split('\n')[0]!) as { encryption: { nonce: string } })
        .encryption.nonce;
    expect(nonce(encode([record()], key))).not.toBe(nonce(encode([record()], key)));
  });

  it('names the wrong key clearly', () => {
    const bytes = encode([record()], makeKey());
    const other = makeKey();
    expect(() => decodeBackup(bytes, () => other)).toThrow(/Wrong backup key: .* encrypted with key [0-9a-f]{16}, but the configured key is/);
  });

  it('asks for the key when none is configured', () => {
    const bytes = encode([record()], makeKey());
    expect(() => decodeBackup(bytes, () => null)).toThrow(ConfigurationError);
  });

  it('detects a modified ciphertext (GCM tag)', () => {
    const key = makeKey();
    const [header, body] = encode([record()], key).toString('utf-8').split('\n');
    const raw = Buffer.from(body!, 'base64');
    raw[5] = raw[5]! ^ 0xff;
    const tampered = Buffer.from(`${header}\n${raw.toString('base64')}\n`);
    expect(() => decodeBackup(tampered, () => key)).toThrow(/authentication tag mismatch/);
  });

  it('detects a modified header of an encrypted backup', () => {
    const key = makeKey();
    const [headerLine, body] = encode([record()], key).toString('utf-8').split('\n');
    const header = JSON.parse(headerLine!) as Record<string, unknown>;
    header['embeddingModel'] = 'other/model';
    const tampered = Buffer.from(`${JSON.stringify(header)}\n${body}\n`);
    expect(() => decodeBackup(tampered, () => key)).toThrow(/checksum mismatch/);
  });

  it('detects edits, truncation and bad counts in plaintext backups', () => {
    const text = encode([record(), record({ id: '33333333-3333-4333-a333-333333333333' })]).toString(
      'utf-8'
    );
    const lines = text.trimEnd().split('\n');

    const edited = text.replace('"version":3', '"version":4');
    expect(() => decodeBackup(Buffer.from(edited), () => null)).toThrow(/checksum mismatch/);

    const truncated = lines.slice(0, 2).join('\n') + '\n';
    expect(() => decodeBackup(Buffer.from(truncated), () => null)).toThrow(/no footer/);

    const dropped = [lines[0], lines[1], lines[3]].join('\n') + '\n';
    expect(() => decodeBackup(Buffer.from(dropped), () => null)).toThrow(BackupFormatError);
  });

  it('never quotes file content in parse errors', () => {
    const secretFile = Buffer.from(`${SECRET}\nmore secret text\n`);
    const messageOf = (bytes: Buffer): string => {
      try {
        decodeBackup(bytes, () => null);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('expected a failure');
    };
    const notJson = messageOf(secretFile);
    expect(notJson).not.toContain('sk-live');
    expect(notJson).toMatch(/line 1 is not valid JSON/);

    const jsonSecret = Buffer.from(JSON.stringify({ token: SECRET, concepts: [{ id: 'x' }] }) + '\n');
    const other = messageOf(jsonSecret);
    expect(other).toBe('Not a Polytician backup file');

    const header = encode([]).toString('utf-8').split('\n')[0]!;
    const badRecord = Buffer.from(
      `${header}\n${JSON.stringify({ ...record(), namespace: `${SECRET} !` })}\n`
    );
    const invalid = messageOf(badRecord);
    expect(invalid).toMatch(/line 2: field 'namespace' is invalid/);
    expect(invalid).not.toContain('sk-live');
  });

  it('rejects non-UUID ids and unknown fields', () => {
    const header = encode([]).toString('utf-8').split('\n')[0]!;
    const withId = Buffer.from(`${header}\n${JSON.stringify({ ...record(), id: 'x' })}\n`);
    expect(() => decodeBackup(withId, () => null)).toThrow(/field 'id' is invalid/);
    const extra = Buffer.from(`${header}\n${JSON.stringify({ ...record(), extra: 1 })}\n`);
    expect(() => decodeBackup(extra, () => null)).toThrow(BackupFormatError);
  });

  it('refuses a newer format version with an upgrade hint', () => {
    const [headerLine, ...rest] = encode([]).toString('utf-8').split('\n');
    const header = { ...(JSON.parse(headerLine!) as object), formatVersion: 2 };
    const bytes = Buffer.from([JSON.stringify(header), ...rest].join('\n'));
    expect(() => decodeBackup(bytes, () => null)).toThrow(/format version 2.*Upgrade Polytician/);
  });
});
