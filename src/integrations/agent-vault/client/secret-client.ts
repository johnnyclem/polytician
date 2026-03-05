import type { AgentVaultConfig } from '../config.js';
import type { AVSecretResult } from '../types.js';
import { AVHttpClient } from './http-client.js';

export class SecretClient {
  private readonly http: AVHttpClient;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
  }

  async getSecret(name: string): Promise<AVSecretResult> {
    return this.http.get<AVSecretResult>(`/api/secrets/${encodeURIComponent(name)}`);
  }
}
