/**
 * Database adapter interface — abstracts over SQLite and PostgreSQL backends.
 *
 * Each method maps to the operations ConceptService needs.
 * Implementations handle dialect-specific SQL, vector extensions,
 * and serialization differences.
 */

export interface ConceptRow {
  id: string;
  created_at: number;
  updated_at: number;
  tags: string; // JSON-encoded string[]
  markdown: string | null;
  thoughtform: string | null;
  embedding: Buffer | null;
}

export interface ListRow {
  id: string;
  created_at: number;
  updated_at: number;
  tags: string;
  has_md: number;
  has_tf: number;
  has_vec: number;
}

export interface VectorResult {
  concept_id: string;
  distance: number;
}

export interface ConceptMetaRow {
  id: string;
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

  insertConcept(row: ConceptRow): void | Promise<void>;

  updateConcept(id: string, fields: Record<string, unknown>): void | Promise<void>;

  deleteConcept(id: string): void | Promise<void>;

  // --- Listing ---

  listConcepts(params: {
    limit: number;
    offset: number;
    tags?: string[];
  }): { rows: ListRow[]; total: number } | Promise<{ rows: ListRow[]; total: number }>;

  // --- Vector operations ---

  upsertVector(id: string, embedding: Buffer): void | Promise<void>;

  deleteVector(id: string): void | Promise<void>;

  vectorSearch(queryEmbedding: Buffer, k: number): VectorResult[] | Promise<VectorResult[]>;

  // --- Concept metadata (for search result enrichment) ---

  findConceptMeta(ids: string[]): ConceptMetaRow[] | Promise<ConceptMetaRow[]>;

  // --- Stats ---

  getStats(): StatsResult | Promise<StatsResult>;
}
