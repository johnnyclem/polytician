/**
 * Database adapter interface — abstracts over SQLite and PostgreSQL backends.
 *
 * Each method maps to the operations ConceptService needs.
 * Implementations handle dialect-specific SQL, vector extensions,
 * and serialization differences.
 */

export interface ConceptRow {
  id: string;
  namespace: string;
  version: number;
  created_at: number;
  updated_at: number;
  tags: string; // JSON-encoded string[]
  markdown: string | null;
  thoughtform: string | null;
  embedding: Buffer | null;
  /**
   * Embedding model the vector belongs to (the server's configured model when
   * it was written); null when there is no vector. Vectors from before 3.0
   * are labelled with the model configured on the first 3.0 start.
   */
  embedding_model?: string | null;
  /** JSON-encoded DerivedMap; rows written before 3.0 read back as '{}'. */
  derived?: string;
}

/** Columns ConceptService may change on update. */
export type ConceptUpdateFields = Partial<
  Pick<
    ConceptRow,
    | 'version'
    | 'updated_at'
    | 'tags'
    | 'markdown'
    | 'thoughtform'
    | 'embedding'
    | 'embedding_model'
    | 'derived'
  >
>;

/**
 * One write in an atomic batch. Every kind keeps the vector index in step
 * with `concepts.embedding` inside the same transaction.
 */
export type ConceptWrite =
  /** Insert a new row (and its vector); fails the batch if the id exists. */
  | { kind: 'insert'; row: ConceptRow }
  /**
   * Update a row whose version is still `expectedVersion`; fails the batch
   * otherwise. If `fields.embedding` is set, the vector is replaced (Buffer)
   * or removed (null) in the concept's `namespace` partition.
   */
  | {
      kind: 'update';
      id: string;
      namespace: string;
      expectedVersion: number;
      fields: ConceptUpdateFields;
    }
  /** Delete a row and its vector; fails the batch if no row matches (id, namespace?). */
  | { kind: 'delete'; id: string; namespace?: string };

/** `index` is the first write whose precondition failed; nothing was applied. */
export type WriteOutcome = { ok: true } | { ok: false; index: number };

/**
 * Which concepts a vector search may return. Filters are applied inside the
 * KNN query, so the top-k is the top-k of the matching rows.
 */
export interface VectorFilter {
  /** Namespaces to search, or null for all namespaces. */
  namespaces: readonly string[] | null;
  /** Every tag must be present on the concept (exact match). */
  tags?: readonly string[];
}

export interface ListRow {
  id: string;
  namespace: string;
  version: number;
  created_at: number;
  updated_at: number;
  tags: string;
  has_md: number;
  has_tf: number;
  has_vec: number;
}

export interface VectorResult {
  concept_id: string;
  /** Cosine distance, 1 - cosine similarity, in [0, 2]. */
  distance: number;
}

export interface ConceptMetaRow {
  id: string;
  namespace: string;
  tags: string;
  has_md: number;
  has_tf: number;
  has_vec: number;
}

export interface StatsResult {
  conceptCount: number;
  vectorCount: number;
  mdCount: number;
  tfCount: number;
  vecCount: number;
}

export interface DatabaseAdapter {
  /** Set up tables, indexes, extensions. Idempotent. */
  initialize(): void | Promise<void>;

  /** Tear down the connection. */
  close(): void | Promise<void>;

  // --- Concept CRUD ---

  findConcept(id: string): ConceptRow | null | Promise<ConceptRow | null>;

  /**
   * Apply writes atomically: all of them, or none if any precondition fails
   * (outcome ok:false) or any statement throws (rethrown after rollback).
   */
  applyWrites(writes: ConceptWrite[]): WriteOutcome | Promise<WriteOutcome>;

  /** Unconditional insert without a vector (PolyVault import path). */
  insertConcept(row: ConceptRow): void | Promise<void>;

  /** Unconditional update without vector sync (PolyVault import path). */
  updateConcept(id: string, fields: ConceptUpdateFields): void | Promise<void>;

  deleteConcept(id: string): void | Promise<void>;

  // --- Listing ---

  listConcepts(params: {
    limit: number;
    offset: number;
    tags?: string[];
    namespace?: string;
  }): { rows: ListRow[]; total: number } | Promise<{ rows: ListRow[]; total: number }>;

  // --- Vector operations ---

  upsertVector(id: string, namespace: string, embedding: Buffer): void | Promise<void>;

  deleteVector(id: string): void | Promise<void>;

  /** k nearest rows by cosine distance among those matching `filter`, closest first. */
  vectorSearch(
    queryEmbedding: Buffer,
    k: number,
    filter: VectorFilter
  ): VectorResult[] | Promise<VectorResult[]>;

  // --- Embedding models ---

  /**
   * Vectors in `namespaces` (null: every namespace) not recorded as made by
   * `model`, including vectors with no recorded model.
   */
  countForeignVectors(
    model: string,
    namespaces: readonly string[] | null
  ): number | Promise<number>;

  /** Up to `limit` ids, in id order after `afterId`, of concepts in `namespace` with such a vector. */
  findForeignVectors(
    model: string,
    namespace: string,
    afterId: string | null,
    limit: number
  ): string[] | Promise<string[]>;

  /**
   * Label vectors stored before 3.0, which carry no model, with `model`.
   * Runs once per database; returns the number of vectors labelled.
   */
  labelLegacyVectors(model: string): number | Promise<number>;

  // --- Concept metadata (for search result enrichment) ---

  findConceptMeta(ids: string[]): ConceptMetaRow[] | Promise<ConceptMetaRow[]>;

  // --- Stats ---

  getStats(namespace?: string): StatsResult | Promise<StatsResult>;

  // --- Metadata (key-value store for internal bookkeeping) ---

  getMetadata(key: string): string | null | Promise<string | null>;

  setMetadata(key: string, value: string): void | Promise<void>;
}
