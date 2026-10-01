import { describe, it, expect, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../src/config.js';

// The encryption itself is covered in backup-format.test.ts, backup.test.ts
// and backup-tools.test.ts; this file covers how it is switched on.

afterEach(() => {
  delete process.env['POLYTICIAN_ENCRYPT'];
  resetConfig();
});

describe('POLYTICIAN_ENCRYPT / --encrypt', () => {
  it('is off by default', () => {
    resetConfig();
    expect(getConfig().encrypt).toBe(false);
  });

  it('POLYTICIAN_ENCRYPT=true turns it on', () => {
    process.env['POLYTICIAN_ENCRYPT'] = 'true';
    resetConfig();
    expect(getConfig().encrypt).toBe(true);
  });

  it('--encrypt in process.argv turns it on', () => {
    const originalArgv = process.argv;
    process.argv = [...originalArgv, '--encrypt'];
    try {
      resetConfig();
      expect(getConfig().encrypt).toBe(true);
    } finally {
      process.argv = originalArgv;
    }
  });
});
