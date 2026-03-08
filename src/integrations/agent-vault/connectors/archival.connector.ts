import type { AgentVaultConfig } from '../config.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { logger } from '../../../logger.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export class ArchivalConnector {
  private readonly client: ArweaveUploadClient;
  private readonly tagFilter: string[];
  private readonly debounceMs: number;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private jwkLoaded = false;
  private jwkLoadError: string | null = null;

  constructor(config: AgentVaultConfig) {
    this.client = new ArweaveUploadClient(config);
    this.tagFilter = config.archival.tagFilter;
    this.debounceMs = config.archival.debounceMs;
    this.loadJwk(config.archival.arweaveJwk).catch((err: unknown) => {
      this.jwkLoadError = err instanceof Error ? err.message : String(err);
      logger.warn('av-archive jwk load failed', { error: this.jwkLoadError });
    });
  }

  private async loadJwk(jwkConfig: string | undefined): Promise<void> {
    if (!jwkConfig) {
      this.jwkLoadError = 'Arweave JWK not configured. Set archival.arweaveJwk in config.';
      return;
    }

    let jwkJson = jwkConfig;

    if (jwkConfig.startsWith('/') || jwkConfig.startsWith('./') || jwkConfig.startsWith('../')) {
      if (!existsSync(jwkConfig)) {
        throw new Error(`Arweave JWK file not found: ${jwkConfig}`);
      }
      jwkJson = await readFile(jwkConfig, 'utf-8');
    } else if (jwkConfig.startsWith('${') && jwkConfig.endsWith('}')) {
      const envVar = jwkConfig.slice(2, -1);
      const envValue = process.env[envVar];
      if (!envValue) {
        throw new Error(`Environment variable ${envVar} not set for Arweave JWK`);
      }
      if (envValue.startsWith('/') || envValue.startsWith('./')) {
        if (!existsSync(envValue)) {
          throw new Error(`Arweave JWK file not found: ${envValue}`);
        }
        jwkJson = await readFile(envValue, 'utf-8');
      } else {
        jwkJson = envValue;
      }
    }

    try {
      const jwk = JSON.parse(jwkJson) as Record<string, unknown>;
      this.client.withJwk(jwk);
      this.jwkLoaded = true;
      logger.info('av-archive jwk loaded successfully');
    } catch {
      throw new Error('Failed to parse Arweave JWK JSON');
    }
  }

  scheduleArchive(conceptId: string): void {
    if (!this.jwkLoaded) {
      logger.debug('av-archive skipped (jwk not loaded)', { conceptId, error: this.jwkLoadError });
      return;
    }

    const existing = this.pending.get(conceptId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(conceptId);
      this.archiveConcept(conceptId).catch((err: unknown) => {
        logger.error('av-archive async failed', err, { conceptId });
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

  private async archiveConcept(conceptId: string): Promise<void> {
    try {
      const concept = await conceptService.read(conceptId);

      if (this.tagFilter.length > 0) {
        const conceptTags = concept.tags ?? [];
        const passes = this.tagFilter.every(t => conceptTags.includes(t));
        if (!passes) return;
      }

      const content = concept.markdown ?? JSON.stringify(concept.thoughtform);
      if (!content) return;

      const receipt = await this.client.upload({
        content,
        contentType: concept.markdown ? 'markdown' : 'json',
        tags: concept.tags ?? [],
        metadata: {
          conceptId,
          namespace: concept.namespace ?? 'default',
          version: concept.version,
          archivedAt: Date.now(),
        },
      });

      logger.info('av-archive concept archived', {
        conceptId,
        txId: receipt.txId,
        url: receipt.url,
        sizeBytes: receipt.size,
      });
    } catch (err) {
      logger.error('av-archive failed', err, { conceptId });
    }
  }
}
