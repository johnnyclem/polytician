import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from '../db/client.js';
import type { ConceptRow, ConceptUpdateFields, ConceptWrite } from '../db/adapter.js';
import {
  embeddingProblem,
  type Concept,
  type ConceptRepresentations,
  type DerivedMap,
  type RepresentationType,
  type SearchResult,
} from '../types/concept.js';
import {
  StoredThoughtFormSchema,
  thoughtFormText,
  type StoredThoughtForm,
} from '../types/thoughtform.js';
import { LIMITS, NAMESPACE_PATTERN } from '../types/limits.js';
import {
  NamespaceDeniedError,
  NotFoundError,
  OverwriteRefusedError,
  ValidationError,
  VersionConflictError,
} from '../errors/index.js';
import { conceptEventBus } from '../events/concept-events.js';
import { serializeEmbedding, deserializeEmbedding } from '../db/embedding-codec.js';
import { embeddingService } from './embedding.service.js';

/**
 * A write without expectedVersion re-reads and re-applies its merge when a
 * concurrent writer changed the row first; this bounds those retries.
 */
const MAX_WRITE_ATTEMPTS = 8;

/** Upper bound on rows fetched while widening a search to settle a tie at the k boundary. */
const MAX_SEARCH_FETCH = 4096;

export interface SaveParams {
  id?: string;
  /**
   * Namespace for a new concept (default 'default'). On update, if given, it
   * must equal the stored namespace; omitted means "keep" (trusted callers).
   */
  namespace?: string;
  /** Reject the write with VersionConflictError unless the stored version matches. */
  expectedVersion?: number;
  markdown?: string;
  thoughtform?: StoredThoughtForm;
  embedding?: number[];
  tags?: string[];
  /**
   * When no embedding is supplied, derive the vector from the markdown written
   * (else the thoughtform text). Never replaces an authored vector.
   */
  autoEmbed?: boolean;
  /** Representations in this write that were derived, with provenance. Others are authored. */
  derived?: DerivedMap;
  /** Allow derived representations in this write to replace authored ones. */
  overwrite?: boolean;
}

/** A concept as a backup holds it: every stored field, representations as values. */
export interface RestoreRecord {
  id: string;
  namespace: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  markdown: string | null;
  thoughtform: StoredThoughtForm | null;
  embedding: number[] | null;
  derived: DerivedMap;
}

/**
 * When a restored concept already exists: 'newer' replaces it only if the
 * backup copy was updated later (last write wins), 'overwrite' always
 * replaces it, 'skip' never does.
 */
export type RestoreConflictPolicy = 'newer' | 'overwrite' | 'skip';

export type RestoreSkipReason = 'exists' | 'not-newer' | 'other-namespace';

export interface RestoreOutcome {
  inserted: string[];
  updated: string[];
  skipped: Array<{ id: string; namespace: string; reason: RestoreSkipReason }>;
}

export interface SearchOptions {
  /** Namespace to search (default 'default'). Ignored when `namespaces` is set. */
  namespace?: string;
  /** Several namespaces, or '*' for all. */
  namespaces?: readonly string[] | '*';
}

interface PlannedWrite {
  write: ConceptWrite;
  row: ConceptRow;
  created: boolean;
  /** Embedding written by this write (undefined: unchanged). */
  embedding: number[] | null | undefined;
}

function parseDerived(raw: string | undefined | null): DerivedMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DerivedMap)
      : {};
  } catch {
    return {};
  }
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
    // Stored as validated on write; rows from 2.x may hold free-form JSON,
    // which conversions re-validate before use.
    thoughtform: row.thoughtform ? (JSON.parse(row.thoughtform) as StoredThoughtForm) : null,
    embedding: deserializeEmbedding(row.embedding),
    derived: parseDerived(row.derived),
  };
}

function hasRepresentation(row: ConceptRow, rep: RepresentationType): boolean {
  if (rep === 'markdown') return row.markdown !== null;
  if (rep === 'thoughtform') return row.thoughtform !== null;
  return row.embedding !== null;
}

/** Throws ValidationError describing the first invalid field of a save entry. */
function validateEntry(entry: SaveParams, label: string): void {
  const fail = (message: string): never => {
    throw new ValidationError(`${label}: ${message}`);
  };
  if (entry.namespace !== undefined && !NAMESPACE_PATTERN.test(entry.namespace)) {
    fail(`invalid namespace '${entry.namespace}'`);
  }
  if (
    entry.expectedVersion !== undefined &&
    !(Number.isInteger(entry.expectedVersion) && entry.expectedVersion > 0)
  ) {
    fail('expectedVersion must be a positive integer');
  }
  if (entry.markdown !== undefined) {
    if (typeof entry.markdown !== 'string') fail('markdown must be a string');
    if (entry.markdown.length > LIMITS.markdownChars) {
      fail(`markdown exceeds ${LIMITS.markdownChars} characters`);
    }
  }
  if (entry.thoughtform !== undefined) {
    const parsed = StoredThoughtFormSchema.safeParse(entry.thoughtform);
    if (!parsed.success) {
      fail(
        `thoughtform matches neither the native nor the PolyVault v1 schema: ${parsed.error.issues
          .slice(0, 3)
          .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`
      );
    }
    if (JSON.stringify(entry.thoughtform).length > LIMITS.thoughtformChars) {
      fail(`thoughtform exceeds ${LIMITS.thoughtformChars} characters when serialized`);
    }
  }
  if (entry.embedding !== undefined) {
    const problem = embeddingProblem(entry.embedding);
    if (problem) fail(problem);
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.length > LIMITS.tags) {
      fail(`tags must be an array of at most ${LIMITS.tags} strings`);
    }
    for (const tag of entry.tags) {
      if (typeof tag !== 'string' || tag.length === 0 || tag.length > LIMITS.tagChars) {
        fail(`each tag must be a string of 1-${LIMITS.tagChars} characters`);
      }
    }
  }
}

/** Text an entry's vector would be derived from, and which representation it comes from. */
function autoEmbedSource(
  entry: SaveParams
): { text: string; from: 'markdown' | 'thoughtform' } | null {
  if (entry.markdown !== undefined) {
    return entry.markdown.trim().length > 0 ? { text: entry.markdown, from: 'markdown' } : null;
  }
  if (entry.thoughtform !== undefined) {
    const text = thoughtFormText(entry.thoughtform);
    return text ? { text, from: 'thoughtform' } : null;
  }
  return null;
}

function mergeTags(existing: string[], added: string[] | undefined, label: string): string[] {
  const tags = [...new Set([...existing, ...(added ?? [])])];
  if (tags.length > LIMITS.tags) {
    throw new ValidationError(`${label}: a concept can have at most ${LIMITS.tags} tags`);
  }
  return tags;
}

export class ConceptService {
  generateId(): string {
    return uuidv4();
  }

  /**
   * Create or update one concept. The row and its vector are written in one
   * transaction, and an update only applies if the row is still at the
   * version it was read at, so concurrent writers never lose each other's
   * changes: with expectedVersion the loser gets VersionConflictError,
   * without it the merge is re-applied on top of the winner.
   */
  async save(params: SaveParams): Promise<Concept> {
    const {
      saved: [concept],
    } = await this.saveBatch([params], { autoEmbed: params.autoEmbed });
    if (!concept) throw new Error('save produced no concept');
    return concept;
  }

  /**
   * Save several concepts atomically: every entry is validated (and embedded,
   * once, if autoEmbed applies) before anything is written, then all rows and
   * vectors are written in a single transaction. Either all entries are
   * saved or none are.
   */
  async saveBatch(
    entries: SaveParams[],
    options?: { autoEmbed?: boolean; batchSize?: number }
  ): Promise<{ saved: Concept[]; count: number }> {
    if (entries.length > LIMITS.batchEntries) {
      throw new ValidationError(`a batch can hold at most ${LIMITS.batchEntries} concepts`);
    }
    entries.forEach((entry, i) => validateEntry(entry, entries.length > 1 ? `entry ${i}` : 'save'));

    const autoVectors = await this.embedMissing(entries, options);
    const items = entries.map((entry, i) => ({
      entry,
      id: entry.id ?? this.generateId(),
      auto: autoVectors[i],
    }));
    if (new Set(items.map(item => item.id)).size !== items.length) {
      throw new ValidationError('a batch cannot contain the same concept id twice');
    }

    const adapter = getAdapter();

    for (let attempt = 1; ; attempt++) {
      const now = Date.now();
      const planned: PlannedWrite[] = [];
      for (const { entry, id, auto } of items) {
        planned.push(this.plan(entry, id, await adapter.findConcept(id), auto, now));
      }
      const outcome = await adapter.applyWrites(planned.map(p => p.write));

      if (outcome.ok) {
        for (const p of planned) {
          conceptEventBus.emit(p.created ? 'concept.created' : 'concept.updated', {
            conceptId: p.row.id,
            embedding: p.embedding ?? null,
            timestamp: now,
          });
        }
        const saved = planned.map(p => rowToConcept(p.row));
        return { saved, count: saved.length };
      }

      // A concurrent writer changed (or created) the row between our read and
      // our write; nothing from this batch was applied.
      const failed = items[outcome.index];
      const read = planned[outcome.index];
      if (!failed || !read) throw new Error(`write ${outcome.index} failed`);
      if (failed.entry.expectedVersion !== undefined || attempt >= MAX_WRITE_ATTEMPTS) {
        const current = await adapter.findConcept(failed.id);
        throw new VersionConflictError(
          failed.id,
          failed.entry.expectedVersion ?? (read.created ? 0 : read.row.version - 1),
          current?.version ?? 0
        );
      }
    }
  }

  /**
   * Write concepts from a backup as they were saved: same ids, namespaces,
   * timestamps, tags, representations, vectors and provenance. Every record
   * is validated before anything is written, then all writes are applied in
   * one transaction. A concept that lives in another namespace is never
   * touched; other existing concepts follow `onConflict` (default 'newer').
   */
  async restore(
    records: RestoreRecord[],
    options: { onConflict?: RestoreConflictPolicy } = {}
  ): Promise<RestoreOutcome> {
    const onConflict = options.onConflict ?? 'newer';
    records.forEach((r, i) => {
      const label = `backup record ${i + 1}`;
      validateEntry(
        {
          namespace: r.namespace,
          markdown: r.markdown ?? undefined,
          thoughtform: r.thoughtform ?? undefined,
          embedding: r.embedding ?? undefined,
          tags: r.tags,
        },
        label
      );
      if (r.markdown === null && r.thoughtform === null && r.embedding === null) {
        throw new ValidationError(`${label}: a concept needs at least one representation`);
      }
    });
    if (new Set(records.map(r => r.id)).size !== records.length) {
      throw new ValidationError('a backup cannot contain the same concept id twice');
    }

    const adapter = getAdapter();
    for (let attempt = 1; ; attempt++) {
      const writes: ConceptWrite[] = [];
      const outcome: RestoreOutcome = { inserted: [], updated: [], skipped: [] };
      const written: RestoreRecord[] = [];

      for (const r of records) {
        const existing = await adapter.findConcept(r.id);
        const content = {
          tags: JSON.stringify(r.tags),
          markdown: r.markdown,
          thoughtform: r.thoughtform !== null ? JSON.stringify(r.thoughtform) : null,
          embedding: r.embedding !== null ? serializeEmbedding(r.embedding) : null,
          derived: JSON.stringify(r.derived),
        };
        if (!existing) {
          writes.push({
            kind: 'insert',
            row: {
              id: r.id,
              namespace: r.namespace,
              version: r.version,
              created_at: r.createdAt,
              updated_at: r.updatedAt,
              ...content,
            },
          });
          outcome.inserted.push(r.id);
          written.push(r);
          continue;
        }
        const skip = (reason: RestoreSkipReason): void => {
          outcome.skipped.push({ id: r.id, namespace: r.namespace, reason });
        };
        if (existing.namespace !== r.namespace) {
          skip('other-namespace');
          continue;
        }
        if (onConflict === 'skip') {
          skip('exists');
          continue;
        }
        if (onConflict === 'newer' && r.updatedAt <= existing.updated_at) {
          skip('not-newer');
          continue;
        }
        writes.push({
          kind: 'update',
          id: r.id,
          namespace: existing.namespace,
          expectedVersion: existing.version,
          // updated_at never moves backwards, so later syncs still see this as the newest write.
          fields: {
            version: existing.version + 1,
            updated_at: Math.max(r.updatedAt, existing.updated_at + 1),
            ...content,
          },
        });
        outcome.updated.push(r.id);
        written.push(r);
      }

      if (writes.length === 0) return outcome;
      const applied = await adapter.applyWrites(writes);
      if (applied.ok) {
        const now = Date.now();
        const inserted = new Set(outcome.inserted);
        for (const r of written) {
          conceptEventBus.emit(inserted.has(r.id) ? 'concept.created' : 'concept.updated', {
            conceptId: r.id,
            embedding: r.embedding,
            timestamp: now,
          });
        }
        return outcome;
      }
      // A concurrent writer changed a row between our read and our write;
      // nothing was applied, so re-read and plan again.
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        const failed = written[applied.index];
        const current = failed ? await adapter.findConcept(failed.id) : null;
        throw new VersionConflictError(failed?.id ?? '?', 0, current?.version ?? 0);
      }
    }
  }

  /** Embed, once per entry, the entries whose vector autoEmbed should derive. */
  private async embedMissing(
    entries: SaveParams[],
    options?: { autoEmbed?: boolean; batchSize?: number }
  ): Promise<Array<{ vector: number[]; from: 'markdown' | 'thoughtform' } | undefined>> {
    const pending: Array<{ index: number; text: string; from: 'markdown' | 'thoughtform' }> = [];
    entries.forEach((entry, index) => {
      if (!(entry.autoEmbed ?? options?.autoEmbed ?? false) || entry.embedding !== undefined)
        return;
      const source = autoEmbedSource(entry);
      if (source) pending.push({ index, ...source });
    });

    const result: Array<{ vector: number[]; from: 'markdown' | 'thoughtform' } | undefined> =
      new Array(entries.length).fill(undefined);
    if (pending.length === 0) return result;

    const vectors = await embeddingService.embedBatch(
      pending.map(p => p.text),
      options?.batchSize
    );
    pending.forEach((p, i) => {
      const vector = vectors[i] ?? [];
      const problem = embeddingProblem(vector);
      if (problem) throw new ValidationError(`embedder returned an unusable vector: ${problem}`);
      result[p.index] = { vector, from: p.from };
    });
    return result;
  }

  /** Turn one validated entry plus the row it was read against into a conditional write. */
  private plan(
    entry: SaveParams,
    id: string,
    existing: ConceptRow | null,
    auto: { vector: number[]; from: 'markdown' | 'thoughtform' } | undefined,
    now: number
  ): PlannedWrite {
    const label = `concept '${id}'`;

    if (existing) {
      // Checked first, so a caller from another namespace learns nothing else about the row.
      if (entry.namespace !== undefined && entry.namespace !== existing.namespace) {
        throw new NamespaceDeniedError(
          `Concept '${id}' belongs to a different namespace; it cannot be written from '${entry.namespace}'`
        );
      }
      if (entry.expectedVersion !== undefined && entry.expectedVersion !== existing.version) {
        throw new VersionConflictError(id, entry.expectedVersion, existing.version);
      }
    } else if (entry.expectedVersion !== undefined) {
      // A caller holding an expectedVersion believes the concept exists; if it
      // is gone (e.g. concurrently deleted) that is a conflict, not a create.
      throw new VersionConflictError(id, entry.expectedVersion, 0);
    }

    const derived: DerivedMap = existing ? parseDerived(existing.derived) : {};

    // Explicitly supplied representations: derived ones may not replace authored content.
    const supplied: Array<[RepresentationType, boolean]> = [
      ['markdown', entry.markdown !== undefined],
      ['thoughtform', entry.thoughtform !== undefined],
      ['vector', entry.embedding !== undefined],
    ];
    for (const [rep, present] of supplied) {
      if (!present) continue;
      const provenance = entry.derived?.[rep];
      if (!provenance) {
        delete derived[rep];
        continue;
      }
      if (existing && hasRepresentation(existing, rep) && !derived[rep] && !entry.overwrite) {
        throw new OverwriteRefusedError(id, rep);
      }
      derived[rep] = provenance;
    }

    let embedding: number[] | undefined = entry.embedding;
    if (embedding === undefined && auto) {
      // Re-derive only when this write changes the vector's source text, and
      // never over an authored vector. A thoughtform-only write leaves a
      // vector that was derived from existing markdown alone.
      const sourceChanged = auto.from === 'markdown' || !existing || existing.markdown === null;
      const vectorAuthored = existing !== null && existing.embedding !== null && !derived.vector;
      if (sourceChanged && !vectorAuthored) {
        embedding = auto.vector;
        derived.vector = { from: auto.from };
      }
    }

    const thoughtform =
      entry.thoughtform !== undefined ? JSON.stringify(entry.thoughtform) : undefined;
    const embeddingBuf = embedding !== undefined ? serializeEmbedding(embedding) : undefined;

    if (!existing) {
      if (entry.markdown === undefined && thoughtform === undefined && embedding === undefined) {
        throw new ValidationError(
          `${label}: a new concept needs at least one representation (markdown, thoughtform or embedding)`
        );
      }
      const row: ConceptRow = {
        id,
        namespace: entry.namespace ?? 'default',
        version: 1,
        created_at: now,
        updated_at: now,
        tags: JSON.stringify(mergeTags([], entry.tags, label)),
        markdown: entry.markdown ?? null,
        thoughtform: thoughtform ?? null,
        embedding: embeddingBuf ?? null,
        derived: JSON.stringify(derived),
      };
      return { write: { kind: 'insert', row }, row, created: true, embedding };
    }

    const version = existing.version + 1;
    const tags = JSON.stringify(
      mergeTags(JSON.parse(existing.tags) as string[], entry.tags, label)
    );
    const derivedJson = JSON.stringify(derived);
    const fields: ConceptUpdateFields = {
      version,
      updated_at: now,
      tags,
      markdown: entry.markdown,
      thoughtform,
      embedding: embeddingBuf,
      derived: derivedJson,
    };
    const row: ConceptRow = {
      ...existing,
      version,
      updated_at: now,
      tags,
      markdown: entry.markdown ?? existing.markdown,
      thoughtform: thoughtform ?? existing.thoughtform,
      embedding: embeddingBuf ?? existing.embedding,
      derived: derivedJson,
    };
    return {
      write: {
        kind: 'update',
        id,
        namespace: existing.namespace,
        expectedVersion: existing.version,
        fields,
      },
      row,
      created: false,
      embedding,
    };
  }

  /**
   * Read a concept. With `namespace`, a concept stored in another namespace
   * is reported as not found (callers cannot probe other namespaces).
   */
  async read(
    id: string,
    representations?: string[],
    options?: { namespace?: string }
  ): Promise<Partial<Concept> & { id: string }> {
    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    if (!row || (options?.namespace !== undefined && row.namespace !== options.namespace)) {
      throw new NotFoundError('Concept', id);
    }

    const full = rowToConcept(row);
    const wants = (rep: RepresentationType): boolean =>
      !representations || representations.length === 0 || representations.includes(rep);

    const result: Partial<Concept> & { id: string } = {
      id: full.id,
      namespace: full.namespace,
      version: full.version,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
      tags: full.tags,
      derived: full.derived,
    };
    if (wants('markdown') && full.markdown !== null) result.markdown = full.markdown;
    if (wants('thoughtform') && full.thoughtform !== null) result.thoughtform = full.thoughtform;
    if (wants('vector') && full.embedding !== null) result.embedding = full.embedding;
    return result;
  }

  /** Delete a concept and its vector atomically. With `namespace`, only from that namespace. */
  async delete(id: string, options?: { namespace?: string }): Promise<void> {
    const outcome = await getAdapter().applyWrites([
      { kind: 'delete', id, namespace: options?.namespace },
    ]);
    if (!outcome.ok) throw new NotFoundError('Concept', id);

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

  /**
   * k nearest concepts by cosine similarity among those in the requested
   * namespace(s) carrying every tag in `tags`. Filters run inside the vector
   * query. `score` is (1 + cosine similarity) / 2 in [0, 1]; equal scores are
   * ordered by id, so the result is a function of the stored data.
   */
  async search(
    queryEmbedding: number[],
    k: number = 10,
    tags?: string[],
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const problem = embeddingProblem(queryEmbedding);
    if (problem) throw new ValidationError(`query vector: ${problem}`);
    if (!Number.isInteger(k) || k < 1) throw new ValidationError('k must be a positive integer');

    const adapter = getAdapter();
    const queryBuf = serializeEmbedding(queryEmbedding);
    const namespaces =
      options?.namespaces === '*'
        ? null
        : (options?.namespaces ?? [options?.namespace ?? 'default']);
    const filter = { namespaces, tags: tags && tags.length > 0 ? tags : undefined };

    // Fetch one extra row to see whether the k-th score is tied with rows
    // beyond it; if so, widen until the tied group is complete so the id
    // tie-break decides which of them make the cut.
    let fetch = Math.min(k + 1, MAX_SEARCH_FETCH);
    let rows = await adapter.vectorSearch(queryBuf, fetch, filter);
    const boundaryTied = (): boolean =>
      rows.length === fetch && rows[rows.length - 1]?.distance === rows[k - 1]?.distance;
    while (fetch < MAX_SEARCH_FETCH && boundaryTied()) {
      fetch = Math.min(fetch * 2, MAX_SEARCH_FETCH);
      rows = await adapter.vectorSearch(queryBuf, fetch, filter);
    }

    const top = [...rows]
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          (a.concept_id < b.concept_id ? -1 : a.concept_id > b.concept_id ? 1 : 0)
      )
      .slice(0, k);
    if (top.length === 0) return [];

    const meta = new Map(
      (await adapter.findConceptMeta(top.map(r => r.concept_id))).map(r => [r.id, r])
    );

    const results: SearchResult[] = [];
    for (const r of top) {
      const cr = meta.get(r.concept_id);
      if (!cr) continue;
      results.push({
        id: r.concept_id,
        namespace: cr.namespace,
        score: Math.min(1, Math.max(0, 1 - r.distance / 2)),
        tags: JSON.parse(cr.tags) as string[],
        representations: {
          vector: cr.has_vec === 1,
          markdown: cr.has_md === 1,
          thoughtform: cr.has_tf === 1,
        },
      });
    }
    return results;
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
}

export const conceptService = new ConceptService();
