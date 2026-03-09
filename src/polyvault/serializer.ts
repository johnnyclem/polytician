import { sha256String } from './hash.js';
import type { BundleV1 } from '../schemas/bundle.js';

/**
 * Deterministic JSON serialization for PolyVault bundles.
 *
 * Guarantees: same input object always produces byte-identical output,
 * regardless of JS object key insertion order, by recursively sorting keys.
 */

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

export interface SerializeResult {
  bytes: Uint8Array;
  payloadHash: string;
}

export function serializeBundle(bundle: BundleV1): SerializeResult {
  const json = JSON.stringify(bundle, sortedReplacer);
  const bytes = new TextEncoder().encode(json);
  const payloadHash = sha256String(json);
  return { bytes, payloadHash };
}

export function deserializeBundle(bytes: Uint8Array): unknown {
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as unknown;
}

export function computeCommitHash(bundle: BundleV1): string {
  const json = JSON.stringify(bundle, sortedReplacer);
  return sha256String(json);
}
