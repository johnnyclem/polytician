import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redactFields, vaultLogger, classifyFailure } from '../../src/polyvault/logger.js';

// --- redactFields tests ---

describe('redactFields', () => {
  it('passes through safe telemetry fields unchanged', () => {
    const input = {
      commitId: 'cmt_abc123',
      bundleId: 'bndl_xyz789',
      thoughtformCount: 42,
      chunkCount: 3,
      payloadHash: 'deadbeef'.repeat(8),
      duration_ms: 1234,
      compressed: true,
      encrypted: false,
    };
    expect(redactFields(input)).toEqual(input);
  });

  it('redacts rawText', () => {
    const result = redactFields({ rawText: 'secret user content', id: 'tf_01' });
    expect(result.rawText).toBe('[REDACTED]');
    expect(result.id).toBe('tf_01');
  });

  it('redacts encryptionKey', () => {
    const result = redactFields({ encryptionKey: new Uint8Array(32), bundleId: 'b1' });
    expect(result.encryptionKey).toBe('[REDACTED]');
    expect(result.bundleId).toBe('b1');
  });

  it('redacts decryptionKey', () => {
    const result = redactFields({ decryptionKey: new Uint8Array(32) });
    expect(result.decryptionKey).toBe('[REDACTED]');
  });

  it('redacts decryptionNonce', () => {
    const result = redactFields({ decryptionNonce: new Uint8Array(12) });
    expect(result.decryptionNonce).toBe('[REDACTED]');
  });

  it('redacts key and nonce', () => {
    const result = redactFields({ key: 'secret', nonce: 'iv_value' });
    expect(result.key).toBe('[REDACTED]');
    expect(result.nonce).toBe('[REDACTED]');
  });

  it('redacts plaintext and ciphertext', () => {
    const result = redactFields({ plaintext: 'hello', ciphertext: 'encrypted_bytes' });
    expect(result.plaintext).toBe('[REDACTED]');
    expect(result.ciphertext).toBe('[REDACTED]');
  });

  it('redacts payload', () => {
    const result = redactFields({ payload: new Uint8Array(1024), chunkIndex: 0 });
    expect(result.payload).toBe('[REDACTED]');
    expect(result.chunkIndex).toBe(0);
  });

  it('redacts thoughtforms array', () => {
    const result = redactFields({ thoughtforms: [{ id: 'tf_01', rawText: 'secret' }] });
    expect(result.thoughtforms).toBe('[REDACTED]');
  });

  it('redacts entities', () => {
    const result = redactFields({ entities: [{ id: 'e1', value: 'private data' }] });
    expect(result.entities).toBe('[REDACTED]');
  });

  it('redacts relationships', () => {
    const result = redactFields({ relationships: [{ from: 'e1', to: 'e2' }] });
    expect(result.relationships).toBe('[REDACTED]');
  });

  it('redacts contextGraph', () => {
    const result = redactFields({ contextGraph: { source: 'test' } });
    expect(result.contextGraph).toBe('[REDACTED]');
  });

  it('handles empty object', () => {
    expect(redactFields({})).toEqual({});
  });

  it('redacts multiple sensitive fields at once', () => {
    const result = redactFields({
      rawText: 'secret',
      encryptionKey: 'key',
      payload: 'bytes',
      commitId: 'cmt_safe',
      duration_ms: 100,
    });
    expect(result.rawText).toBe('[REDACTED]');
    expect(result.encryptionKey).toBe('[REDACTED]');
    expect(result.payload).toBe('[REDACTED]');
    expect(result.commitId).toBe('cmt_safe');
    expect(result.duration_ms).toBe(100);
  });
});

// --- vaultLogger tests ---

describe('vaultLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function getLogEntries(): Record<string, unknown>[] {
    return stderrSpy.mock.calls
      .map(([data]) => {
        try {
          return JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  }

  it('prefixes messages with polyvault.', () => {
    vaultLogger.info('backup.start', { chunkCount: 5 });
    const entries = getLogEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1]!;
    expect(entry.message).toBe('polyvault.backup.start');
    expect(entry.chunkCount).toBe(5);
  });

  it('never outputs rawText in log fields', () => {
    vaultLogger.info('test.sensitive', { rawText: 'secret content', commitId: 'cmt_1' });
    const entries = getLogEntries();
    const entry = entries[entries.length - 1]!;
    expect(entry.rawText).toBe('[REDACTED]');
    expect(entry.commitId).toBe('cmt_1');

    // Double-check the raw output doesn't contain the secret
    const rawOutput = stderrSpy.mock.calls.map(([d]) => String(d)).join('');
    expect(rawOutput).not.toContain('secret content');
  });

  it('never outputs encryptionKey in log fields', () => {
    vaultLogger.debug('test.key', { encryptionKey: 'super-secret-key' });
    const rawOutput = stderrSpy.mock.calls.map(([d]) => String(d)).join('');
    expect(rawOutput).not.toContain('super-secret-key');
  });

  it('never outputs payload bytes in log fields', () => {
    vaultLogger.warn('test.payload', { payload: 'binary-data-here' });
    const rawOutput = stderrSpy.mock.calls.map(([d]) => String(d)).join('');
    expect(rawOutput).not.toContain('binary-data-here');
  });

  it('logs error level with redaction', () => {
    vaultLogger.error('backup.failed', { rawText: 'should not appear', exitCode: 5 });
    const entries = getLogEntries();
    const entry = entries[entries.length - 1]!;
    expect(entry.level).toBe('error');
    expect(entry.rawText).toBe('[REDACTED]');
    expect(entry.exitCode).toBe(5);
  });

  it('handles undefined fields gracefully', () => {
    vaultLogger.info('test.nofields');
    const entries = getLogEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[entries.length - 1]!.message).toBe('polyvault.test.nofields');
  });
});

// --- classifyFailure tests ---

describe('classifyFailure', () => {
  it('classifies exit code 2 as validation error', () => {
    const f = classifyFailure(2, 'bad input');
    expect(f.code).toBe('ERR_VALIDATION');
    expect(f.message).toBe('bad input');
    expect(f.remediation).toContain('schema');
  });

  it('classifies exit code 3 as auth error', () => {
    const f = classifyFailure(3, 'not allowed');
    expect(f.code).toBe('ERR_AUTH');
    expect(f.remediation).toContain('principal');
  });

  it('classifies exit code 4 as network error', () => {
    const f = classifyFailure(4, 'timeout');
    expect(f.code).toBe('ERR_NETWORK');
    expect(f.remediation).toContain('Retry');
  });

  it('classifies exit code 5 as integrity error', () => {
    const f = classifyFailure(5, 'hash mismatch');
    expect(f.code).toBe('ERR_INTEGRITY');
    expect(f.remediation).toContain('chunk hashes');
  });

  it('classifies unknown exit code as unknown error', () => {
    const f = classifyFailure(99, 'wat');
    expect(f.code).toBe('ERR_UNKNOWN');
    expect(f.remediation).toContain('retry');
  });
});
