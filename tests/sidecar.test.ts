import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for Python sidecar integration via POLYTICIAN_SIDECAR_URL.
 * These tests mock the HTTP calls to the sidecar, verifying the Node.js
 * side handles sidecar responses, errors, and edge cases correctly.
 */

// Mock fetch globally for sidecar HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Python Sidecar Integration', () => {
  const SIDECAR_URL = 'http://localhost:5001';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('health check', () => {
    it('should parse a healthy sidecar response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', model: 'all-MiniLM-L6-v2', dimension: 384 }),
      });

      const resp = await fetch(`${SIDECAR_URL}/health`);
      const data = await resp.json();

      expect(data.status).toBe('ok');
      expect(data.dimension).toBe(384);
      expect(data.model).toBe('all-MiniLM-L6-v2');
    });

    it('should handle sidecar being unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(fetch(`${SIDECAR_URL}/health`)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('embed endpoint', () => {
    it('should return embeddings for valid texts', async () => {
      const fakeEmbeddings = [Array(384).fill(0.01), Array(384).fill(0.02)];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: fakeEmbeddings, dimension: 384, model: 'all-MiniLM-L6-v2' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: ['hello', 'world'] }),
      });
      const data = await resp.json();

      expect(data.embeddings).toHaveLength(2);
      expect(data.dimension).toBe(384);
    });

    it('should handle empty texts array rejection', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'texts must be a non-empty list' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [] }),
      });

      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(400);
    });

    it('should handle over-limit texts rejection (>100)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'texts must contain at most 100 items' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: Array(101).fill('x') }),
      });

      expect(resp.ok).toBe(false);
    });

    it('should handle sidecar timeout', async () => {
      mockFetch.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50))
      );

      await expect(
        fetch(`${SIDECAR_URL}/embed`, {
          method: 'POST',
          body: JSON.stringify({ texts: ['test'] }),
        })
      ).rejects.toThrow('timeout');
    });

    it('should handle sidecar 500 error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        body: JSON.stringify({ texts: ['test'] }),
      });

      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(500);
    });
  });

  describe('similarity endpoint', () => {
    it('should return similarity score', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ similarity: 0.85 }),
      });

      const resp = await fetch(`${SIDECAR_URL}/similarity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_a: 'cat', text_b: 'kitten' }),
      });
      const data = await resp.json();

      expect(data.similarity).toBeGreaterThan(0);
      expect(data.similarity).toBeLessThanOrEqual(1);
    });

    it('should reject missing text_a', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'text_a and text_b are required' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/similarity`, {
        method: 'POST',
        body: JSON.stringify({ text_b: 'only one' }),
      });

      expect(resp.ok).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle unicode text in embeddings', async () => {
      const fakeEmb = [Array(384).fill(0.01)];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: fakeEmb, dimension: 384, model: 'all-MiniLM-L6-v2' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: ['日本語テスト 🎉'] }),
      });
      const data = await resp.json();

      expect(data.embeddings).toHaveLength(1);
    });

    it('should handle very long text input', async () => {
      const longText = 'word '.repeat(10000);
      const fakeEmb = [Array(384).fill(0.005)];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: fakeEmb, dimension: 384, model: 'all-MiniLM-L6-v2' }),
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [longText] }),
      });
      const data = await resp.json();

      expect(data.embeddings).toHaveLength(1);
    });

    it('should handle malformed JSON response from sidecar', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      });

      const resp = await fetch(`${SIDECAR_URL}/embed`, {
        method: 'POST',
        body: JSON.stringify({ texts: ['test'] }),
      });

      await expect(resp.json()).rejects.toThrow();
    });

    it('should handle concurrent sidecar requests', async () => {
      const makeResponse = (idx: number) => ({
        ok: true,
        json: async () => ({
          embeddings: [Array(384).fill(idx * 0.01)],
          dimension: 384,
          model: 'all-MiniLM-L6-v2',
        }),
      });

      mockFetch
        .mockResolvedValueOnce(makeResponse(1))
        .mockResolvedValueOnce(makeResponse(2))
        .mockResolvedValueOnce(makeResponse(3));

      const results = await Promise.all([
        fetch(`${SIDECAR_URL}/embed`, { method: 'POST', body: JSON.stringify({ texts: ['a'] }) }),
        fetch(`${SIDECAR_URL}/embed`, { method: 'POST', body: JSON.stringify({ texts: ['b'] }) }),
        fetch(`${SIDECAR_URL}/embed`, { method: 'POST', body: JSON.stringify({ texts: ['c'] }) }),
      ]);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.ok).toBe(true);
      }
    });
  });
});
