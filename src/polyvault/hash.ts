import { createHash } from 'node:crypto';
import type { ThoughtFormV1 } from '../schemas/thoughtform.js';

const ALGORITHM = 'sha256';

export function sha256(data: Uint8Array): string {
  return createHash(ALGORITHM).update(data).digest('hex');
}

export function sha256String(data: string): string {
  return createHash(ALGORITHM).update(data, 'utf-8').digest('hex');
}

/** JSON with object keys sorted recursively, so equal values serialize to equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * The content hash of a ThoughtForm: SHA-256 (hex) of the canonical JSON of
 * its content fields `rawText` (null when omitted), `entities`,
 * `relationships` and `contextGraph`. Metadata is not part of it. Backup
 * recomputes it and rejects a ThoughtForm whose metadata.contentHash differs,
 * so a stale hash can never make edited content look like a duplicate.
 */
export function computeContentHash(tf: ThoughtFormV1): string {
  return sha256String(
    canonicalJson({
      rawText: tf.rawText ?? null,
      entities: tf.entities,
      relationships: tf.relationships,
      contextGraph: tf.contextGraph,
    })
  );
}

/** A copy of `tf` whose metadata.contentHash matches its content (for producers). */
export function withContentHash(tf: ThoughtFormV1): ThoughtFormV1 {
  return { ...tf, metadata: { ...tf.metadata, contentHash: computeContentHash(tf) } };
}
