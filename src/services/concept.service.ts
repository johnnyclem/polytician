import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from '../db/client.js';
import type { ConceptRow } from '../db/adapter.js';
import type { Concept, ConceptRepresentations } from '../types/concept.js';
import type { ThoughtForm } from '../types/thoughtform.js';
import { VersionConflictError } from '../errors/index.js';
import { conceptEventBus } from '../events/concept-events.js';

function deserializeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}

function serializeEmbedding(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding);
  return Buffer.from(floats.buffer);
}

function parseThoughtForm(raw: string | null): ThoughtForm | null {
  if (!raw) return null;
  return JSON.parse(raw) as ThoughtForm;
}

function rowToConcept(row: ConceptRow): Concept {
  return {
    id: row.id,
    namespace: row.namespace,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags) as string[],
    markdown: row.markdown,
    thoughtform: parseThoughtForm(row.thoughtform),
    embedding: deserializeEmbedding(row.embedding),
  };
}

export class ConceptService {
  generateId(): string {
    return uuidv4();
  }

  async save(params: {
    id?: string;
    namespace?: string;
    expectedVersion?: number;
    markdown?: string;
    thoughtform?: ThoughtForm;
    embedding?: number[];
    tags?: string[];
  }): Promise<Concept> {
    const adapter = getAdapter();
    const now = Date.now();
    const id = params.id ?? this.generateId();

    // Check if concept exists
    const existing = await adapter.findConcept(id);

    if (existing) {
      // Optimistic concurrency control
      const currentVersion = existing.version;
      if (params.expectedVersion !== undefined && params.expectedVersion !== currentVersion) {
        throw new VersionConflictError(id, params.expectedVersion, currentVersion);
      }

      const newVersion = currentVersion + 1;

      // Merge: only overwrite fields that are explicitly provided
      const existingTags: string[] = JSON.parse(existing.tags) as string[];
      const newTags = params.tags ? [...new Set([...existingTags, ...params.tags])] : existingTags;

      const updates: Record<string, unknown> = {
        version: newVersion,
        updated_at: now,
        tags: JSON.stringify(newTags),
      };

      if (params.markdown !== undefined) updates['markdown'] = params.markdown;
      if (params.thoughtform !== undefined)
        updates['thoughtform'] = JSON.stringify(params.thoughtform);
      if (params.embedding !== undefined)
        updates['embedding'] = serializeEmbedding(params.embedding);

      await adapter.updateConcept(id, updates);

      // Sync vector index
      if (params.embedding !== undefined) {
        await adapter.upsertVector(id, serializeEmbedding(params.embedding));
      }

      conceptEventBus.emit('concept.updated', {
        conceptId: id,
        embedding: params.embedding ?? null,
        timestamp: now,
      });
    } else {
      const tags = params.tags ?? [];
      const namespace = params.namespace ?? 'default';
      const row: ConceptRow = {
        id,
        namespace,
        version: 1,
        created_at: now,
        updated_at: now,
        tags: JSON.stringify(tags),
        markdown: params.markdown ?? null,
        thoughtform: params.thoughtform ? JSON.stringify(params.thoughtform) : null,
        embedding: params.embedding ? serializeEmbedding(params.embedding) : null,
      };

      await adapter.insertConcept(row);

      // Sync vector index
      if (params.embedding) {
        await adapter.upsertVector(id, serializeEmbedding(params.embedding));
      }

      conceptEventBus.emit('concept.created', {
        conceptId: id,
        embedding: params.embedding ?? null,
        timestamp: now,
      });
    }

    const saved = await adapter.findConcept(id);
    if (!saved) throw new Error(`Failed to save concept ${id}`);
    return rowToConcept(saved);
  }

  async read(id: string, representations?: string[]): Promise<Partial<Concept> & { id: string }> {
    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    if (!row) throw new Error(`Concept '${id}' not found`);

    const full = rowToConcept(row);

    // If no filter, return only non-null representations
    if (!representations || representations.length === 0) {
      const result: Partial<Concept> & { id: string } = {
        id: full.id,
        namespace: full.namespace,
        version: full.version,
        createdAt: full.createdAt,
        updatedAt: full.updatedAt,
        tags: full.tags,
      };
      if (full.markdown !== null) result.markdown = full.markdown;
      if (full.thoughtform !== null) result.thoughtform = full.thoughtform;
      if (full.embedding !== null) result.embedding = full.embedding;
      return result;
    }

    // Filter to requested representations
    const result: Partial<Concept> & { id: string } = {
      id: full.id,
      namespace: full.namespace,
      version: full.version,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
      tags: full.tags,
    };
    if (representations.includes('markdown') && full.markdown !== null)
      result.markdown = full.markdown;
    if (representations.includes('thoughtform') && full.thoughtform !== null)
      result.thoughtform = full.thoughtform;
    if (representations.includes('vector') && full.embedding !== null)
      result.embedding = full.embedding;
    return result;
  }

  async delete(id: string): Promise<void> {
    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    if (!row) throw new Error(`Concept '${id}' not found`);

    await adapter.deleteVector(id);
    await adapter.deleteConcept(id);

    conceptEventBus.emit('concept.deleted', { conceptId: id, timestamp: Date.now() });
  }

  async list(params?: {
    namespace?: string;
    limit?: number;
    offset?: number;
    tags?: string[];
  }): Promise<{
    concepts: Array<{
      id: string;
      namespace: string;
      version: number;
      createdAt: number;
      updatedAt: number;
      tags: string[];
      representations: ConceptRepresentations;
    }>;
    total: number;
  }> {
    const adapter = getAdapter();
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    const { rows, total } = await adapter.listConcepts({
      limit,
      offset,
      tags: params?.tags,
      namespace: params?.namespace ?? 'default',
    });

    return {
      concepts: rows.map(r => ({
        id: r.id,
        namespace: r.namespace,
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tags: JSON.parse(r.tags) as string[],
        representations: {
          vector: r.has_vec === 1,
          markdown: r.has_md === 1,
          thoughtform: r.has_tf === 1,
        },
      })),
      total,
    };
  }

  async search(
    queryEmbedding: number[],
    k: number = 10,
    tags?: string[],
    options?: { namespace?: string; crossNamespace?: boolean }
  ): Promise<
    Array<{
      id: string;
      distance: number;
      tags: string[];
      namespace: string;
      representations: ConceptRepresentations;
    }>
  > {
    const adapter = getAdapter();
    const queryBuf = serializeEmbedding(queryEmbedding);
    const namespace = options?.namespace ?? 'default';
    const crossNamespace = options?.crossNamespace ?? false;

    const vecResults = await adapter.vectorSearch(queryBuf, crossNamespace ? k : k * 3);

    if (vecResults.length === 0) return [];

    // Fetch concept metadata for results
    const ids = vecResults.map(r => r.concept_id);
    const conceptRows = await adapter.findConceptMeta(ids);
    const conceptMap = new Map(conceptRows.map(r => [r.id, r]));

    let results = vecResults
      .filter(vr => conceptMap.has(vr.concept_id))
      .map(vr => {
        const cr = conceptMap.get(vr.concept_id)!;
        const parsedTags = JSON.parse(cr.tags) as string[];
        return {
          id: vr.concept_id,
          distance: vr.distance,
          tags: parsedTags,
          namespace: cr.namespace,
          representations: {
            vector: cr.has_vec === 1,
            markdown: cr.has_md === 1,
            thoughtform: cr.has_tf === 1,
          },
        };
      });

    // Filter by namespace unless cross-namespace is enabled
    if (!crossNamespace) {
      results = results.filter(r => r.namespace === namespace);
    }

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      results = results.filter(r => tags.every(t => r.tags.includes(t)));
    }

    return results.slice(0, k);
  }

  async getStats(namespace?: string): Promise<{
    conceptCount: number;
    vectorCount: number;
    representationCounts: { markdown: number; thoughtform: number; vector: number };
  }> {
    const adapter = getAdapter();
    const stats = await adapter.getStats(namespace);

    return {
      conceptCount: stats.conceptCount,
      vectorCount: stats.vectorCount,
      representationCounts: {
        markdown: stats.mdCount,
        thoughtform: stats.tfCount,
        vector: stats.vecCount,
      },
    };
  }

  async saveBatch(
    entries: Array<{
      id?: string;
      markdown?: string;
      thoughtform?: ThoughtForm;
      embedding?: number[];
      tags?: string[];
    }>,
    _options?: { batchSize?: number }
  ): Promise<{ saved: Concept[]; count: number }> {
    const saved: Concept[] = [];

    for (const entry of entries) {
      const concept = await this.save(entry);
      saved.push(concept);
    }

    return { saved, count: saved.length };
  }
}

export const conceptService = new ConceptService();
