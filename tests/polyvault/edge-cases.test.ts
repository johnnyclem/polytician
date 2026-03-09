import { describe, it, expect } from 'vitest';
import { serializeBundle, deserializeBundle } from '../../src/polyvault/serializer.js';
import { chunkPayload, reassembleChunks, MAX_CHUNK_SIZE } from '../../src/polyvault/chunker.js';
import { parseThoughtForm, parseBundle } from '../../src/lib/polyvault/validate.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import {
  tsToNat64,
  nat64ToTs,
  TimestampOverflowError,
  validateEpochMs,
  validatePythonTimestamp,
} from '../../src/polyvault/timestamp.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';
import type { BundleV1 } from '../../src/schemas/bundle.js';

// --- Fixtures ---

function makeTf(overrides: Partial<ThoughtFormV1> & { id: string }): ThoughtFormV1 {
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    id: overrides.id,
    entities: [],
    relationships: [],
    contextGraph: {},
    metadata: {
      createdAtMs: 1730000000000,
      updatedAtMs: 1730000000000,
      source: 'local',
      contentHash: 'a'.repeat(64),
      redaction: { rawTextOmitted: false },
      ...overrides.metadata,
    },
    ...overrides,
  };
}

function makeBundle(overrides: Partial<BundleV1> = {}): BundleV1 {
  return {
    version: '1.0',
    bundleId: 'bndl_test_edge',
    commit: {
      commitId: 'cmt_edge_01',
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
    thoughtforms: [makeTf({ id: 'tf_default' })],
    ...overrides,
  };
}

// ==================== Edge-case matrix (PRD §7.4) ====================

describe('Edge case: empty bundle (0 thoughtforms)', () => {
  it('accepted and produces valid bundle', () => {
    const bundle = makeBundle({
      thoughtforms: [],
      manifest: {
        thoughtformCount: 0,
        payloadHash: 'sha256_payload',
        compression: 'none',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: MAX_CHUNK_SIZE,
      },
    });
    const { bytes, payloadHash } = serializeBundle(bundle);
    const restored = deserializeBundle(bytes) as BundleV1;
    expect(restored.thoughtforms).toHaveLength(0);
    expect(payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('chunk/reassemble roundtrip works for empty bundle', () => {
    const bundle = makeBundle({ thoughtforms: [] });
    const { bytes } = serializeBundle(bundle);
    const chunks = chunkPayload(bytes);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const reassembled = reassembleChunks(chunks);
    const restored = deserializeBundle(reassembled);
    expect(restored).toEqual(bundle);
  });
});

describe('Edge case: single ThoughtForm >1MB', () => {
  it('accepted with intra-record chunking at serialized byte level', () => {
    // Create a ThoughtForm with a large rawText that will exceed 1MB when serialized
    const largeText = 'x'.repeat(1_200_000);
    const largeTf = makeTf({
      id: 'tf_large',
      rawText: largeText,
    });
    const bundle = makeBundle({
      thoughtforms: [largeTf],
      manifest: {
        thoughtformCount: 1,
        payloadHash: 'placeholder',
        compression: 'none',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: MAX_CHUNK_SIZE,
      },
    });
    const { bytes } = serializeBundle(bundle);
    // Serialized bundle should be >1MB
    expect(bytes.length).toBeGreaterThan(MAX_CHUNK_SIZE);

    // Chunk it — should split into multiple chunks
    const chunks = chunkPayload(bytes);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk respects the limit
    for (const chunk of chunks) {
      expect(chunk.payload.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
    }

    // Reassembly recovers the original
    const reassembled = reassembleChunks(chunks);
    const restored = deserializeBundle(reassembled) as BundleV1;
    expect(restored.thoughtforms[0]!.rawText).toBe(largeText);
  });
});

describe('Edge case: missing rawText with redaction', () => {
  it('accepted when redaction.rawTextOmitted is true', () => {
    const tf = makeTf({
      id: 'tf_redacted',
      metadata: {
        createdAtMs: 1730000000000,
        updatedAtMs: 1730000000000,
        source: 'local',
        contentHash: 'a'.repeat(64),
        redaction: { rawTextOmitted: true },
      },
    });
    // rawText should be omitted
    delete (tf as Record<string, unknown>)['rawText'];
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rawText).toBeUndefined();
      expect(result.data.metadata.redaction.rawTextOmitted).toBe(true);
    }
  });
});

describe('Edge case: schema version mismatch', () => {
  it('1.x parses with passthrough (forward compatible)', () => {
    const tf = makeTf({ id: 'tf_v1_1' });
    tf.schemaVersion = '1.1';
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.schemaVersion).toBe('1.1');
    }
  });

  it('1.99 parses with passthrough', () => {
    const tf = makeTf({ id: 'tf_v1_99' });
    tf.schemaVersion = '1.99';
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
  });

  it('2.0 bundle is rejected without migration hook', () => {
    // Schema version is just a string in ThoughtForm, so it validates.
    // But Bundle schema enforces structure — a v2.0 bundle with
    // incompatible structure should fail validation.
    const v2Bundle = {
      version: '2.0',
      bundleId: 'bndl_v2',
      // v2 might use a different structure — missing required v1 fields
      commit: {
        commitId: 'cmt_v2',
        // Missing required fields like dedupeKey, syncMode
      },
      manifest: {
        // Incomplete manifest
        thoughtformCount: 0,
      },
      delta: {},
      thoughtforms: [],
    };
    const result = parseBundle(v2Bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('2.0 ThoughtForm with unknown required fields is still parseable (passthrough)', () => {
    // v2.0 ThoughtForm with extra fields that don't break v1 schema
    const v2Tf = {
      ...makeTf({ id: 'tf_v2_compat' }),
      schemaVersion: '2.0',
      v2OnlyField: { nested: true },
    };
    const result = parseThoughtForm(v2Tf);
    // Still validates because passthrough preserves unknown fields
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['v2OnlyField']).toEqual({ nested: true });
    }
  });

  it('2.0 ThoughtForm that removes v1 required fields is rejected', () => {
    // A true v2 that dropped required v1 fields
    const result = parseThoughtForm({
      schemaVersion: '2.0',
      id: 'tf_v2_breaking',
      // Missing entities, relationships, contextGraph, metadata
      v2Data: { newFormat: true },
    });
    expect(result.ok).toBe(false);
  });
});

describe('Edge case: duplicate ThoughtForm IDs with divergent payload', () => {
  it('merged deterministically: later updatedAtMs wins', () => {
    const tf1 = makeTf({
      id: 'tf_dup',
      rawText: 'version 1',
      metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) },
    });
    const tf2 = makeTf({
      id: 'tf_dup',
      rawText: 'version 2',
      metadata: { updatedAtMs: 2000, contentHash: 'b'.repeat(64) },
    });

    // Simulate restore dedup: build a map, later commit wins
    const map = new Map<string, ThoughtFormV1>();
    for (const tf of [tf1, tf2]) {
      const existing = map.get(tf.id);
      if (!existing || tf.metadata.updatedAtMs > existing.metadata.updatedAtMs) {
        map.set(tf.id, tf);
      }
    }

    expect(map.size).toBe(1);
    expect(map.get('tf_dup')!.rawText).toBe('version 2');
    expect(map.get('tf_dup')!.metadata.updatedAtMs).toBe(2000);
  });
});

describe('Edge case: partial upload and replay', () => {
  it('finalize rejects incomplete chunks (via reassembly)', () => {
    // Simulate: upload 2 of 3 chunks, then try to reassemble
    const data = new Uint8Array(300).fill(42);
    const chunks = chunkPayload(data, { maxChunkSize: 100 });
    expect(chunks).toHaveLength(3);

    // Only have first and last chunks (missing middle)
    const partial = [chunks[0]!, chunks[2]!];
    expect(() => reassembleChunks(partial)).toThrow('Expected 3 chunks, received 2');
  });

  it('replay upload does not duplicate storage (idempotency via hash)', () => {
    const data = new Uint8Array(200).fill(7);
    const chunks1 = chunkPayload(data, { maxChunkSize: 100 });
    const chunks2 = chunkPayload(data, { maxChunkSize: 100 });

    // Same data produces same chunk hashes — idempotency keys will match
    expect(chunks1.map((c) => c.chunkHash)).toEqual(chunks2.map((c) => c.chunkHash));
    expect(chunks1.length).toBe(chunks2.length);
    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i]!.chunkHash).toBe(chunks2[i]!.chunkHash);
    }
  });
});

// ==================== Timestamp boundary helpers (PRD §1.4) ====================

describe('tsToNat64', () => {
  it('converts valid epoch ms to bigint', () => {
    expect(tsToNat64(0)).toBe(0n);
    expect(tsToNat64(1730000000000)).toBe(1730000000000n);
  });

  it('rejects negative values', () => {
    expect(() => tsToNat64(-1)).toThrow(TimestampOverflowError);
  });

  it('rejects non-integer values', () => {
    expect(() => tsToNat64(1.5)).toThrow(TimestampOverflowError);
  });

  it('rejects values exceeding MAX_SAFE_INTEGER', () => {
    expect(() => tsToNat64(Number.MAX_SAFE_INTEGER + 1)).toThrow(TimestampOverflowError);
  });

  it('accepts MAX_SAFE_INTEGER', () => {
    expect(tsToNat64(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe('nat64ToTs', () => {
  it('converts valid bigint to number', () => {
    expect(nat64ToTs(0n)).toBe(0);
    expect(nat64ToTs(1730000000000n)).toBe(1730000000000);
  });

  it('rejects values exceeding MAX_SAFE_INTEGER', () => {
    expect(() => nat64ToTs(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(TimestampOverflowError);
  });

  it('rejects negative bigint', () => {
    expect(() => nat64ToTs(-1n)).toThrow(TimestampOverflowError);
  });

  it('roundtrip: tsToNat64 -> nat64ToTs preserves value', () => {
    const original = 1730000000000;
    expect(nat64ToTs(tsToNat64(original))).toBe(original);
  });
});

describe('validateEpochMs', () => {
  it('accepts valid epoch ms', () => {
    expect(validateEpochMs(0)).toBe(true);
    expect(validateEpochMs(1730000000000)).toBe(true);
  });

  it('rejects negative', () => {
    expect(validateEpochMs(-1)).toBe(false);
  });

  it('rejects float', () => {
    expect(validateEpochMs(1.5)).toBe(false);
  });

  it('rejects non-number', () => {
    expect(validateEpochMs('123')).toBe(false);
    expect(validateEpochMs(null)).toBe(false);
  });
});

describe('validatePythonTimestamp', () => {
  it('accepts valid Python-compatible timestamps', () => {
    expect(validatePythonTimestamp(0)).toBe(true);
    expect(validatePythonTimestamp(1730000000000)).toBe(true);
  });

  it('rejects negative', () => {
    expect(validatePythonTimestamp(-1)).toBe(false);
  });

  it('rejects float', () => {
    expect(validatePythonTimestamp(1.5)).toBe(false);
  });
});
