/**
 * PolyVault shared types for serialization, transport, and sync.
 *
 * Consolidates types referenced across serializer, chunker, crypto,
 * upload, download, and CLI command modules.
 */

import type { CompressionMode } from './compress.js';
import type { EncryptionMode } from './crypto.js';

export type SerializeOptions = {
  compress: CompressionMode;
  encrypt: EncryptionMode;
  chunkSizeMaxBytes: number; // <= 1_000_000
  deterministicOrder: boolean; // default true
  stripUnknown?: boolean; // default false
};

export type SerializedChunk = {
  bundleId: string;
  commitId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  compressed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
};

export type BundleMetaInput = {
  parentCommitId: string | null;
  sinceUpdatedAtMsExclusive: number;
  authorPrincipal?: string;
  syncMode: 'backup' | 'merge' | 'rebase';
};

export type NetworkProfile = 'local' | 'ic';

export interface NetworkConfig {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrentChunkFetches: number;
  retryAttempts: number;
}

export const NETWORK_PROFILES: Record<NetworkProfile, NetworkConfig> = {
  local: {
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 20_000,
    maxConcurrentChunkFetches: 3,
    retryAttempts: 5,
  },
  ic: {
    connectTimeoutMs: 15_000,
    requestTimeoutMs: 60_000,
    maxConcurrentChunkFetches: 3,
    retryAttempts: 3,
  },
};

export function getNetworkConfig(profile: NetworkProfile): NetworkConfig {
  return NETWORK_PROFILES[profile];
}
