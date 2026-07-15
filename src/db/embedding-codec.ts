/**
 * Shared Float32 (de)serialization for embedding vectors stored as BLOBs.
 *
 * Every layer that reads or writes the `concepts.embedding` column or the
 * vector index must use these helpers so the binary layout stays consistent.
 */

export function serializeEmbedding(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding);
  return Buffer.from(floats.buffer);
}

export function deserializeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}
