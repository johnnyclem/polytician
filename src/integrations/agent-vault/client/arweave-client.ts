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
  private readonly timeoutMs: number;
  private jwk: Record<string, unknown> | null = null;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
    this.timeoutMs = config.archival.timeoutMs;
  }

  withJwk(jwk: Record<string, unknown>): this {
    this.jwk = jwk;
    return this;
  }

  async upload(params: ArweaveUploadParams): Promise<AVArweaveReceipt> {
    if (!this.jwk) {
      throw new Error(
        'Arweave JWK wallet not configured. Set agentVault.archival.arweaveJwk in the config file.'
      );
    }

    const tagRecord: Record<string, string> = {
      'Content-Type': params.contentType === 'markdown' ? 'text/markdown' : 'application/json',
    };
    for (const tag of params.tags) {
      tagRecord[`tag-${tag}`] = 'true';
    }

    // Sent once: an upload is never retried (see AVHttpClient), so the wallet
    // travels with exactly one request and a timeout never mints a second copy.
    return this.http.post<AVArweaveReceipt>(
      '/api/archival/upload',
      {
        data: params.content,
        tags: tagRecord,
        metadata: params.metadata,
        jwk: this.jwk,
      },
      { timeoutMs: this.timeoutMs }
    );
  }
}
