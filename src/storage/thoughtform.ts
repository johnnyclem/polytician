import { gzipSync } from 'node:zlib';
import type { ThoughtForm } from '../types/thoughtform.js';

export interface SerializedBundle {
  /** Raw JSON string of the ThoughtForm array. */
  json: string;
  /** Gzip-compressed buffer (null when compress is false). */
  compressed: Buffer | null;
  /** Byte length of the raw JSON string (UTF-8). */
  rawSize: number;
  /** Byte length of the compressed buffer (0 when not compressed). */
  compressedSize: number;
}

/**
 * Serialize an array of ThoughtForms into a JSON bundle with optional gzip
 * compression via Node's built-in zlib.
 */
export function serializeBundle(
  thoughtforms: ThoughtForm[],
  compress: boolean = true,
): SerializedBundle {
  const json = JSON.stringify(thoughtforms);
  const rawSize = Buffer.byteLength(json, 'utf8');

  if (!compress) {
    return { json, compressed: null, rawSize, compressedSize: 0 };
  }

  const compressed = gzipSync(Buffer.from(json, 'utf8'));
  return { json, compressed, rawSize, compressedSize: compressed.byteLength };
}
