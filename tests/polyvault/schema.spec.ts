import { describe, it, expect } from 'vitest';
import {
  parseThoughtForm,
  parseBundle,
  parseChunk,
  parseThoughtFormOrThrow,
  parseBundleOrThrow,
  parseChunkOrThrow,
} from '../../src/lib/polyvault/validate.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';
import type { BundleV1, Chunk } from '../../src/schemas/bundle.js';

// --- Shared fixtures ---
// These fixtures match the canonical shapes used across both repos.

function makeThoughtForm(overrides: Partial<ThoughtFormV1> = {}): ThoughtFormV1 {
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    id: 'tf_fixture_01',
    rawText: 'hello world',
    entities: [
      { id: 'e_1', type: 'concept', value: 'hello' },
    ],
    relationships: [
      { id: 'r_1', type: 'relates_to', from: 'e_1', to: 'e_2' },
    ],
    contextGraph: { source: 'test' },
    metadata: {
      createdAtMs: 1730000000000,
      updatedAtMs: 1730000000000,
      source: 'test-fixture',
      contentHash: 'a'.repeat(64),
      redaction: { rawTextOmitted: false },
    },
    ...overrides,
  };
}

function makeBundle(overrides: Partial<BundleV1> = {}): BundleV1 {
  return {
    version: '1.0',
    bundleId: 'bndl_fixture_01',
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
    thoughtforms: [makeThoughtForm()],
    ...overrides,
  };
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    version: '1.0',
    bundleId: 'bndl_fixture_01',
    commitId: 'cmt_abc123',
    chunkIndex: 0,
    chunkCount: 1,
    chunkHash: 'deadbeef'.repeat(8),
    payloadEncoding: 'base64' as const,
    payload: 'SGVsbG8gV29ybGQ=',
    compressed: false,
    encrypted: false,
    ...overrides,
  };
}

// --- ThoughtForm parsing ---

describe('parseThoughtForm', () => {
  it('validates a well-formed fixture', () => {
    const result = parseThoughtForm(makeThoughtForm());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('tf_fixture_01');
      expect(result.data.schemaVersion).toBe(SCHEMA_VERSION_V1);
    }
  });

  it('preserves unknown fields without data loss (AC: passthrough)', () => {
    const input = {
      ...makeThoughtForm(),
      futureField: 'from-v2',
      nested: { deep: true },
    };
    const result = parseThoughtForm(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['futureField']).toBe('from-v2');
      expect((result.data as Record<string, unknown>)['nested']).toEqual({ deep: true });
    }
  });

  it('preserves unknown fields in nested metadata', () => {
    const tf = makeThoughtForm();
    (tf.metadata as Record<string, unknown>)['futureMetaField'] = 42;
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data.metadata as Record<string, unknown>)['futureMetaField']).toBe(42);
    }
  });

  it('preserves unknown fields in entities', () => {
    const tf = makeThoughtForm();
    (tf.entities[0] as Record<string, unknown>)['provenance'] = 'nlp-v3';
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data.entities[0] as Record<string, unknown>)['provenance']).toBe('nlp-v3');
    }
  });

  it('rejects invalid timestamps (AC: runtime validation)', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        metadata: {
          createdAtMs: -1,
          updatedAtMs: 1730000000000,
          source: 'test',
          contentHash: 'a'.repeat(64),
          redaction: { rawTextOmitted: false },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('createdAtMs'))).toBe(true);
    }
  });

  it('rejects float timestamps', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        metadata: {
          createdAtMs: 1730000000000.5,
          updatedAtMs: 1730000000000,
          source: 'test',
          contentHash: 'a'.repeat(64),
          redaction: { rawTextOmitted: false },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing required id field', () => {
    const input = makeThoughtForm();
    delete (input as Record<string, unknown>)['id'];
    const result = parseThoughtForm(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'id')).toBe(true);
    }
  });

  it('rejects empty id', () => {
    const result = parseThoughtForm(makeThoughtForm({ id: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects empty source in metadata', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        metadata: {
          createdAtMs: 1730000000000,
          updatedAtMs: 1730000000000,
          source: '',
          contentHash: 'a'.repeat(64),
          redaction: { rawTextOmitted: false },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects short contentHash', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        metadata: {
          createdAtMs: 1730000000000,
          updatedAtMs: 1730000000000,
          source: 'test',
          contentHash: 'short',
          redaction: { rawTextOmitted: false },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('allows optional rawText to be omitted', () => {
    const tf = makeThoughtForm();
    delete (tf as Record<string, unknown>)['rawText'];
    const result = parseThoughtForm(tf);
    expect(result.ok).toBe(true);
  });

  it('allows optional fields in entities', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        entities: [{ id: 'e_1', type: 'concept', value: 'hello' }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('validates entity confidence range', () => {
    const result = parseThoughtForm(
      makeThoughtForm({
        entities: [{ id: 'e_1', type: 'concept', value: 'hello', confidence: 1.5 }],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('parseThoughtFormOrThrow', () => {
  it('returns data for valid input', () => {
    const data = parseThoughtFormOrThrow(makeThoughtForm());
    expect(data.id).toBe('tf_fixture_01');
  });

  it('throws ZodError for invalid input', () => {
    expect(() => parseThoughtFormOrThrow({})).toThrow();
  });
});

// --- Bundle parsing ---

describe('parseBundle', () => {
  it('validates a well-formed bundle fixture (AC: shared fixtures)', () => {
    const result = parseBundle(makeBundle());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bundleId).toBe('bndl_fixture_01');
      expect(result.data.thoughtforms).toHaveLength(1);
    }
  });

  it('preserves unknown fields at bundle level', () => {
    const input = { ...makeBundle(), experimentalFlag: true };
    const result = parseBundle(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['experimentalFlag']).toBe(true);
    }
  });

  it('preserves unknown fields in commit', () => {
    const bundle = makeBundle();
    (bundle.commit as Record<string, unknown>)['signatureV2'] = 'sig_abc';
    const result = parseBundle(bundle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data.commit as Record<string, unknown>)['signatureV2']).toBe('sig_abc');
    }
  });

  it('preserves unknown fields in manifest', () => {
    const bundle = makeBundle();
    (bundle.manifest as Record<string, unknown>)['compressionLevel'] = 9;
    const result = parseBundle(bundle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data.manifest as Record<string, unknown>)['compressionLevel']).toBe(9);
    }
  });

  it('rejects invalid syncMode', () => {
    const result = parseBundle(
      makeBundle({
        commit: {
          commitId: 'cmt_1',
          parentCommitId: null,
          createdAtMs: 1730000000000,
          syncMode: 'invalid' as 'backup',
          dedupeKey: 'key',
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects chunkSizeMaxBytes exceeding 1_000_000', () => {
    const result = parseBundle(
      makeBundle({
        manifest: {
          thoughtformCount: 1,
          payloadHash: 'hash',
          compression: 'none',
          encryption: 'none',
          chunkCount: 1,
          chunkSizeMaxBytes: 1_000_001,
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects zero chunkCount', () => {
    const result = parseBundle(
      makeBundle({
        manifest: {
          thoughtformCount: 1,
          payloadHash: 'hash',
          compression: 'none',
          encryption: 'none',
          chunkCount: 0,
          chunkSizeMaxBytes: 1_000_000,
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects completely empty input', () => {
    const result = parseBundle({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('validates nested thoughtforms within bundle', () => {
    const result = parseBundle(
      makeBundle({
        thoughtforms: [
          {
            ...makeThoughtForm(),
            metadata: {
              createdAtMs: -1,
              updatedAtMs: 0,
              source: 'bad',
              contentHash: 'a'.repeat(64),
              redaction: { rawTextOmitted: false },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('parseBundleOrThrow', () => {
  it('returns data for valid input', () => {
    const data = parseBundleOrThrow(makeBundle());
    expect(data.bundleId).toBe('bndl_fixture_01');
  });

  it('throws for invalid input', () => {
    expect(() => parseBundleOrThrow({})).toThrow();
  });
});

// --- Chunk parsing ---

describe('parseChunk', () => {
  it('validates a well-formed chunk', () => {
    const result = parseChunk(makeChunk());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chunkIndex).toBe(0);
      expect(result.data.chunkCount).toBe(1);
    }
  });

  it('preserves unknown fields in chunk', () => {
    const input = { ...makeChunk(), replicationRegion: 'us-east-1' };
    const result = parseChunk(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['replicationRegion']).toBe('us-east-1');
    }
  });

  it('rejects negative chunkIndex', () => {
    const result = parseChunk(makeChunk({ chunkIndex: -1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects invalid payloadEncoding', () => {
    const result = parseChunk(makeChunk({ payloadEncoding: 'hex' as 'base64' }));
    expect(result.ok).toBe(false);
  });
});

describe('parseChunkOrThrow', () => {
  it('returns data for valid input', () => {
    const data = parseChunkOrThrow(makeChunk());
    expect(data.bundleId).toBe('bndl_fixture_01');
  });

  it('throws for invalid input', () => {
    expect(() => parseChunkOrThrow({})).toThrow();
  });
});

// --- Cross-schema validation: fixtures validate identically (AC) ---

describe('Shared fixture parity', () => {
  it('ThoughtForm fixture validates through both parse and parseOrThrow', () => {
    const fixture = makeThoughtForm();
    const safe = parseThoughtForm(fixture);
    const thrown = parseThoughtFormOrThrow(fixture);
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      expect(safe.data).toEqual(thrown);
    }
  });

  it('Bundle fixture validates through both parse and parseOrThrow', () => {
    const fixture = makeBundle();
    const safe = parseBundle(fixture);
    const thrown = parseBundleOrThrow(fixture);
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      expect(safe.data).toEqual(thrown);
    }
  });

  it('roundtrip: JSON.parse(JSON.stringify(fixture)) validates identically', () => {
    const fixture = makeBundle();
    const serialized = JSON.parse(JSON.stringify(fixture));
    const result = parseBundle(serialized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(fixture);
    }
  });

  it('unknown fields survive JSON roundtrip without data loss (AC)', () => {
    const fixture = {
      ...makeBundle(),
      futureTopLevel: { key: 'value' },
    };
    (fixture.commit as Record<string, unknown>)['futureCommitField'] = [1, 2, 3];
    (fixture.manifest as Record<string, unknown>)['futureManifestField'] = null;

    const serialized = JSON.parse(JSON.stringify(fixture));
    const result = parseBundle(serialized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['futureTopLevel']).toEqual({ key: 'value' });
      expect((result.data.commit as Record<string, unknown>)['futureCommitField']).toEqual([1, 2, 3]);
      expect((result.data.manifest as Record<string, unknown>)['futureManifestField']).toBeNull();
    }
  });
});

// --- Error structure ---

describe('ValidationError structure', () => {
  it('returns path, message, and code for each error', () => {
    const result = parseThoughtForm({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const err of result.errors) {
        expect(err).toHaveProperty('path');
        expect(err).toHaveProperty('message');
        expect(err).toHaveProperty('code');
        expect(typeof err.path).toBe('string');
        expect(typeof err.message).toBe('string');
        expect(typeof err.code).toBe('string');
      }
    }
  });

  it('returns multiple errors for multiple invalid fields', () => {
    const result = parseBundle({
      version: 123,
      bundleId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});
