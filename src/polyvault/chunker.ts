import { sha256 } from './hash.js';

export const MAX_CHUNK_SIZE = 1_000_000;

export interface ChunkData {
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  payload: Uint8Array;
}

export interface ChunkOptions {
  maxChunkSize?: number;
}

export function chunkPayload(data: Uint8Array, options?: ChunkOptions): ChunkData[] {
  const maxSize = options?.maxChunkSize ?? MAX_CHUNK_SIZE;
  if (maxSize < 1 || maxSize > MAX_CHUNK_SIZE) {
    throw new Error(`maxChunkSize must be between 1 and ${MAX_CHUNK_SIZE}`);
  }

  const chunkCount = Math.max(1, Math.ceil(data.length / maxSize));
  const chunks: ChunkData[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * maxSize;
    const end = Math.min(start + maxSize, data.length);
    const payload = data.slice(start, end);
    chunks.push({
      chunkIndex: i,
      chunkCount,
      chunkHash: sha256(payload),
      payload,
    });
  }

  return chunks;
}

export class ChunkIntegrityError extends Error {
  constructor(
    public readonly chunkIndex: number,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`Chunk ${chunkIndex} hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ChunkIntegrityError';
  }
}

export class ChunkReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkReassemblyError';
  }
}

export interface ReassembleInput {
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  payload: Uint8Array;
}

export function reassembleChunks(chunks: ReassembleInput[]): Uint8Array {
  if (chunks.length === 0) {
    throw new ChunkReassemblyError('No chunks provided');
  }

  const expectedCount = chunks[0]!.chunkCount;
  if (chunks.length !== expectedCount) {
    throw new ChunkReassemblyError(
      `Expected ${expectedCount} chunks, received ${chunks.length}`
    );
  }

  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i]!;
    if (chunk.chunkIndex !== i) {
      throw new ChunkReassemblyError(
        `Missing chunk at index ${i}`
      );
    }
    if (chunk.chunkCount !== expectedCount) {
      throw new ChunkReassemblyError(
        `Inconsistent chunkCount: expected ${expectedCount}, chunk ${i} has ${chunk.chunkCount}`
      );
    }
    const actualHash = sha256(chunk.payload);
    if (actualHash !== chunk.chunkHash) {
      throw new ChunkIntegrityError(i, chunk.chunkHash, actualHash);
    }
  }

  const totalLength = sorted.reduce((sum, c) => sum + c.payload.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of sorted) {
    result.set(chunk.payload, offset);
    offset += chunk.payload.length;
  }

  return result;
}
