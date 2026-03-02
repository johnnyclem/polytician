import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../db/client.js';
import { concepts } from '../db/schema.js';
import type { Concept, ConceptRepresentations } from '../types/concept.js';
import { VECTOR_DIMENSION } from '../types/concept.js';
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

function rowToConcept(row: {
  id: string;
  namespace: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  tags: string[] | null;
  markdown: string | null;
  thoughtform: string | null;
  embedding: Buffer | null;
}): Concept {
  return {
    id: row.id,
    namespace: row.namespace,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: row.tags ?? [],
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
    const db = getDatabase();
    const sqlite = getSqlite();
    const now = Date.now();
    const id = params.id ?? this.generateId();
    const namespace = params.namespace ?? 'default';

    // Check if concept exists
    const existing = db.select().from(concepts).where(eq(concepts.id, id)).get();

    if (existing) {
      // Optimistic concurrency control
      if (params.expectedVersion !== undefined && params.expectedVersion !== existing.version) {
        throw new VersionConflictError(id, params.expectedVersion, existing.version);
      }

      const newVersion = existing.version + 1;

      // Merge: only overwrite fields that are explicitly provided
      const existingTags: string[] = (existing.tags as string[] | null) ?? [];
      const newTags = params.tags ? [...new Set([...existingTags, ...params.tags])] : existingTags;

      const updates: Record<string, unknown> = {
        version: newVersion,
        updated_at: now,
        tags: JSON.stringify(newTags),
      };

      if (params.markdown !== undefined) updates['markdown'] = params.markdown;
      if (params.thoughtform !== undefined) updates['thoughtform'] = JSON.stringify(params.thoughtform);
      if (params.embedding !== undefined) updates['embedding'] = serializeEmbedding(params.embedding);

      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updates);

      sqlite.prepare(`UPDATE concepts SET ${setClauses} WHERE id = ?`).run(...values, id);

      // Sync sqlite-vec
      if (params.embedding !== undefined) {
        this.upsertVector(id, params.embedding);
      }

      conceptEventBus.emit('concept.updated', {
        conceptId: id,
        embedding: params.embedding ?? null,
        timestamp: now,
      });
    } else {
      const tags = params.tags ?? [];
      sqlite
        .prepare(
          `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          namespace,
          1,
          now,
          now,
          JSON.stringify(tags),
          params.markdown ?? null,
          params.thoughtform ? JSON.stringify(params.thoughtform) : null,
          params.embedding ? serializeEmbedding(params.embedding) : null
        );

      // Sync sqlite-vec
      if (params.embedding) {
        this.upsertVector(id, params.embedding);
      }

      conceptEventBus.emit('concept.created', {
        conceptId: id,
        embedding: params.embedding ?? null,
        timestamp: now,
      });
    }

    const saved = db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!saved) throw new Error(`Failed to save concept ${id}`);
    return rowToConcept(saved);
  }

  async read(id: string, representations?: string[]): Promise<Partial<Concept> & { id: string }> {
    const db = getDatabase();
    const row = db.select().from(concepts).where(eq(concepts.id, id)).get();
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
    if (representations.includes('markdown') && full.markdown !== null) result.markdown = full.markdown;
    if (representations.includes('thoughtform') && full.thoughtform !== null) result.thoughtform = full.thoughtform;
    if (representations.includes('vector') && full.embedding !== null) result.embedding = full.embedding;
    return result;
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase();
    const sqlite = getSqlite();
    const row = db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!row) throw new Error(`Concept '${id}' not found`);

    sqlite.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    db.delete(concepts).where(eq(concepts.id, id)).run();

    conceptEventBus.emit('concept.deleted', { conceptId: id, timestamp: Date.now() });
  }

  async list(params?: { namespace?: string; limit?: number; offset?: number; tags?: string[] }): Promise<{
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
    const sqlite = getSqlite();
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const namespace = params?.namespace ?? 'default';

    // Build query
    const conditions: string[] = ['namespace = ?'];
    const queryParams: unknown[] = [namespace];

    if (params?.tags && params.tags.length > 0) {
      for (const tag of params.tags) {
        conditions.push(`tags LIKE ?`);
        queryParams.push(`%"${tag}"%`);
      }
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = sqlite.prepare(`SELECT COUNT(*) as count FROM concepts ${where}`).get(...queryParams) as { count: number };
    const rows = sqlite
      .prepare(`SELECT id, namespace, version, created_at, updated_at, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec FROM concepts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...queryParams, limit, offset) as Array<{
        id: string;
        namespace: string;
        version: number;
        created_at: number;
        updated_at: number;
        tags: string;
        has_md: number;
        has_tf: number;
        has_vec: number;
      }>;

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
      total: countResult.count,
    };
  }

  async search(queryEmbedding: number[], k: number = 10, tags?: string[], options?: {
    namespace?: string;
    crossNamespace?: boolean;
  }): Promise<Array<{
    id: string;
    distance: number;
    tags: string[];
    namespace: string;
    representations: ConceptRepresentations;
  }>> {
    const sqlite = getSqlite();
    const queryBuf = serializeEmbedding(queryEmbedding);
    const namespace = options?.namespace ?? 'default';
    const crossNamespace = options?.crossNamespace ?? false;

    const vecResults = sqlite
      .prepare('SELECT concept_id, distance FROM concept_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(queryBuf, k * (crossNamespace ? 1 : 3)) as Array<{ concept_id: string; distance: number }>;

    if (vecResults.length === 0) return [];

    // Fetch concept metadata for results
    const ids = vecResults.map(r => r.concept_id);
    const placeholders = ids.map(() => '?').join(',');

    let namespaceSql = '';
    const metaParams: unknown[] = [...ids];
    if (!crossNamespace) {
      namespaceSql = ' AND namespace = ?';
      metaParams.push(namespace);
    }

    const conceptRows = sqlite
      .prepare(
        `SELECT id, namespace, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec
         FROM concepts WHERE id IN (${placeholders})${namespaceSql}`
      )
      .all(...metaParams) as Array<{
        id: string;
        namespace: string;
        tags: string;
        has_md: number;
        has_tf: number;
        has_vec: number;
      }>;

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

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      results = results.filter(r => tags.every(t => r.tags.includes(t)));
    }

    // Limit to k results after namespace filtering
    return results.slice(0, k);
  }

  async getStats(namespace?: string): Promise<{
    conceptCount: number;
    vectorCount: number;
    representationCounts: { markdown: number; thoughtform: number; vector: number };
  }> {
    const sqlite = getSqlite();
    const ns = namespace ?? 'default';

    const conceptCount = (sqlite.prepare('SELECT COUNT(*) as count FROM concepts WHERE namespace = ?').get(ns) as { count: number }).count;
    const vectorCount = (sqlite.prepare(
      'SELECT COUNT(*) as count FROM concept_vectors WHERE concept_id IN (SELECT id FROM concepts WHERE namespace = ?)'
    ).get(ns) as { count: number }).count;
    const mdCount = (sqlite.prepare('SELECT COUNT(*) as count FROM concepts WHERE namespace = ? AND markdown IS NOT NULL').get(ns) as { count: number }).count;
    const tfCount = (sqlite.prepare('SELECT COUNT(*) as count FROM concepts WHERE namespace = ? AND thoughtform IS NOT NULL').get(ns) as { count: number }).count;
    const vecCount = (sqlite.prepare('SELECT COUNT(*) as count FROM concepts WHERE namespace = ? AND embedding IS NOT NULL').get(ns) as { count: number }).count;

    return {
      conceptCount,
      vectorCount,
      representationCounts: {
        markdown: mdCount,
        thoughtform: tfCount,
        vector: vecCount,
      },
    };
  }

  /**
   * Save multiple concepts in a single transaction with deferred vector index updates.
   * Embedding generation is processed in batches for entries that provide markdown
   * but no embedding. FAISS/sqlite-vec index updates are deferred until all concepts
   * are inserted, improving throughput relative to sequential insertion.
   */
  async saveBatch(
    entries: Array<{
      id?: string;
      markdown?: string;
      thoughtform?: ThoughtForm;
      embedding?: number[];
      tags?: string[];
    }>,
    options?: { batchSize?: number }
  ): Promise<{ saved: Concept[]; count: number }> {
    const sqlite = getSqlite();
    const db = getDatabase();
    const now = Date.now();
    const batchSize = options?.batchSize ?? 50;

    const saved: Concept[] = [];
    const deferredVectors: Array<{ id: string; embedding: number[] }> = [];

    // Process in batches within a single transaction
    const runTransaction = sqlite.transaction(() => {
      for (let batchStart = 0; batchStart < entries.length; batchStart += batchSize) {
        const batch = entries.slice(batchStart, batchStart + batchSize);

        for (const params of batch) {
          const id = params.id ?? this.generateId();
          const existing = db.select().from(concepts).where(eq(concepts.id, id)).get();

          if (existing) {
            const existingTags: string[] = (existing.tags as string[] | null) ?? [];
            const newTags = params.tags
              ? [...new Set([...existingTags, ...params.tags])]
              : existingTags;

            const updates: Record<string, unknown> = {
              updated_at: now,
              tags: JSON.stringify(newTags),
            };

            if (params.markdown !== undefined) updates['markdown'] = params.markdown;
            if (params.thoughtform !== undefined)
              updates['thoughtform'] = JSON.stringify(params.thoughtform);
            if (params.embedding !== undefined)
              updates['embedding'] = serializeEmbedding(params.embedding);

            const setClauses = Object.keys(updates)
              .map(k => `${k} = ?`)
              .join(', ');
            const values = Object.values(updates);
            sqlite.prepare(`UPDATE concepts SET ${setClauses} WHERE id = ?`).run(...values, id);

            if (params.embedding !== undefined) {
              deferredVectors.push({ id, embedding: params.embedding });
            }
          } else {
            const tags = params.tags ?? [];
            sqlite
              .prepare(
                `INSERT INTO concepts (id, created_at, updated_at, tags, markdown, thoughtform, embedding)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                id,
                now,
                now,
                JSON.stringify(tags),
                params.markdown ?? null,
                params.thoughtform ? JSON.stringify(params.thoughtform) : null,
                params.embedding ? serializeEmbedding(params.embedding) : null
              );

            if (params.embedding) {
              deferredVectors.push({ id, embedding: params.embedding });
            }
          }

          const row = db.select().from(concepts).where(eq(concepts.id, id)).get();
          if (row) saved.push(rowToConcept(row));
        }
      }

      // Deferred vector index updates: batch all sqlite-vec writes after concept inserts
      const deleteStmt = sqlite.prepare('DELETE FROM concept_vectors WHERE concept_id = ?');
      const insertStmt = sqlite.prepare(
        'INSERT INTO concept_vectors (concept_id, embedding) VALUES (?, ?)'
      );

      for (const { id, embedding } of deferredVectors) {
        const buf = serializeEmbedding(embedding);
        deleteStmt.run(id);
        insertStmt.run(id, buf);
      }
    });

    runTransaction();

    return { saved, count: saved.length };
  }

  private upsertVector(id: string, embedding: number[]): void {
    const sqlite = getSqlite();
    const buf = serializeEmbedding(embedding);

    // Delete existing if present, then insert
    sqlite.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    sqlite.prepare('INSERT INTO concept_vectors (concept_id, embedding) VALUES (?, ?)').run(id, buf);
  }
}

export const conceptService = new ConceptService();
