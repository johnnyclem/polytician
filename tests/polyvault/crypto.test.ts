import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { compress, decompress } from '../../src/polyvault/compress.js';
import {
  NoopCryptoAdapter,
  AesGcmCryptoAdapter,
  EncryptionRequiredError,
  DecryptionError,
  createCryptoAdapter,
  requireEncryptionAdapter,
} from '../../src/polyvault/crypto.js';
import { serializeBundle } from '../../src/polyvault/serializer.js';
import { chunkPayload, reassembleChunks } from '../../src/polyvault/chunker.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import type { BundleV1 } from '../../src/schemas/bundle.js';

// --- Fixtures ---

function makeBundle(): BundleV1 {
  return {
    version: '1.0',
    bundleId: 'bndl_crypto_test',
    commit: {
      commitId: 'cmt_abc123',
      parentCommitId: null,
      createdAtMs: 1730000000000,
      syncMode: 'backup',
      dedupeKey: 'sha256_dedupekey',
    },
    manifest: {
      thoughtformCount: 1,
      payloadHash: 'sha256_payload',
      compression: 'none',
      encryption: 'none',
      chunkCount: 1,
      chunkSizeMaxBytes: 1_000_000,
    },
    delta: {
      sinceUpdatedAtMsExclusive: 0,
      untilUpdatedAtMsInclusive: 1730000000000,
    },
    thoughtforms: [
      {
        schemaVersion: SCHEMA_VERSION_V1,
        id: 'tf_123',
        rawText: 'Some sensitive content that should be encrypted',
        entities: [{ id: 'e1', type: 'concept', value: 'test' }],
        relationships: [],
        contextGraph: {},
        metadata: {
          createdAtMs: 1730000000000,
          updatedAtMs: 1730000000000,
          source: 'local',
          contentHash: 'a'.repeat(64),
          redaction: { rawTextOmitted: false },
        },
      },
    ],
  };
}

function makeKey(): Uint8Array {
  return randomBytes(32);
}

// --- compress.ts ---

describe('compress / decompress', () => {
  it('mode=none passes data through unchanged', async () => {
    const data = new TextEncoder().encode('hello world');
    const compressed = await compress(data, 'none');
    expect(Buffer.from(compressed).equals(Buffer.from(data))).toBe(true);
    const decompressed = await decompress(compressed, 'none');
    expect(Buffer.from(decompressed).equals(Buffer.from(data))).toBe(true);
  });

  it('gzip roundtrip preserves data', async () => {
    const data = new TextEncoder().encode('hello world gzip roundtrip test');
    const compressed = await compress(data, 'gzip');
    expect(compressed.length).toBeGreaterThan(0);
    const decompressed = await decompress(compressed, 'gzip');
    expect(Buffer.from(decompressed).equals(Buffer.from(data))).toBe(true);
  });

  it('gzip compresses repetitive data effectively', async () => {
    const data = new Uint8Array(10_000).fill(42);
    const compressed = await compress(data, 'gzip');
    expect(compressed.length).toBeLessThan(data.length);
  });

  it('gzip handles empty data', async () => {
    const data = new Uint8Array(0);
    const compressed = await compress(data, 'gzip');
    const decompressed = await decompress(compressed, 'gzip');
    expect(decompressed.length).toBe(0);
  });
});

// --- NoopCryptoAdapter ---

describe('NoopCryptoAdapter', () => {
  it('encrypt returns plaintext unchanged with empty nonce', async () => {
    const adapter = new NoopCryptoAdapter();
    const data = new TextEncoder().encode('hello');
    const { ciphertext, nonce } = await adapter.encrypt(data, new Uint8Array(0));
    expect(Buffer.from(ciphertext).equals(Buffer.from(data))).toBe(true);
    expect(nonce.length).toBe(0);
  });

  it('decrypt returns ciphertext unchanged', async () => {
    const adapter = new NoopCryptoAdapter();
    const data = new TextEncoder().encode('hello');
    const result = await adapter.decrypt(data, new Uint8Array(0), new Uint8Array(0));
    expect(Buffer.from(result).equals(Buffer.from(data))).toBe(true);
  });

  it('mode is none', () => {
    expect(new NoopCryptoAdapter().mode).toBe('none');
  });
});

// --- AesGcmCryptoAdapter ---

describe('AesGcmCryptoAdapter', () => {
  it('encrypt+decrypt roundtrip preserves data', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const plaintext = new TextEncoder().encode('secret message for vetkeys');
    const { ciphertext, nonce } = await adapter.encrypt(plaintext, key);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length);
    expect(nonce.length).toBe(12);
    const decrypted = await adapter.decrypt(ciphertext, key, nonce);
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('ciphertext differs from plaintext', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const plaintext = new TextEncoder().encode('secret');
    const { ciphertext } = await adapter.encrypt(plaintext, key);
    expect(Buffer.from(ciphertext).equals(Buffer.from(plaintext))).toBe(false);
  });

  it('different encryptions produce different ciphertexts (random nonce)', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const plaintext = new TextEncoder().encode('same input');
    const r1 = await adapter.encrypt(plaintext, key);
    const r2 = await adapter.encrypt(plaintext, key);
    expect(Buffer.from(r1.ciphertext).equals(Buffer.from(r2.ciphertext))).toBe(
      false
    );
    expect(Buffer.from(r1.nonce).equals(Buffer.from(r2.nonce))).toBe(false);
  });

  it('wrong key fails decryption', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const wrongKey = makeKey();
    const plaintext = new TextEncoder().encode('secret');
    const { ciphertext, nonce } = await adapter.encrypt(plaintext, key);
    await expect(
      adapter.decrypt(ciphertext, wrongKey, nonce)
    ).rejects.toThrow(DecryptionError);
  });

  it('tampered ciphertext fails decryption', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const plaintext = new TextEncoder().encode('secret');
    const { ciphertext, nonce } = await adapter.encrypt(plaintext, key);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(
      adapter.decrypt(tampered, key, nonce)
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects invalid key length', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const shortKey = new Uint8Array(16);
    const plaintext = new TextEncoder().encode('hello');
    await expect(adapter.encrypt(plaintext, shortKey)).rejects.toThrow(
      DecryptionError
    );
  });

  it('rejects invalid nonce length', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const data = new Uint8Array(32);
    await expect(
      adapter.decrypt(data, key, new Uint8Array(8))
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects ciphertext too short for auth tag', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const nonce = new Uint8Array(12);
    await expect(
      adapter.decrypt(new Uint8Array(10), key, nonce)
    ).rejects.toThrow(DecryptionError);
  });

  it('handles empty plaintext', async () => {
    const adapter = new AesGcmCryptoAdapter();
    const key = makeKey();
    const plaintext = new Uint8Array(0);
    const { ciphertext, nonce } = await adapter.encrypt(plaintext, key);
    const decrypted = await adapter.decrypt(ciphertext, key, nonce);
    expect(decrypted.length).toBe(0);
  });

  it('mode is vetkeys-aes-gcm-v1', () => {
    expect(new AesGcmCryptoAdapter().mode).toBe('vetkeys-aes-gcm-v1');
  });
});

// --- createCryptoAdapter / requireEncryptionAdapter ---

describe('createCryptoAdapter', () => {
  it('creates NoopCryptoAdapter for mode=none', () => {
    const adapter = createCryptoAdapter('none');
    expect(adapter).toBeInstanceOf(NoopCryptoAdapter);
  });

  it('creates AesGcmCryptoAdapter for mode=vetkeys-aes-gcm-v1', () => {
    const adapter = createCryptoAdapter('vetkeys-aes-gcm-v1');
    expect(adapter).toBeInstanceOf(AesGcmCryptoAdapter);
  });
});

describe('requireEncryptionAdapter', () => {
  it('returns adapter when encryption not required and mode=none', () => {
    const adapter = requireEncryptionAdapter('none', false);
    expect(adapter).toBeInstanceOf(NoopCryptoAdapter);
  });

  it('fails closed when encryption required but mode=none (AC)', () => {
    expect(() => requireEncryptionAdapter('none', true)).toThrow(
      EncryptionRequiredError
    );
  });

  it('returns adapter when encryption required and mode=vetkeys', () => {
    const adapter = requireEncryptionAdapter('vetkeys-aes-gcm-v1', true);
    expect(adapter).toBeInstanceOf(AesGcmCryptoAdapter);
  });
});

// --- End-to-end: serialize -> compress -> encrypt -> decrypt -> decompress -> deserialize ---

describe('End-to-end: compress + encrypt pipeline', () => {
  it('encrypt=none compress=none roundtrip (AC: encrypt off path works)', async () => {
    const bundle = makeBundle();
    const { bytes } = serializeBundle(bundle);
    const compressed = await compress(bytes, 'none');
    const adapter = createCryptoAdapter('none');
    const { ciphertext, nonce } = await adapter.encrypt(compressed, new Uint8Array(0));
    const decrypted = await adapter.decrypt(ciphertext, new Uint8Array(0), nonce);
    const decompressed = await decompress(decrypted, 'none');
    expect(Buffer.from(decompressed).equals(Buffer.from(bytes))).toBe(true);
  });

  it('gzip + AES-GCM full roundtrip (AC: decrypt+inflate roundtrip passes)', async () => {
    const bundle = makeBundle();
    const { bytes } = serializeBundle(bundle);
    const key = makeKey();

    // Compress
    const compressed = await compress(bytes, 'gzip');
    expect(compressed.length).toBeLessThan(bytes.length);

    // Encrypt
    const adapter = createCryptoAdapter('vetkeys-aes-gcm-v1');
    const { ciphertext, nonce } = await adapter.encrypt(compressed, key);

    // Chunk
    const chunks = chunkPayload(ciphertext, { maxChunkSize: 500 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Reassemble
    const reassembled = reassembleChunks(chunks);

    // Decrypt
    const decrypted = await adapter.decrypt(reassembled, key, nonce);

    // Decompress
    const decompressed = await decompress(decrypted, 'gzip');

    // Verify identical to original
    expect(Buffer.from(decompressed).equals(Buffer.from(bytes))).toBe(true);
  });

  it('large bundle compress+encrypt+chunk roundtrip', async () => {
    const manyForms = Array.from({ length: 200 }, (_, i) => ({
      schemaVersion: SCHEMA_VERSION_V1,
      id: `tf_${i}`,
      rawText: `Concept ${i}: ${'x'.repeat(500)}`,
      entities: [{ id: `e_${i}`, type: 'concept', value: `value_${i}` }],
      relationships: [],
      contextGraph: {},
      metadata: {
        createdAtMs: 1730000000000 + i,
        updatedAtMs: 1730000000000 + i,
        source: 'test',
        contentHash: 'c'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    }));
    const bundle: BundleV1 = {
      ...makeBundle(),
      thoughtforms: manyForms,
      manifest: {
        ...makeBundle().manifest,
        thoughtformCount: manyForms.length,
        compression: 'gzip',
        encryption: 'vetkeys-aes-gcm-v1',
      },
    };

    const { bytes } = serializeBundle(bundle);
    const key = makeKey();

    const compressed = await compress(bytes, 'gzip');
    const adapter = createCryptoAdapter('vetkeys-aes-gcm-v1');
    const { ciphertext, nonce } = await adapter.encrypt(compressed, key);
    const chunks = chunkPayload(ciphertext);
    const reassembled = reassembleChunks(chunks);
    const decrypted = await adapter.decrypt(reassembled, key, nonce);
    const decompressed = await decompress(decrypted, 'gzip');

    expect(Buffer.from(decompressed).equals(Buffer.from(bytes))).toBe(true);
  });
});
