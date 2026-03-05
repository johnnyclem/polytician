import type { AgentVaultConfig } from '../config.js';
import type { AVArweaveReceipt } from '../types.js';
import { AVHttpClient } from './http-client.js';

export class ArweaveUploadClient {
  private readonly http: AVHttpClient;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
  }

  async upload(params: {
    content: string;
    contentType: 'markdown' | 'json';
    tags: string[];
    metadata: Record<string, unknown>;
  }): Promise<AVArweaveReceipt> {
    return this.http.post<AVArweaveReceipt>('/api/archival/upload', params);
  }
}
