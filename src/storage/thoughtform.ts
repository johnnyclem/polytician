import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { ThoughtFormSchema } from '../types/thoughtform.js';
import { getAdapter } from '../db/client.js';
import type { ConceptRow } from '../db/adapter.js';
import type { ThoughtForm } from '../types/thoughtform.js';
import { ValidationError } from '../errors/index.js';

/**
 * Zod schema for a ThoughtForm bundle — an array of fully-formed ThoughtForms.
 */
export const ThoughtFormBundleSchema = z.array(ThoughtFormSchema).min(1);

export interface ThoughtFormBundle {
  version: string;
  thoughtforms: ThoughtForm[];
  metadata: {
    lastSynced: number;
    count: number;
  };
}

/**
 * Attempt to decompress gzip data. Returns the original input if it is not
 * gzip-compressed (no magic header).
 */
function maybeDecompress(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;

  // Gzip magic number: 0x1f 0x8b
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString('utf-8');
  }

  return typeof input === 'string' ? input : buf.toString('utf-8');
}

/**
 * Deserialize a ThoughtForm bundle (JSON or gzip-compressed JSON) and upsert
 * each ThoughtForm into the database.
 *
 * Conflict handling: if a concept with the same id already exists, the incoming
 * ThoughtForm overwrites it **only** when its `metadata.updatedAt` is strictly
 * newer than the stored version. Otherwise the incoming record is skipped.
 *
 * Guarantees:
 * - No duplicate ids after completion.
 * - Older versions never overwrite newer ones.
 */
export async function deserializeAndUpsertBundle(
  json: string | Buffer,
): Promise<void> {
  // Step 1: Decompress if needed
  const raw = maybeDecompress(json);

  // Step 2: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Bundle is not valid JSON');
  }

  // Step 3: Validate with zod
  const result = ThoughtFormBundleSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Bundle validation failed: ${issues}`);
  }

  const bundle = result.data;
  const adapter = getAdapter();

  // Step 4: Upsert each ThoughtForm
  for (const tf of bundle) {
    const incomingUpdatedAt = new Date(tf.metadata.updatedAt).getTime();
    const existing = await adapter.findConcept(tf.id);

    if (existing) {
      // Only overwrite if incoming is strictly newer
      if (incomingUpdatedAt <= existing.updated_at) {
        continue;
      }

      await adapter.updateConcept(tf.id, {
        updated_at: incomingUpdatedAt,
        thoughtform: JSON.stringify(tf),
        tags: JSON.stringify(tf.metadata.tags),
        version: existing.version + 1,
      });
    } else {
      const now = incomingUpdatedAt;
      const createdAt = new Date(tf.metadata.createdAt).getTime();

      const row: ConceptRow = {
        id: tf.id,
        namespace: 'default',
        version: 1,
        created_at: createdAt,
        updated_at: now,
        tags: JSON.stringify(tf.metadata.tags),
        markdown: null,
        thoughtform: JSON.stringify(tf),
        embedding: null,
      };

      await adapter.insertConcept(row);
    }
  }
}

/**
 * Query concepts with ThoughtForm data and serialize them into a versioned bundle.
 *
 * @param lastSynced - Optional epoch-ms cutoff; only rows with updated_at > lastSynced are included.
 * @returns JSON string of the ThoughtFormBundle.
 */
export async function serializeThoughtFormsBundle(lastSynced?: number): Promise<string> {
  const adapter = getAdapter();

  // First pass: get total count so we can fetch all rows.
  const { total } = await adapter.listConcepts({ limit: 1, offset: 0 });

  // Second pass: fetch all rows.
  const { rows: listRows } = await adapter.listConcepts({ limit: total || 1, offset: 0 });

  // Collect IDs that have thoughtforms and satisfy the lastSynced filter.
  const candidateIds: string[] = [];
  for (const row of listRows) {
    if (!row.has_tf) continue;
    if (lastSynced !== undefined && row.updated_at <= lastSynced) continue;
    candidateIds.push(row.id);
  }

  const thoughtforms: ThoughtForm[] = [];

  for (const id of candidateIds) {
    const conceptRow = (await adapter.findConcept(id)) as ConceptRow | null;
    if (!conceptRow?.thoughtform) continue;
    thoughtforms.push(JSON.parse(conceptRow.thoughtform) as ThoughtForm);
  }

  const bundle: ThoughtFormBundle = {
    version: '1.0',
    thoughtforms,
    metadata: {
      lastSynced: Date.now(),
      count: thoughtforms.length,
    },
  };

  return JSON.stringify(bundle);
}
