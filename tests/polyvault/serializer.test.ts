import { describe, it, expect } from 'vitest';
import { sha256, sha256String } from '../../src/polyvault/hash.js';
import {
  serializeBundle,
  deserializeBundle,
  computeCommitHash,
} from '../../src/polyvault/serializer.js';
import {
  chunkPayload,
  reassembleChunks,
  ChunkIntegrityError,
  ChunkReassemblyError,
  MAX_CHUNK_SIZE,
} from '../../src/polyvault/chunker.js';
import type { BundleV1 } from '../../src/schemas/bundle.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';

// --- Fixtures ---

function makeBundle(overrides: Partial<BundleV1> = {}): BundleV1 {
  return {
    version: '1.0',
    bundleId: 'bndl_test_01',
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
      chunkSizeMaxBytes: MAX_CHUNK_SIZE,
    },
    delta: {
      sinceUpdatedAtMsExclusive: 0,
      untilUpdatedAtMsInclusive: 1730000000000,
    },
    thoughtforms: [
      {
        schemaVersion: SCHEMA_VERSION_V1,
        id: 'tf_123',
        entities: [],
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
    ...overrides,
  };
}

// --- hash.ts ---

describe('sha256 / sha256String', () => {
  it('produces consistent hex output for same bytes', () => {
    const data = new TextEncoder().encode('hello world');
    expect(sha256(data)).toBe(sha256(data));
    expect(sha256(data)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sha256String matches sha256 on the same UTF-8 input', () => {
    const text = 'hello world';
    const fromString = sha256String(text);
    const fromBytes = sha256(new TextEncoder().encode(text));
    expect(fromString).toBe(fromBytes);
  });

  it('different inputs produce different hashes', () => {
    expect(sha256String('a')).not.toBe(sha256String('b'));
  });
});

// --- serializer.ts ---

describe('serializeBundle', () => {
  it('produces byte-identical output for same input (AC: deterministic)', () => {
    const bundle = makeBundle();
    const r1 = serializeBundle(bundle);
    const r2 = serializeBundle(bundle);
    expect(Buffer.from(r1.bytes).equals(Buffer.from(r2.bytes))).toBe(true);
    expect(r1.payloadHash).toBe(r2.payloadHash);
  });

  it('produces same output regardless of key insertion order', () => {
    const a: Record<string, unknown> = { z: 1, a: 2, m: 3 };
    const b: Record<string, unknown> = { a: 2, m: 3, z: 1 };
    // Build bundles with different key orders in extensions
    const bundle1 = makeBundle({ extensions: a });
    const bundle2 = makeBundle({ extensions: b });
    const r1 = serializeBundle(bundle1);
    const r2 = serializeBundle(bundle2);
    expect(r1.payloadHash).toBe(r2.payloadHash);
  });

  it('produces same commit hash for identical bundles (AC: same commit hash)', () => {
    const bundle = makeBundle();
    const hash1 = computeCommitHash(bundle);
    const hash2 = computeCommitHash(bundle);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different commit hash for different bundles', () => {
    const bundle1 = makeBundle({ bundleId: 'bndl_1' });
    const bundle2 = makeBundle({ bundleId: 'bndl_2' });
    expect(computeCommitHash(bundle1)).not.toBe(computeCommitHash(bundle2));
  });

  it('roundtrip: serialize then deserialize preserves data', () => {
    const bundle = makeBundle();
    const { bytes } = serializeBundle(bundle);
    const restored = deserializeBundle(bytes);
    expect(restored).toEqual(bundle);
  });

  it('payloadHash matches sha256 of the JSON string', () => {
    const bundle = makeBundle();
    const { bytes, payloadHash } = serializeBundle(bundle);
    const json = new TextDecoder().decode(bytes);
    expect(payloadHash).toBe(sha256String(json));
  });
});

// --- chunker.ts ---

describe('chunkPayload', () => {
  it('single chunk for small payload', () => {
    const data = new TextEncoder().encode('small');
    const chunks = chunkPayload(data);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.chunkCount).toBe(1);
    expect(chunks[0]!.payload).toEqual(data);
  });

  it('chunk size never exceeds MAX_CHUNK_SIZE (AC)', () => {
    const size = MAX_CHUNK_SIZE * 2 + 100;
    const data = new Uint8Array(size).fill(42);
    const chunks = chunkPayload(data);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.payload.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
    }
  });

  it('respects custom maxChunkSize', () => {
    const data = new Uint8Array(300).fill(1);
    const chunks = chunkPayload(data, { maxChunkSize: 100 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.payload.length).toBe(100);
    expect(chunks[1]!.payload.length).toBe(100);
    expect(chunks[2]!.payload.length).toBe(100);
  });

  it('throws if maxChunkSize exceeds MAX_CHUNK_SIZE', () => {
    const data = new Uint8Array(10);
    expect(() => chunkPayload(data, { maxChunkSize: MAX_CHUNK_SIZE + 1 })).toThrow();
  });

  it('throws if maxChunkSize is zero', () => {
    const data = new Uint8Array(10);
    expect(() => chunkPayload(data, { maxChunkSize: 0 })).toThrow();
  });

  it('produces at least one chunk for empty data', () => {
    const data = new Uint8Array(0);
    const chunks = chunkPayload(data);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.payload.length).toBe(0);
  });

  it('chunk hashes are deterministic', () => {
    const data = new Uint8Array(500).fill(99);
    const c1 = chunkPayload(data, { maxChunkSize: 200 });
    const c2 = chunkPayload(data, { maxChunkSize: 200 });
    expect(c1.map((c) => c.chunkHash)).toEqual(c2.map((c) => c.chunkHash));
  });
});

describe('reassembleChunks', () => {
  it('reassembles chunked data correctly', () => {
    const original = new Uint8Array(2500).fill(7);
    const chunks = chunkPayload(original, { maxChunkSize: 1000 });
    const reassembled = reassembleChunks(chunks);
    expect(Buffer.from(reassembled).equals(Buffer.from(original))).toBe(true);
  });

  it('reassembles chunks in any order', () => {
    const original = new Uint8Array(2500).fill(7);
    const chunks = chunkPayload(original, { maxChunkSize: 1000 });
    const reversed = [...chunks].reverse();
    const reassembled = reassembleChunks(reversed);
    expect(Buffer.from(reassembled).equals(Buffer.from(original))).toBe(true);
  });

  it('detects hash mismatch and fails deterministically (AC)', () => {
    const original = new Uint8Array(200).fill(3);
    const chunks = chunkPayload(original, { maxChunkSize: 100 });
    // Corrupt one chunk's payload
    chunks[0]!.payload[0] = 255;
    expect(() => reassembleChunks(chunks)).toThrow(ChunkIntegrityError);
  });

  it('ChunkIntegrityError contains expected fields', () => {
    const original = new Uint8Array(100).fill(5);
    const chunks = chunkPayload(original, { maxChunkSize: 100 });
    chunks[0]!.payload[0] = 0;
    try {
      reassembleChunks(chunks);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ChunkIntegrityError);
      const err = e as ChunkIntegrityError;
      expect(err.chunkIndex).toBe(0);
      expect(err.expected).toMatch(/^[a-f0-9]{64}$/);
      expect(err.actual).toMatch(/^[a-f0-9]{64}$/);
      expect(err.expected).not.toBe(err.actual);
    }
  });

  it('throws on empty chunks array', () => {
    expect(() => reassembleChunks([])).toThrow(ChunkReassemblyError);
  });

  it('throws on missing chunks', () => {
    const original = new Uint8Array(300).fill(1);
    const chunks = chunkPayload(original, { maxChunkSize: 100 });
    // Remove middle chunk
    const incomplete = [chunks[0]!, chunks[2]!];
    expect(() => reassembleChunks(incomplete)).toThrow(ChunkReassemblyError);
  });

  it('throws on inconsistent chunkCount', () => {
    const original = new Uint8Array(200).fill(1);
    const chunks = chunkPayload(original, { maxChunkSize: 100 });
    // Tamper with chunkCount
    const tampered = chunks.map((c, i) => (i === 1 ? { ...c, chunkCount: 5 } : c));
    expect(() => reassembleChunks(tampered)).toThrow(ChunkReassemblyError);
  });
});

// --- End-to-end: serialize -> chunk -> reassemble -> deserialize ---

describe('End-to-end roundtrip', () => {
  it('full pipeline: serialize -> chunk -> reassemble -> deserialize', () => {
    const bundle = makeBundle();
    const { bytes, payloadHash } = serializeBundle(bundle);
    const chunks = chunkPayload(bytes, { maxChunkSize: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = reassembleChunks(chunks);
    const restored = deserializeBundle(reassembled);
    expect(restored).toEqual(bundle);
    // Verify payload hash is stable
    const reserialize = serializeBundle(restored as BundleV1);
    expect(reserialize.payloadHash).toBe(payloadHash);
  });

  it('large bundle stays within chunk size limits', () => {
    const manyForms = Array.from({ length: 500 }, (_, i) => ({
      schemaVersion: SCHEMA_VERSION_V1,
      id: `tf_${i}`,
      entities: [{ id: `e_${i}`, type: 'concept', value: `value_${i}_${'x'.repeat(200)}` }],
      relationships: [],
      contextGraph: {},
      metadata: {
        createdAtMs: 1730000000000 + i,
        updatedAtMs: 1730000000000 + i,
        source: 'test',
        contentHash: 'b'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    }));
    const bundle = makeBundle({
      thoughtforms: manyForms,
      manifest: {
        thoughtformCount: manyForms.length,
        payloadHash: 'placeholder',
        compression: 'none',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: MAX_CHUNK_SIZE,
      },
    });
    const { bytes } = serializeBundle(bundle);
    const chunks = chunkPayload(bytes);
    for (const chunk of chunks) {
      expect(chunk.payload.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
    }
    const reassembled = reassembleChunks(chunks);
    expect(Buffer.from(reassembled).equals(Buffer.from(bytes))).toBe(true);
  });
});
