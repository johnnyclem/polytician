import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../db/client.js';
import { concepts } from '../db/schema.js';
import type { Concept, ConceptRepresentations } from '../types/concept.js';
import { VECTOR_DIMENSION } from '../types/concept.js';
import type { ThoughtForm } from '../types/thoughtform.js';

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
  createdAt: number;
  updatedAt: number;
  tags: string[] | null;
  markdown: string | null;
  thoughtform: string | null;
  embedding: Buffer | null;
}): Concept {
  return {
    id: row.id,
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
    markdown?: string;
    thoughtform?: ThoughtForm;
    embedding?: number[];
    tags?: string[];
  }): Promise<Concept> {
    const db = getDatabase();
    const sqlite = getSqlite();
    const now = Date.now();
    const id = params.id ?? this.generateId();

    // Check if concept exists
    const existing = db.select().from(concepts).where(eq(concepts.id, id)).get();

    if (existing) {
      // Merge: only overwrite fields that are explicitly provided
      const existingTags: string[] = (existing.tags as string[] | null) ?? [];
      const newTags = params.tags ? [...new Set([...existingTags, ...params.tags])] : existingTags;

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

      // Sync sqlite-vec
      if (params.embedding !== undefined) {
        this.upsertVector(id, params.embedding);
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

      // Sync sqlite-vec
      if (params.embedding) {
        this.upsertVector(id, params.embedding);
      }
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
    const db = getDatabase();
    const sqlite = getSqlite();
    const row = db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!row) throw new Error(`Concept '${id}' not found`);

    sqlite.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    db.delete(concepts).where(eq(concepts.id, id)).run();
  }

  async list(params?: { limit?: number; offset?: number; tags?: string[] }): Promise<{
    concepts: Array<{
      id: string;
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

    // Build query
    let where = '';
    const queryParams: unknown[] = [];

    if (params?.tags && params.tags.length > 0) {
      const conditions = params.tags.map(() => `tags LIKE ?`);
      where = `WHERE ${conditions.join(' AND ')}`;
      for (const tag of params.tags) {
        queryParams.push(`%"${tag}"%`);
      }
    }

    const countResult = sqlite
      .prepare(`SELECT COUNT(*) as count FROM concepts ${where}`)
      .get(...queryParams) as { count: number };
    const rows = sqlite
      .prepare(
        `SELECT id, created_at, updated_at, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec FROM concepts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(...queryParams, limit, offset) as Array<{
      id: string;
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

  async search(
    queryEmbedding: number[],
    k: number = 10,
    tags?: string[]
  ): Promise<
    Array<{
      id: string;
      distance: number;
      tags: string[];
      representations: ConceptRepresentations;
    }>
  > {
    const sqlite = getSqlite();
    const queryBuf = serializeEmbedding(queryEmbedding);

    const vecResults = sqlite
      .prepare(
        'SELECT concept_id, distance FROM concept_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance'
      )
      .all(queryBuf, k) as Array<{ concept_id: string; distance: number }>;

    if (vecResults.length === 0) return [];

    // Fetch concept metadata for results
    const ids = vecResults.map(r => r.concept_id);
    const placeholders = ids.map(() => '?').join(',');
    const conceptRows = sqlite
      .prepare(
        `SELECT id, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec
         FROM concepts WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<{
      id: string;
      tags: string;
      has_md: number;
      has_tf: number;
      has_vec: number;
    }>;

    const conceptMap = new Map(conceptRows.map(r => [r.id, r]));

    let results = vecResults.map(vr => {
      const cr = conceptMap.get(vr.concept_id);
      const parsedTags = cr ? (JSON.parse(cr.tags) as string[]) : [];
      return {
        id: vr.concept_id,
        distance: vr.distance,
        tags: parsedTags,
        representations: {
          vector: cr ? cr.has_vec === 1 : false,
          markdown: cr ? cr.has_md === 1 : false,
          thoughtform: cr ? cr.has_tf === 1 : false,
        },
      };
    });

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      results = results.filter(r => tags.every(t => r.tags.includes(t)));
    }

    return results;
  }

  async getStats(): Promise<{
    conceptCount: number;
    vectorCount: number;
    representationCounts: { markdown: number; thoughtform: number; vector: number };
  }> {
    const sqlite = getSqlite();

    const conceptCount = (
      sqlite.prepare('SELECT COUNT(*) as count FROM concepts').get() as { count: number }
    ).count;
    const vectorCount = (
      sqlite.prepare('SELECT COUNT(*) as count FROM concept_vectors').get() as { count: number }
    ).count;
    const mdCount = (
      sqlite.prepare('SELECT COUNT(*) as count FROM concepts WHERE markdown IS NOT NULL').get() as {
        count: number;
      }
    ).count;
    const tfCount = (
      sqlite
        .prepare('SELECT COUNT(*) as count FROM concepts WHERE thoughtform IS NOT NULL')
        .get() as { count: number }
    ).count;
    const vecCount = (
      sqlite
        .prepare('SELECT COUNT(*) as count FROM concepts WHERE embedding IS NOT NULL')
        .get() as { count: number }
    ).count;

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

  private upsertVector(id: string, embedding: number[]): void {
    const sqlite = getSqlite();
    const buf = serializeEmbedding(embedding);

    // Delete existing if present, then insert
    sqlite.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    sqlite
      .prepare('INSERT INTO concept_vectors (concept_id, embedding) VALUES (?, ?)')
      .run(id, buf);
  }
}

export const conceptService = new ConceptService();
