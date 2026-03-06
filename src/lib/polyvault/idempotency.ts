import { sha256String } from '../../polyvault/hash.js';

/**
 * Generate an idempotency key for a chunk upload.
 *
 * Per PRD: sha256(commitId:chunkIndex:chunkHash)
 * This ensures repeated uploads of the same chunk are safely deduplicated.
 */
export function idempotencyKey(commitId: string, chunkIndex: number, chunkHash: string): string {
  return sha256String(`${commitId}:${chunkIndex}:${chunkHash}`);
}
