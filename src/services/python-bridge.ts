/**
 * Python Sidecar Bridge
 *
 * Manages the Python subprocess and provides HTTP client for ML operations.
 * Auto-spawns on MCP server start, kills on shutdown.
 * Enhanced with circuit breaker for resilience.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NetworkError,
  TimeoutError,
  MLServiceError,
  SystemError,
  logError,
  ErrorHandler,
} from '../errors/index.js';
import { circuitBreakerManager, CircuitBreakerOpenError } from '../utils/circuit-breaker.js';
import { metricsCollector, monitorPerformance } from '../utils/metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIDECAR_HOST = '127.0.0.1';
const SIDECAR_PORT = 8787;
const SIDECAR_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;
const HEALTH_CHECK_INTERVAL = 1000; // ms
const MAX_STARTUP_WAIT = 60000; // 60 seconds for model loading
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

interface EmbedResponse {
  vector: number[];
  dimension: number;
}

interface NERResponse {
  entities: Array<{
    id: string;
    text: string;
    type: string;
    confidence: number;
    offset: { start: number; end: number };
  }>;
  relationships: Array<{
    subjectId: string;
    predicate: string;
    objectId: string;
    confidence?: number;
  }>;
  context_graph: Record<string, string[]>;
}

interface SearchResponse {
  neighbors: Array<{
    id: string;
    distance: number;
  }>;
  query_dimension: number;
}

interface HealthResponse {
  status: string;
  services: Record<string, boolean>;
  index_stats: Record<string, unknown>;
}

interface SummarizeResponse {
  markdown: string;
}

class PythonBridge {
  private process: ChildProcess | null = null;
  private isReady = false;
  private startupPromise: Promise<void> | null = null;
  private readonly httpCircuitBreaker = circuitBreakerManager.getBreaker('python-bridge', {
    failureThreshold: 3,
    timeoutDuration: 30000,  // 30 seconds
    resetTimeout: 60000,     // 1 minute
    onOpen: () => console.warn('Python sidecar circuit breaker OPENED'),
    onHalfOpen: () => console.info('Python sidecar circuit breaker HALF-OPEN'),
    onClose: () => console.info('Python sidecar circuit breaker CLOSED'),
  });

  /**
   * Start the Python sidecar subprocess
   */
  async start(): Promise<void> {
    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = this._doStart();
    return this.startupPromise;
  }

  private async _doStart(): Promise<void> {
    // Check if already running
    if (await this.healthCheck()) {
      console.log('Python sidecar already running');
      this.isReady = true;
      return;
    }

    const sidecarPath = join(__dirname, '../../python-sidecar');

    console.log('Starting Python sidecar...');

    this.process = spawn('python', ['main.py'], {
      cwd: sidecarPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Log stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[sidecar] ${data.toString().trim()}`);
    });

    // Log stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[sidecar:err] ${data.toString().trim()}`);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`Python sidecar exited with code ${code}, signal ${signal}`);
      this.isReady = false;
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error('Failed to start Python sidecar:', err);
      this.isReady = false;
    });

    // Wait for sidecar to be ready
    await this.waitForReady();
  }

  private async waitForReady(): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_STARTUP_WAIT) {
      if (await this.healthCheck()) {
        console.log('Python sidecar is ready');
        this.isReady = true;
        return;
      }
      await this.sleep(HEALTH_CHECK_INTERVAL);
    }

    throw new Error(
      `Python sidecar failed to start within ${MAX_STARTUP_WAIT}ms`
    );
  }

  /**
   * Stop the Python sidecar subprocess
   */
  async stop(): Promise<void> {
    if (this.process) {
      console.log('Stopping Python sidecar...');
      this.process.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.isReady = false;
      this.startupPromise = null;
      
      // Close circuit breaker when shutting down
      this.httpCircuitBreaker.close();
      console.log('Python sidecar stopped');
    }
  }

  /**
   * Check if sidecar is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${SIDECAR_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ensure sidecar is running before making requests
   */
  private async ensureReady(): Promise<void> {
    if (!this.isReady) {
      await this.start();
    }
  }

  /**
   * Make HTTP request with circuit breaker protection
   */
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: unknown
  ): Promise<T> {
    return this.httpCircuitBreaker.execute(async () => {
      await this.ensureReady();

      try {
        const response = await fetch(`${SIDECAR_URL}${endpoint}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(120000), // 2 minute timeout for embedding
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new MLServiceError(
            `Sidecar error: ${response.status} - ${errorText}`,
            'python-sidecar',
            endpoint
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        // Check if this is a circuit breaker error
        if (error instanceof CircuitBreakerOpenError) {
          throw error; // Re-throw circuit breaker error
        }

        // Log the error but let circuit breaker handle retry logic
        throw error;
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============ Public API ============

  /**
   * Generate embedding vector for text
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.request<EmbedResponse>('/embed', 'POST', {
      text,
    });
    return response.vector;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.request<{ vectors: number[][] }>('/embed-batch', 'POST', {
      texts,
    });
    return response.vectors;
  }

  /**
   * Extract named entities from text
   */
  async extractNER(text: string): Promise<NERResponse> {
    return this.request<NERResponse>('/extract-ner', 'POST', { text });
  }

  /**
   * Search for nearest neighbors
   */
  async searchNN(vector: number[], k = 5): Promise<SearchResponse['neighbors']> {
    const response = await this.request<SearchResponse>('/search-nn', 'POST', {
      vector,
      k,
    });
    return response.neighbors;
  }

  /**
   * Add vector to FAISS index
   */
  async addToIndex(conceptId: string, vector: number[]): Promise<boolean> {
    const response = await this.request<{ success: boolean }>('/index/add', 'POST', {
      concept_id: conceptId,
      vector,
    });
    return response.success;
  }

  /**
   * Remove vector from FAISS index
   */
  async removeFromIndex(conceptId: string): Promise<boolean> {
    const response = await this.request<{ success: boolean }>('/index/remove', 'POST', {
      concept_id: conceptId,
    });
    return response.success;
  }

  /**
   * Get FAISS index statistics
   */
  async getIndexStats(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/index/stats', 'GET');
  }

  /**
   * Generate markdown summary from concept data
   */
  async summarize(
    conceptIds: string[],
    texts?: string[]
  ): Promise<string> {
    const response = await this.request<SummarizeResponse>('/summarize', 'POST', {
      concept_ids: conceptIds,
      texts,
    });
    return response.markdown;
  }

  /**
   * Get health status
   */
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health', 'GET');
  }

  /**
   * Get circuit breaker statistics
   */
  getCircuitBreakerStats() {
    return {
      httpCircuitBreaker: this.httpCircuitBreaker.getStats(),
      allStats: circuitBreakerManager.getAllStats(),
    };
  }
}

// Singleton instance
export const pythonBridge = new PythonBridge();

  /**
   * Get circuit breaker statistics
   */
  getCircuitBreakerStats() {
    return {
      httpCircuitBreaker: this.httpCircuitBreaker.getStats(),
      allStats: circuitBreakerManager.getAllStats(),
    };
  }
}

// Singleton instance
export const pythonBridge = new PythonBridge();