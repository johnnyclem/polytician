/**
 * A row's `tags` column as an array of strings. 3.0 stores a JSON array;
 * rows from 2.x can hold that array JSON-encoded a second time (a 2.x
 * `agentvault-sync restore` of an auto-backup stored them so) or NULL. Both
 * read as the array they mean; anything else that is not an array reads as [].
 */
export function parseTags(raw: string | null | undefined): string[] {
  let value: unknown = raw ?? '[]';
  for (let depth = 0; typeof value === 'string' && depth < 3; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * The JSON to store for a `tags` column that is not a JSON array of strings,
 * or null when it already is one. Used by the first-start migration.
 */
export function repairedTags(raw: string | null): string | null {
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value) && value.every(t => typeof t === 'string')) return null;
    } catch {
      // Not JSON: rewritten below.
    }
  }
  return JSON.stringify(parseTags(raw));
}
