import type { AgentVaultConfig } from '../config.js';
import type { AVArweaveReceipt } from '../types.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { expandConfigValue } from '../../../config.js';
import { requireBackupKey, type BackupKey } from '../../../backup/key.js';
import { CIPHER_NAME, newNonce, openBytes, sealBytes } from '../../../backup/seal.js';
import { ValidationError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const ARCHIVE_FORMAT = 'polytician-archive';

export type ArchiveOutcome =
  | { archived: true; receipt: AVArweaveReceipt }
  | { archived: false; reason: 'not-tagged' | 'no-content' | 'already-archived' };

/**
 * What is uploaded to Arweave: the concept sealed with AES-256-GCM under the
 * backup key. Only the concept id, its version and the key fingerprint are
 * readable on-chain; tags, namespace and content are inside the ciphertext.
 */
export interface ArchiveEnvelope {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: 1;
  alg: typeof CIPHER_NAME;
  keyId: string;
  nonce: string;
  aad: string;
  ciphertext: string;
}

export interface ArchivedConcept {
  id: string;
  namespace: string;
  version: number;
  updatedAt: number;
  tags: string[];
  markdown: string | null;
  thoughtform: unknown;
}

function archiveAad(conceptId: string, version: number): string {
  return `${ARCHIVE_FORMAT}/1:${conceptId}:${version}`;
}

export function sealArchive(concept: ArchivedConcept, key: BackupKey): ArchiveEnvelope {
  const nonce = newNonce();
  const aad = archiveAad(concept.id, concept.version);
  const sealed = sealBytes(Buffer.from(JSON.stringify(concept), 'utf-8'), key.key, nonce, aad);
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: 1,
    alg: CIPHER_NAME,
    keyId: key.keyId,
    nonce: nonce.toString('base64'),
    aad,
    ciphertext: sealed.toString('base64'),
  };
}

/** Decrypt an archive downloaded from Arweave with the backup key it was sealed with. */
export function openArchive(envelope: ArchiveEnvelope, key: BackupKey): ArchivedConcept {
  if (envelope.keyId !== key.keyId) {
    throw new ValidationError(
      `This archive was encrypted with key ${envelope.keyId}, but the given key is ${key.keyId}`
    );
  }
  const plaintext = openBytes(
    Buffer.from(envelope.ciphertext, 'base64'),
    key.key,
    Buffer.from(envelope.nonce, 'base64'),
    envelope.aad
  );
  return JSON.parse(plaintext.toString('utf-8')) as ArchivedConcept;
}

/**
 * Archives concepts to Arweave (permanent and public) through AgentVault.
 * Only concepts carrying every tag in archival.tagFilter (which the config
 * requires to be non-empty) are archived, always encrypted with the backup
 * key; constructing a connector without a key configured throws.
 */
export class ArchivalConnector {
  private readonly client: ArweaveUploadClient;
  private readonly tagFilter: string[];
  private readonly debounceMs: number;
  private readonly key: BackupKey;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last version archived per concept by this process, so a version is uploaded once. */
  private readonly archivedVersion = new Map<string, number>();
  /**
   * Uploads in progress, by `<conceptId>@<version>`. Reserved before the
   * first await of an upload, so an overlapping archive of the same version
   * (a tool call and the event bridge's timer) waits for it instead of
   * uploading the version a second time.
   */
  private readonly uploading = new Map<string, Promise<AVArweaveReceipt>>();
  private readonly jwkReady: Promise<boolean>;

  constructor(config: AgentVaultConfig) {
    this.tagFilter = config.archival.tagFilter;
    if (this.tagFilter.length === 0) {
      throw new ValidationError('Arweave archival requires a non-empty archival.tagFilter');
    }
    this.key = requireBackupKey('Arweave archival');
    this.client = new ArweaveUploadClient(config);
    this.debounceMs = config.archival.debounceMs;
    this.jwkReady = this.loadJwk(config.archival.arweaveJwk).then(
      () => true,
      (err: unknown) => {
        logger.warn('av-archive jwk load failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    );
  }

  private async loadJwk(jwkConfig: string | undefined): Promise<void> {
    if (!jwkConfig) {
      throw new Error('Arweave JWK not configured. Set archival.arweaveJwk in the config file.');
    }

    let jwkJson = jwkConfig.startsWith('${')
      ? expandConfigValue(jwkConfig, 'agentVault.archival.arweaveJwk')
      : jwkConfig;
    if (jwkJson.startsWith('/') || jwkJson.startsWith('./') || jwkJson.startsWith('../')) {
      if (!existsSync(jwkJson)) throw new Error(`Arweave JWK file not found: ${jwkJson}`);
      jwkJson = await readFile(jwkJson, 'utf-8');
    }

    let jwk: Record<string, unknown>;
    try {
      jwk = JSON.parse(jwkJson) as Record<string, unknown>;
    } catch {
      throw new Error('Failed to parse Arweave JWK JSON');
    }
    this.client.withJwk(jwk);
    logger.info('av-archive jwk loaded');
  }

  /** Whether a concept carrying `tags` is in scope for archival. */
  matches(tags: readonly string[]): boolean {
    return this.tagFilter.every(t => tags.includes(t));
  }

  scheduleArchive(conceptId: string): void {
    const existing = this.pending.get(conceptId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(conceptId);
      this.archive(conceptId).catch((err: unknown) => {
        logger.error('av-archive failed', err, { conceptId });
      });
    }, this.debounceMs);

    this.pending.set(conceptId, timer);
  }

  cancelPending(conceptId: string): void {
    const timer = this.pending.get(conceptId);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(conceptId);
    }
  }

  /**
   * Archive the current version of a concept if it carries every filter tag
   * and that version has not been archived by this process yet.
   */
  async archive(conceptId: string, namespace?: string): Promise<ArchiveOutcome> {
    if (!(await this.jwkReady)) {
      throw new Error('Arweave archival is unavailable: the JWK wallet could not be loaded');
    }
    const concept = await conceptService.read(
      conceptId,
      undefined,
      namespace !== undefined ? { namespace } : undefined
    );
    const tags = concept.tags ?? [];
    if (!this.matches(tags)) return { archived: false, reason: 'not-tagged' };
    if (concept.markdown === undefined && concept.thoughtform === undefined) {
      return { archived: false, reason: 'no-content' };
    }
    const version = concept.version ?? 1;
    if (this.archivedVersion.get(conceptId) === version) {
      return { archived: false, reason: 'already-archived' };
    }
    const slot = `${conceptId}@${version}`;
    const inFlight = this.uploading.get(slot);
    if (inFlight) {
      // Rejects if that upload failed, so the caller does not report it archived.
      await inFlight;
      return { archived: false, reason: 'already-archived' };
    }

    const envelope = sealArchive(
      {
        id: concept.id,
        namespace: concept.namespace ?? 'default',
        version,
        updatedAt: concept.updatedAt ?? 0,
        tags,
        markdown: concept.markdown ?? null,
        thoughtform: concept.thoughtform ?? null,
      },
      this.key
    );
    const upload = this.client.upload({
      content: JSON.stringify(envelope),
      contentType: 'json',
      tags: [],
      metadata: { conceptId, version, encrypted: true, archivedAt: Date.now() },
    });
    this.uploading.set(slot, upload);
    let receipt: AVArweaveReceipt;
    try {
      receipt = await upload;
    } finally {
      this.uploading.delete(slot);
    }
    this.archivedVersion.set(conceptId, version);

    logger.info('av-archive concept archived', {
      conceptId,
      version,
      txId: receipt.txId,
      url: receipt.url,
      sizeBytes: receipt.size,
    });
    return { archived: true, receipt };
  }
}

let shared: ArchivalConnector | null = null;

/** One connector per process, shared by the event bridge and vault_archive_concept. */
export function sharedArchivalConnector(config: AgentVaultConfig): ArchivalConnector {
  shared ??= new ArchivalConnector(config);
  return shared;
}

/** For tests. */
export function resetSharedArchivalConnector(): void {
  shared = null;
}
