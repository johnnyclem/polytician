import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { serializeBundle } from '../src/storage/thoughtform.js';
import type { ThoughtForm } from '../src/types/thoughtform.js';

function makeThoughtForm(overrides?: Partial<ThoughtForm>): ThoughtForm {
  return {
    id: '00000000-0000-4000-a000-000000000001',
    rawText: 'sample text',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      author: null,
      tags: [],
      source: 'user_input',
    },
    entities: [],
    relationships: [],
    contextGraph: {},
    ...overrides,
  };
}

describe('serializeBundle', () => {
  it('should return raw JSON and compressed buffer by default', () => {
    const tf = makeThoughtForm();
    const result = serializeBundle([tf]);

    expect(result.json).toBe(JSON.stringify([tf]));
    expect(result.compressed).toBeInstanceOf(Buffer);
    expect(result.rawSize).toBe(Buffer.byteLength(result.json, 'utf8'));
    expect(result.compressedSize).toBeGreaterThan(0);
  });

  it('should skip compression when compress=false', () => {
    const tf = makeThoughtForm();
    const result = serializeBundle([tf], false);

    expect(result.compressed).toBeNull();
    expect(result.compressedSize).toBe(0);
    expect(result.json).toBe(JSON.stringify([tf]));
  });

  it('should produce a gzip buffer that decompresses to the original JSON', () => {
    const tf = makeThoughtForm({ rawText: 'The quick brown fox jumps over the lazy dog' });
    const result = serializeBundle([tf]);

    const decompressed = gunzipSync(result.compressed!).toString('utf8');
    expect(decompressed).toBe(result.json);
  });

  it('should achieve < 60% compression ratio for bundles > 100 KB', () => {
    // Build a large bundle by creating many ThoughtForms with repetitive text
    const forms: ThoughtForm[] = [];
    for (let i = 0; i < 200; i++) {
      forms.push(
        makeThoughtForm({
          id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
          rawText: `Concept ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(50),
          metadata: {
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-01T00:00:00Z',
            author: 'test-author',
            tags: ['tag-a', 'tag-b', 'tag-c'],
            source: 'extracted',
          },
          entities: [
            {
              id: `ent-${i}`,
              text: `entity-${i}`,
              type: 'CONCEPT',
              confidence: 0.95,
              offset: { start: 0, end: 10 },
            },
          ],
          relationships: [],
          contextGraph: {},
        }),
      );
    }

    const result = serializeBundle(forms);

    // Verify the bundle is actually > 100 KB
    expect(result.rawSize).toBeGreaterThan(100 * 1024);

    // Acceptance criteria: compressed < 60% of raw
    const ratio = result.compressedSize / result.rawSize;
    expect(ratio).toBeLessThan(0.6);
  });
});
