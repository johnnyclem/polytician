import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AVHttpClient, AVHttpError } from '../src/integrations/agent-vault/client/http-client.js';
import type { AgentVaultConfig } from '../src/integrations/agent-vault/config.js';

const mockConfig: AgentVaultConfig = {
  apiBaseUrl: 'https://api.agentvault.test',
  apiToken: 'test-token',
  memoryRepoBranch: 'test-branch',
  inference: { timeoutMs: 5000, maxRetries: 1 },
  secrets: {},
  sync: { enabled: false, direction: 'push', pullIntervalMs: 0 },
  archival: { enabled: false, tagFilter: [], debounceMs: 1000 },
};

describe('AVHttpClient', () => {
  let client: AVHttpClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new AVHttpClient(mockConfig);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('response unwrapping', () => {
    it('should unwrap { success: true, data: ... } responses', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { text: 'hello', backend: 'venice', latencyMs: 100 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const result = await client.post('/api/inference', { prompt: 'test' });
      expect(result).toEqual({ text: 'hello', backend: 'venice', latencyMs: 100 });
    });

    it('should return raw response if not wrapped in success envelope', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ branch: 'main', headSha: 'abc123', entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.get('/api/memory-repo/branches/main');
      expect(result).toEqual({ branch: 'main', headSha: 'abc123', entries: [] });
    });

    it('should throw AVHttpError on success: false', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      await expect(client.get('/api/secrets/nonexistent')).rejects.toThrow(AVHttpError);
    });
  });

  describe('security validation', () => {
    it('should reject paths not in allowlist', async () => {
      await expect(client.get('/api/admin/users')).rejects.toThrow('Path not in allowlist');
    });

    it('should reject paths that are too long', async () => {
      const longPath = `/api/inference?${'a'.repeat(3000)}`;
      await expect(client.get(longPath)).rejects.toThrow('Path too long');
    });

    it('should reject request bodies that are too large', async () => {
      const largeBody = { prompt: 'x'.repeat(15 * 1024 * 1024) };
      await expect(client.post('/api/inference', largeBody)).rejects.toThrow(
        'Request body too large'
      );
    });

    it('should allow valid paths', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { text: 'ok' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(client.post('/api/inference', { prompt: 'test' })).resolves.toBeDefined();
    });
  });

  describe('authorization', () => {
    it('should include Bearer token in headers', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await client.get('/api/memory-repo/branches/main');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });
  });
});

describe('Path validation patterns', () => {
  const ALLOWED_PATHS = [
    /^\/api\/inference$/,
    /^\/api\/memory-repo\/branches\/[^/]+$/,
    /^\/api\/memory-repo\/commits$/,
    /^\/api\/memory-repo\/tombstone$/,
    /^\/api\/archival\/upload$/,
    /^\/api\/secrets\/[^/]+$/,
  ];

  it('should match valid inference path', () => {
    expect(ALLOWED_PATHS.some(p => p.test('/api/inference'))).toBe(true);
  });

  it('should match valid branches path with dynamic segment', () => {
    expect(ALLOWED_PATHS.some(p => p.test('/api/memory-repo/branches/polytician-main'))).toBe(true);
    expect(ALLOWED_PATHS.some(p => p.test('/api/memory-repo/branches/main'))).toBe(true);
  });

  it('should match valid secrets path with dynamic segment', () => {
    expect(ALLOWED_PATHS.some(p => p.test('/api/secrets/MY_API_KEY'))).toBe(true);
    expect(ALLOWED_PATHS.some(p => p.test('/api/secrets/VENICE_API_KEY'))).toBe(true);
  });

  it('should not match invalid paths', () => {
    expect(ALLOWED_PATHS.some(p => p.test('/api/admin'))).toBe(false);
    expect(ALLOWED_PATHS.some(p => p.test('/api/users/1'))).toBe(false);
    expect(ALLOWED_PATHS.some(p => p.test('/api/memory-repo'))).toBe(false);
  });
});
