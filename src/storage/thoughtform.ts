import { getAdapter } from '../db/client.js';
import type { ConceptRow } from '../db/adapter.js';
import type { ThoughtForm } from '../types/thoughtform.js';

export interface ThoughtFormBundle {
  version: string;
  thoughtforms: ThoughtForm[];
  metadata: {
    lastSynced: number;
    count: number;
  };
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
