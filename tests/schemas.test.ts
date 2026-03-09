import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION_V1,
  ThoughtFormV1Schema,
  ThoughtMetadataV1Schema,
  EntityV1Schema,
  RelationshipV1Schema,
  BundleV1Schema,
  ChunkSchema,
  CommitSchema,
  ManifestSchema,
  DeltaSchema,
  RedactionSchema,
} from '../src/schemas/index.js';

// --- Fixtures ---

function validMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAtMs: 1730000000000,
    updatedAtMs: 1730000000000,
    source: 'local',
    contentHash: 'a'.repeat(64),
    redaction: { rawTextOmitted: false },
    ...overrides,
  };
}

function validThoughtForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    id: 'tf_123',
    entities: [],
    relationships: [],
    contextGraph: {},
    metadata: validMetadata(),
    ...overrides,
  };
}

function validBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    bundleId: 'bndl_01J',
    commit: {
      commitId: 'cmt_abc123',
      parentCommitId: null,
      authorPrincipal: 'aaaaa-bbb',
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
    thoughtforms: [validThoughtForm()],
    ...overrides,
  };
}

// --- ThoughtForm v1 schema ---

describe('ThoughtFormV1Schema', () => {
  it('parses a valid minimal ThoughtForm', () => {
    const result = ThoughtFormV1Schema.safeParse(validThoughtForm());
    expect(result.success).toBe(true);
  });

  it('parses a ThoughtForm with optional rawText', () => {
    const result = ThoughtFormV1Schema.safeParse(validThoughtForm({ rawText: 'hello world' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rawText).toBe('hello world');
    }
  });

  it('parses a ThoughtForm with extensions', () => {
    const result = ThoughtFormV1Schema.safeParse(
      validThoughtForm({ extensions: { 'com.example': { foo: 1 } } })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extensions).toEqual({ 'com.example': { foo: 1 } });
    }
  });

  it('rejects missing required fields', () => {
    const result = ThoughtFormV1Schema.safeParse({ id: 'tf_1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty id', () => {
    const result = ThoughtFormV1Schema.safeParse(validThoughtForm({ id: '' }));
    expect(result.success).toBe(false);
  });
});

// --- Timestamp validation (AC: invalid timestamps rejected) ---

describe('Timestamp validation', () => {
  it('rejects negative createdAtMs', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ createdAtMs: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative updatedAtMs', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ updatedAtMs: -100 }));
    expect(result.success).toBe(false);
  });

  it('rejects fractional timestamps', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ createdAtMs: 123.456 }));
    expect(result.success).toBe(false);
  });

  it('rejects string timestamps', () => {
    const result = ThoughtMetadataV1Schema.safeParse(
      validMetadata({ createdAtMs: '2024-01-01T00:00:00Z' })
    );
    expect(result.success).toBe(false);
  });

  it('accepts zero timestamp', () => {
    const result = ThoughtMetadataV1Schema.safeParse(
      validMetadata({ createdAtMs: 0, updatedAtMs: 0 })
    );
    expect(result.success).toBe(true);
  });

  it('accepts large valid epoch ms timestamp', () => {
    const result = ThoughtMetadataV1Schema.safeParse(
      validMetadata({ createdAtMs: 4102444800000 })
    );
    expect(result.success).toBe(true);
  });

  it('rejects NaN timestamp via type check', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ createdAtMs: NaN }));
    expect(result.success).toBe(false);
  });
});

// --- Unknown field passthrough (AC: preserved through roundtrip) ---

describe('Unknown field passthrough', () => {
  it('preserves unknown top-level fields on ThoughtForm', () => {
    const input = { ...validThoughtForm(), customField: 'preserved', _internal: 42 };
    const result = ThoughtFormV1Schema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customField).toBe('preserved');
      expect(result.data._internal).toBe(42);
    }
  });

  it('preserves unknown fields on metadata', () => {
    const meta = { ...validMetadata(), experimentalScore: 0.95 };
    const result = ThoughtMetadataV1Schema.safeParse(meta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.experimentalScore).toBe(0.95);
    }
  });

  it('preserves unknown fields on entities', () => {
    const entity = { id: 'e1', type: 'person', value: 'Alice', customProp: true };
    const result = EntityV1Schema.safeParse(entity);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customProp).toBe(true);
    }
  });

  it('preserves unknown fields on relationships', () => {
    const rel = { id: 'r1', type: 'knows', from: 'e1', to: 'e2', provenance: 'inferred' };
    const result = RelationshipV1Schema.safeParse(rel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance).toBe('inferred');
    }
  });

  it('preserves unknown fields on redaction', () => {
    const redaction = { rawTextOmitted: true, redactedBy: 'policy-engine' };
    const result = RedactionSchema.safeParse(redaction);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.redactedBy).toBe('policy-engine');
    }
  });

  it('roundtrip: parse then JSON.stringify preserves unknown fields', () => {
    const input = {
      ...validThoughtForm(),
      futureField: { nested: [1, 2, 3] },
    };
    const result = ThoughtFormV1Schema.parse(input);
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized) as Record<string, unknown>;
    const reparsed = ThoughtFormV1Schema.parse(deserialized);
    expect(reparsed.futureField).toEqual({ nested: [1, 2, 3] });
  });
});

// --- Bundle v1 schema (AC: fixture validates) ---

describe('BundleV1Schema', () => {
  it('validates a complete bundle fixture', () => {
    const result = BundleV1Schema.safeParse(validBundle());
    expect(result.success).toBe(true);
  });

  it('validates bundle with multiple thoughtforms', () => {
    const bundle = validBundle({
      thoughtforms: [
        validThoughtForm({ id: 'tf_1' }),
        validThoughtForm({ id: 'tf_2', rawText: 'some text' }),
      ],
      manifest: {
        thoughtformCount: 2,
        payloadHash: 'sha256_payload',
        compression: 'gzip',
        encryption: 'vetkeys-aes-gcm-v1',
        chunkCount: 2,
        chunkSizeMaxBytes: 500_000,
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(true);
  });

  it('validates bundle with empty thoughtforms array', () => {
    const bundle = validBundle({
      thoughtforms: [],
      manifest: {
        thoughtformCount: 0,
        payloadHash: 'sha256_empty',
        compression: 'none',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: 1_000_000,
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(true);
  });

  it('rejects chunkSizeMaxBytes exceeding 1MB', () => {
    const bundle = validBundle({
      manifest: {
        thoughtformCount: 1,
        payloadHash: 'sha256_payload',
        compression: 'none',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: 1_000_001,
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it('rejects invalid syncMode', () => {
    const bundle = validBundle({
      commit: {
        commitId: 'cmt_abc',
        parentCommitId: null,
        createdAtMs: 1730000000000,
        syncMode: 'invalid',
        dedupeKey: 'key',
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it('rejects invalid compression mode', () => {
    const bundle = validBundle({
      manifest: {
        thoughtformCount: 1,
        payloadHash: 'sha256_payload',
        compression: 'brotli',
        encryption: 'none',
        chunkCount: 1,
        chunkSizeMaxBytes: 1_000_000,
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it('preserves unknown fields on bundle', () => {
    const input = { ...validBundle(), _bundleMeta: 'extra' };
    const result = BundleV1Schema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._bundleMeta).toBe('extra');
    }
  });

  it('preserves unknown fields on commit', () => {
    const bundle = validBundle({
      commit: {
        commitId: 'cmt_abc123',
        parentCommitId: null,
        createdAtMs: 1730000000000,
        syncMode: 'backup',
        dedupeKey: 'sha256_dedupekey',
        deviceInfo: 'macbook',
      },
    });
    const result = BundleV1Schema.safeParse(bundle);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commit.deviceInfo).toBe('macbook');
    }
  });
});

// --- Commit schema ---

describe('CommitSchema', () => {
  it('accepts valid commit with null parent', () => {
    const result = CommitSchema.safeParse({
      commitId: 'cmt_1',
      parentCommitId: null,
      createdAtMs: 1730000000000,
      syncMode: 'backup',
      dedupeKey: 'key1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid commit with parent', () => {
    const result = CommitSchema.safeParse({
      commitId: 'cmt_2',
      parentCommitId: 'cmt_1',
      createdAtMs: 1730000000000,
      syncMode: 'merge',
      dedupeKey: 'key2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative createdAtMs in commit', () => {
    const result = CommitSchema.safeParse({
      commitId: 'cmt_1',
      parentCommitId: null,
      createdAtMs: -1,
      syncMode: 'backup',
      dedupeKey: 'key1',
    });
    expect(result.success).toBe(false);
  });
});

// --- Manifest schema ---

describe('ManifestSchema', () => {
  it('accepts valid manifest', () => {
    const result = ManifestSchema.safeParse({
      thoughtformCount: 10,
      payloadHash: 'abc123',
      compression: 'gzip',
      encryption: 'vetkeys-aes-gcm-v1',
      chunkCount: 3,
      chunkSizeMaxBytes: 1_000_000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects zero chunkCount', () => {
    const result = ManifestSchema.safeParse({
      thoughtformCount: 10,
      payloadHash: 'abc123',
      compression: 'none',
      encryption: 'none',
      chunkCount: 0,
      chunkSizeMaxBytes: 1_000_000,
    });
    expect(result.success).toBe(false);
  });
});

// --- Delta schema ---

describe('DeltaSchema', () => {
  it('accepts valid delta range', () => {
    const result = DeltaSchema.safeParse({
      sinceUpdatedAtMsExclusive: 0,
      untilUpdatedAtMsInclusive: 1730000000000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative delta timestamps', () => {
    const result = DeltaSchema.safeParse({
      sinceUpdatedAtMsExclusive: -1,
      untilUpdatedAtMsInclusive: 1730000000000,
    });
    expect(result.success).toBe(false);
  });
});

// --- Chunk schema ---

describe('ChunkSchema', () => {
  it('validates a valid chunk', () => {
    const result = ChunkSchema.safeParse({
      version: '1.0',
      bundleId: 'bndl_01J',
      commitId: 'cmt_sha256hex',
      chunkIndex: 0,
      chunkCount: 4,
      chunkHash: 'sha256hex',
      payloadEncoding: 'base64',
      payload: 'SGVsbG8gV29ybGQ=',
      compressed: true,
      encrypted: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid payload encoding', () => {
    const result = ChunkSchema.safeParse({
      version: '1.0',
      bundleId: 'bndl_01J',
      commitId: 'cmt_sha256hex',
      chunkIndex: 0,
      chunkCount: 4,
      chunkHash: 'sha256hex',
      payloadEncoding: 'hex',
      payload: 'abc',
      compressed: false,
      encrypted: false,
    });
    expect(result.success).toBe(false);
  });

  it('preserves unknown fields on chunk', () => {
    const input = {
      version: '1.0',
      bundleId: 'bndl_01J',
      commitId: 'cmt_sha256hex',
      chunkIndex: 0,
      chunkCount: 1,
      chunkHash: 'sha256hex',
      payloadEncoding: 'base64',
      payload: 'data',
      compressed: false,
      encrypted: false,
      uploadedAtMs: 1730000000000,
    };
    const result = ChunkSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadedAtMs).toBe(1730000000000);
    }
  });
});

// --- Entity and Relationship schemas ---

describe('EntityV1Schema', () => {
  it('accepts valid entity with confidence', () => {
    const result = EntityV1Schema.safeParse({
      id: 'e1',
      type: 'person',
      value: 'Alice',
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity without confidence', () => {
    const result = EntityV1Schema.safeParse({
      id: 'e1',
      type: 'person',
      value: 'Alice',
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence > 1', () => {
    const result = EntityV1Schema.safeParse({
      id: 'e1',
      type: 'person',
      value: 'Alice',
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty id', () => {
    const result = EntityV1Schema.safeParse({
      id: '',
      type: 'person',
      value: 'Alice',
    });
    expect(result.success).toBe(false);
  });
});

describe('RelationshipV1Schema', () => {
  it('accepts valid relationship with weight', () => {
    const result = RelationshipV1Schema.safeParse({
      id: 'r1',
      type: 'knows',
      from: 'e1',
      to: 'e2',
      weight: 0.8,
    });
    expect(result.success).toBe(true);
  });

  it('accepts relationship without weight', () => {
    const result = RelationshipV1Schema.safeParse({
      id: 'r1',
      type: 'knows',
      from: 'e1',
      to: 'e2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty from field', () => {
    const result = RelationshipV1Schema.safeParse({
      id: 'r1',
      type: 'knows',
      from: '',
      to: 'e2',
    });
    expect(result.success).toBe(false);
  });
});

// --- Metadata contentHash validation ---

describe('ThoughtMetadataV1Schema contentHash', () => {
  it('rejects contentHash shorter than 16 chars', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ contentHash: 'short' }));
    expect(result.success).toBe(false);
  });

  it('accepts contentHash of exactly 16 chars', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ contentHash: 'a'.repeat(16) }));
    expect(result.success).toBe(true);
  });

  it('rejects empty source', () => {
    const result = ThoughtMetadataV1Schema.safeParse(validMetadata({ source: '' }));
    expect(result.success).toBe(false);
  });
});
