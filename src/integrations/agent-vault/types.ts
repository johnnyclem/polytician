/** AgentVault inference request — mirrors InferenceFallbackChain.infer() contract. */
export interface AVInferRequest {
  prompt: string;
  preferredBackend?: 'bittensor' | 'venice' | 'local';
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface AVInferResponse {
  text: string;
  backend: string;
  latencyMs: number;
}

/** AgentVault memory_repo commit. */
export interface AVMemoryCommit {
  sha: string;
  branch: string;
  author: string;
  timestamp: number;
  message: string;
  entries: AVMemoryEntry[];
}

export interface AVMemoryEntry {
  key: string;
  contentType: 'markdown' | 'json' | 'binary';
  data: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface AVMemoryBranchState {
  branch: string;
  headSha: string;
  entries: AVMemoryEntry[];
}

/** Arweave archive receipt. */
export interface AVArweaveReceipt {
  txId: string;
  url: string;
  timestamp: number;
  tags: string[];
  size: number;
}

/** Secret retrieval result. */
export interface AVSecretResult {
  name: string;
  value: string;
  provider: 'hashicorp' | 'bitwarden' | 'icp-vetkd';
  rotatedAt?: number;
}

/** Error payload from AgentVault REST API. */
export interface AVErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}
