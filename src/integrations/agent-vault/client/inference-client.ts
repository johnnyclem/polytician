import type { AgentVaultConfig } from '../config.js';
import type { AVInferRequest, AVInferResponse } from '../types.js';
import { AVHttpClient } from './http-client.js';

export class InferenceClient {
  private readonly http: AVHttpClient;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
  }

  async infer(req: AVInferRequest): Promise<AVInferResponse> {
    // Inference changes nothing on the AgentVault side, so a transient failure can be retried.
    return this.http.post<AVInferResponse>('/api/inference', req, { retry: true });
  }
}
