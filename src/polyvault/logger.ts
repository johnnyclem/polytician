/**
 * PolyVault redaction-safe structured logger.
 *
 * All PolyVault pipeline operations route through this module to ensure:
 * - No rawText, decrypted payloads, or key material appears in logs
 * - Structured JSON output with safe telemetry fields
 * - Actionable remediation hints on error paths
 *
 * Safe fields: counts, non-sensitive IDs (commitId, bundleId, id),
 * hashes (chunkHash, contentHash, manifestHash), sizes (payloadSize,
 * chunkSizeBytes), timestamps, and boolean flags (compressed, encrypted).
 */

import { logger, type LogLevel } from '../logger.js';

// --- Redaction ---

/** Fields that must never appear in logs. */
const REDACTED_KEYS = new Set([
  'rawText',
  'decryptionKey',
  'encryptionKey',
  'decryptionNonce',
  'key',
  'nonce',
  'plaintext',
  'ciphertext',
  'payload',
  'thoughtforms',
  'entities',
  'relationships',
  'contextGraph',
]);

/**
 * Shallow-redact an object: replace values of sensitive keys with '[REDACTED]'.
 * Only inspects top-level keys for performance — PolyVault log fields are flat.
 */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(k)) {
      safe[k] = '[REDACTED]';
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

// --- PolyVault logger ---

export const vaultLogger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    logger.debug(`polyvault.${message}`, fields ? redactFields(fields) : undefined);
  },
  info(message: string, fields?: Record<string, unknown>): void {
    logger.info(`polyvault.${message}`, fields ? redactFields(fields) : undefined);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    logger.warn(`polyvault.${message}`, fields ? redactFields(fields) : undefined);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    logger.error(`polyvault.${message}`, undefined, fields ? redactFields(fields) : undefined);
  },
};

// --- Failure classification with remediation ---

export interface FailureInfo {
  code: string;
  message: string;
  remediation: string;
}

/** Map exit codes to failure classification with actionable remediation. */
export function classifyFailure(exitCode: number, message: string): FailureInfo {
  switch (exitCode) {
    case 2:
      return {
        code: 'ERR_VALIDATION',
        message,
        remediation: 'Check input file format and ThoughtForm schema compliance. Run with --dry-run to preview.',
      };
    case 3:
      return {
        code: 'ERR_AUTH',
        message,
        remediation: 'Verify principal identity and canister allowlist. Re-authenticate with dfx identity.',
      };
    case 4:
      return {
        code: 'ERR_NETWORK',
        message,
        remediation: 'Check network connectivity and canister availability. Retry the operation.',
      };
    case 5:
      return {
        code: 'ERR_INTEGRITY',
        message,
        remediation: 'Data integrity check failed. Verify chunk hashes and encryption keys. Consider a full restore.',
      };
    default:
      return {
        code: 'ERR_UNKNOWN',
        message,
        remediation: 'Unexpected error. Check logs for details and retry.',
      };
  }
}
