/**
 * FAISS rebuild client — calls the Python sidecar's /polyvault/faiss/rebuild endpoint.
 *
 * Provides a typed interface for triggering FAISS index rebuilds after restore,
 * abstracting over the HTTP call to the Python sidecar.
 */

import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';

export type FaissRebuildMode = 'replace' | 'upsert';

export interface FaissRebuildResult {
  rebuilt: boolean;
  vectorCount: number;
}

export interface FaissRebuildClient {
  rebuildIndex(
    thoughtforms: ThoughtFormV1[],
    mode: FaissRebuildMode,
  ): Promise<FaissRebuildResult>;
}

export class FaissRebuildError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
  ) {
    super(`FAISS rebuild failed (${statusCode}): ${reason}`);
    this.name = 'FaissRebuildError';
  }
}

/**
 * Create a FaissRebuildClient that calls the Python sidecar HTTP endpoint.
 */
export function createFaissRebuildClient(sidecarUrl: string): FaissRebuildClient {
  return {
    async rebuildIndex(
      thoughtforms: ThoughtFormV1[],
      mode: FaissRebuildMode,
    ): Promise<FaissRebuildResult> {
      const url = `${sidecarUrl.replace(/\/+$/, '')}/polyvault/faiss/rebuild`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thoughtforms, mode }),
      });

      if (!response.ok) {
        const body = await response.text();
        let reason = body;
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) reason = parsed.error;
        } catch {
          // use raw body
        }
        throw new FaissRebuildError(response.status, reason);
      }

      const result = (await response.json()) as FaissRebuildResult;
      return { rebuilt: result.rebuilt, vectorCount: result.vectorCount };
    },
  };
}
