import type { AgentVaultConfig } from '../config.js';
import type { AVMemoryEntry, AVMemoryCommit, AVMemoryBranchState } from '../types.js';
import { AVHttpClient } from './http-client.js';

export class MemoryRepoClient {
  private readonly http: AVHttpClient;
  private readonly branch: string;

  constructor(config: AgentVaultConfig) {
    this.http = new AVHttpClient(config);
    this.branch = config.memoryRepoBranch;
  }

  async getBranchState(): Promise<AVMemoryBranchState> {
    return this.http.get<AVMemoryBranchState>(
      `/api/memory-repo/branches/${encodeURIComponent(this.branch)}`
    );
  }

  async commit(message: string, entries: AVMemoryEntry[]): Promise<AVMemoryCommit> {
    return this.http.post<AVMemoryCommit>('/api/memory-repo/commits', {
      branch: this.branch,
      message,
      entries,
    });
  }

  async tombstone(key: string): Promise<void> {
    await this.http.post<void>('/api/memory-repo/tombstone', {
      branch: this.branch,
      key,
    });
  }
}
