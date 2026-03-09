import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config to control the encrypt flag
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({ encrypt: false })),
  resetConfig: vi.fn(),
}));

const { getConfig } = await import('../src/config.js');
const { encryptBundle, decryptBundle } = await import('../src/storage/thoughtform.js');

describe('encryptBundle / decryptBundle', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({ encrypt: false } as ReturnType<typeof getConfig>);
  });

  it('returns the input buffer unchanged when encrypt is false', async () => {
    const input = Buffer.from('hello thoughtform');
    const result = await encryptBundle(input);
    expect(result).toBe(input);
  });

  it('returns the input buffer unchanged when encrypt is true (stub)', async () => {
    vi.mocked(getConfig).mockReturnValue({ encrypt: true } as ReturnType<typeof getConfig>);
    const input = Buffer.from('hello thoughtform');
    const result = await encryptBundle(input);
    expect(result).toBe(input);
  });

  it('decryptBundle returns the input buffer unchanged when encrypt is false', async () => {
    const input = Buffer.from('encrypted data');
    const result = await decryptBundle(input);
    expect(result).toBe(input);
  });

  it('decryptBundle returns the input buffer unchanged when encrypt is true (stub)', async () => {
    vi.mocked(getConfig).mockReturnValue({ encrypt: true } as ReturnType<typeof getConfig>);
    const input = Buffer.from('encrypted data');
    const result = await decryptBundle(input);
    expect(result).toBe(input);
  });
});

describe('--encrypt CLI flag', () => {
  it('is recognized in process.argv without error', async () => {
    // Reset module to re-evaluate with --encrypt in argv
    vi.resetModules();

    const originalArgv = process.argv;
    process.argv = [...originalArgv, '--encrypt'];

    // Re-import the real config (unmocked) to verify --encrypt flag parsing
    vi.doUnmock('../src/config.js');
    const { getConfig: realGetConfig, resetConfig: realResetConfig } = await import('../src/config.js');
    realResetConfig();

    const config = realGetConfig();
    expect(config.encrypt).toBe(true);

    // Cleanup
    process.argv = originalArgv;
    realResetConfig();
  });
});
