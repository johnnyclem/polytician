/**
 * Input size caps enforced at every write boundary (MCP tools and ConceptService).
 * They bound memory per request; they are not storage quotas.
 */
export const LIMITS = {
  /** Characters of markdown per concept. */
  markdownChars: 1_000_000,
  /** Characters of a thoughtform once serialized to JSON. */
  thoughtformChars: 2_000_000,
  /** Tags per concept (per write, and after merging on update). */
  tags: 64,
  /** Characters per tag. */
  tagChars: 128,
  /** Entries per batch_save_concepts call. */
  batchEntries: 500,
  /** Characters of text passed to the embedder (search query, embed_text). */
  queryChars: 100_000,
} as const;

/** Largest finite float32. Larger magnitudes overflow to Infinity when stored. */
export const FLOAT32_MAX = 3.4028234663852886e38;

/** Namespace names: start alphanumeric, then up to 63 of `A-Z a-z 0-9 . _ : -` (no commas or spaces). */
export const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
