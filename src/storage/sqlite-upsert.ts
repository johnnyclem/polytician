/**
 * PolyVault SQLite upsert — idempotent ThoughtFormV1 → concepts table.
 *
 * Maps PolyVault ThoughtFormV1 records into the local `concepts` table.
 * Uses INSERT OR REPLACE so re-running a restore is safe and idempotent.
 */

import type { DatabaseAdapter, ConceptRow } from '../db/adapter.js';
import type { ThoughtFormV1 } from '../schemas/thoughtform.js';

export interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  totalProcessed: number;
}

/**
 * Convert a ThoughtFormV1 to the raw text used for embedding generation.
 * Concatenates rawText + entity values, matching the Python sidecar logic.
 */
export function extractEmbeddingText(tf: ThoughtFormV1): string {
  const parts: string[] = [];
  if (tf.rawText) parts.push(tf.rawText);
  for (const ent of tf.entities) {
    if (ent.value) parts.push(ent.value);
  }
  return parts.length > 0 ? parts.join(' ') : tf.id;
}

/**
 * Upsert a batch of ThoughtFormV1 records into the concepts table.
 *
 * - If the concept already exists with the same or older updatedAtMs, the row
 *   is replaced (idempotent).
 * - If the concept already exists with a newer updatedAtMs, the upsert is
 *   skipped (local-first: newer local data is not overwritten).
 * - The ThoughtForm JSON is stored in the `thoughtform` column.
 * - Tags are extracted from entity types for discoverability.
 * - Embeddings are NOT set here — they are handled by a separate rebuild step.
 */
export async function upsertThoughtforms(
  adapter: DatabaseAdapter,
  thoughtforms: ThoughtFormV1[],
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const tf of thoughtforms) {
    const existing = await adapter.findConcept(tf.id);

    if (existing) {
      // Skip if local data is newer (local-first policy)
      if (existing.updated_at > tf.metadata.updatedAtMs) {
        skipped++;
        continue;
      }

      // Update existing concept
      const tags = extractTags(tf, existing.tags);
      await adapter.updateConcept(tf.id, {
        version: existing.version + 1,
        updated_at: tf.metadata.updatedAtMs,
        tags: JSON.stringify(tags),
        thoughtform: JSON.stringify(tf),
        markdown: tf.rawText ?? existing.markdown,
      });
      updated++;
    } else {
      // Insert new concept
      const tags = extractTags(tf, '[]');
      const row: ConceptRow = {
        id: tf.id,
        namespace: 'default',
        version: 1,
        created_at: tf.metadata.createdAtMs,
        updated_at: tf.metadata.updatedAtMs,
        tags: JSON.stringify(tags),
        markdown: tf.rawText ?? null,
        thoughtform: JSON.stringify(tf),
        embedding: null,
      };
      await adapter.insertConcept(row);
      inserted++;
    }
  }

  return {
    inserted,
    updated,
    skipped,
    totalProcessed: thoughtforms.length,
  };
}

/**
 * Extract tags from a ThoughtForm, merging with any existing tags.
 */
function extractTags(tf: ThoughtFormV1, existingTagsJson: string): string[] {
  const existing: string[] = JSON.parse(existingTagsJson) as string[];
  const entityTypes = tf.entities.map((e) => e.type);
  return [...new Set([...existing, ...entityTypes])];
}
