import type { AgentVaultConfig } from '../config.js';
import type { AVArweaveReceipt } from '../types.js';
import { AVHttpClient } from './http-client.js';

export interface ArweaveUploadParams {
  content: string;
  contentType: 'markdown' | 'json';
  tags: string[];
  metadata: Record<string, unknown>;
}

export class ArweaveUploadClient {
  private readonly http: AVHttpClient;
  private jwk: Record<string, unknown> | null = null;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
  }

  withJwk(jwk: Record<string, unknown>): this {
    this.jwk = jwk;
    return this;
  }

  async upload(params: ArweaveUploadParams): Promise<AVArweaveReceipt> {
    if (!this.jwk) {
      throw new Error(
        'Arweave JWK wallet not configured. Set AGENTVAULT_ARWEAVE_JWK env var or call withJwk().'
      );
    }

    const tagRecord: Record<string, string> = {
      'Content-Type': params.contentType === 'markdown' ? 'text/markdown' : 'application/json',
    };
    for (const tag of params.tags) {
      tagRecord[`tag-${tag}`] = 'true';
    }

    return this.http.post<AVArweaveReceipt>('/api/archival/upload', {
      data: params.content,
      tags: tagRecord,
      metadata: params.metadata,
      jwk: this.jwk,
    });
  }
}
