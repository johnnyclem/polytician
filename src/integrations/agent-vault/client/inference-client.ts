import type { AgentVaultConfig } from '../config.js';
import type { AVInferRequest, AVInferResponse } from '../types.js';
import { AVHttpClient } from './http-client.js';

export class InferenceClient {
  private readonly http: AVHttpClient;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
  }

  async infer(req: AVInferRequest): Promise<AVInferResponse> {
    return this.http.post<AVInferResponse>('/api/inference', req);
  }
}
