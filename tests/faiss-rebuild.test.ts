import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config to control sidecarUrl
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    sidecarUrl: 'http://localhost:5001',
  })),
}));

// Mock logger to suppress output during tests
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { rebuildFaissIndex } from '../src/sidecar/faiss.js';
import { getConfig } from '../src/config.js';

describe('rebuildFaissIndex', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should POST to /rebuild-index with ids and texts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        indexed_ids: ['id-1', 'id-2'],
        total_vectors: 2,
        dimension: 384,
      }),
    });

    const result = await rebuildFaissIndex({
      ids: ['id-1', 'id-2'],
      texts: ['hello world', 'foo bar'],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:5001/rebuild-index');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      ids: ['id-1', 'id-2'],
      texts: ['hello world', 'foo bar'],
    });

    expect(result).toEqual({
      status: 'ok',
      indexed_ids: ['id-1', 'id-2'],
      total_vectors: 2,
      dimension: 384,
    });
  });

  it('should return null when sidecar is not configured', async () => {
    vi.mocked(getConfig).mockReturnValueOnce({ sidecarUrl: null } as ReturnType<typeof getConfig>);

    const result = await rebuildFaissIndex({
      ids: ['id-1'],
      texts: ['some text'],
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return null for empty id list', async () => {
    const result = await rebuildFaissIndex({ ids: [], texts: [] });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should throw when ids and texts lengths differ', async () => {
    await expect(
      rebuildFaissIndex({
        ids: ['id-1', 'id-2'],
        texts: ['only one'],
      }),
    ).rejects.toThrow('ids and texts must have the same length');
  });

  it('should throw on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"error":"Internal server error"}',
    });

    await expect(
      rebuildFaissIndex({
        ids: ['id-1'],
        texts: ['text'],
      }),
    ).rejects.toThrow('Sidecar rebuild-index returned HTTP 500');
  });

  it('should throw on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      rebuildFaissIndex({
        ids: ['id-1'],
        texts: ['text'],
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('IndexSyncService.rebuildAfterDeserialize', () => {
  // We need to mock more dependencies for IndexSyncService
  vi.mock('../src/db/client.js', () => ({
    getAdapter: vi.fn(() => ({
      upsertVector: vi.fn(),
      deleteVector: vi.fn(),
    })),
  }));

  vi.mock('../src/events/concept-events.js', () => ({
    conceptEventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
  }));

  // Dynamically import after mocks are set up
  let IndexSyncService: typeof import('../src/services/index-sync.service.js').IndexSyncService;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.mocked(getConfig).mockReturnValue({
      sidecarUrl: 'http://localhost:5001',
    } as ReturnType<typeof getConfig>);

    const mod = await import('../src/services/index-sync.service.js');
    IndexSyncService = mod.IndexSyncService;
  });

  it('should call rebuildFaissIndex with mapped entries', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        indexed_ids: ['tf-1', 'tf-2'],
        total_vectors: 2,
        dimension: 384,
      }),
    });

    const service = new IndexSyncService();
    await service.rebuildAfterDeserialize([
      { id: 'tf-1', text: 'first concept' },
      { id: 'tf-2', text: 'second concept' },
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.ids).toEqual(['tf-1', 'tf-2']);
    expect(body.texts).toEqual(['first concept', 'second concept']);
  });

  it('should skip rebuild for empty entries', async () => {
    const service = new IndexSyncService();
    await service.rebuildAfterDeserialize([]);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not throw when sidecar fails (best-effort)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('sidecar down'));

    const service = new IndexSyncService();
    // Should not throw — errors are logged
    await service.rebuildAfterDeserialize([
      { id: 'tf-1', text: 'some text' },
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
