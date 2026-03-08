/**
 * PolyVault timestamp boundary conversion helpers.
 *
 * Handles safe conversion between TypeScript number (epoch ms) and
 * Motoko Nat64 representations, with explicit overflow detection.
 *
 * See PRD section 1.4 for the full boundary specification.
 */

/**
 * Maximum safe integer in JavaScript (2^53 - 1).
 * Motoko Nat64 can hold up to 2^64-1, but TypeScript numbers
 * lose precision beyond this value.
 */
const MAX_SAFE_TS = Number.MAX_SAFE_INTEGER;

export class TimestampOverflowError extends Error {
  constructor(
    public readonly value: bigint | number,
    public readonly direction: 'ts-to-motoko' | 'motoko-to-ts',
  ) {
    super(
      direction === 'ts-to-motoko'
        ? `ERR_TS_OVERFLOW: timestamp ${value} cannot be safely converted to Nat64 (negative or > MAX_SAFE_INTEGER)`
        : `ERR_TS_OVERFLOW: Nat64 value ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be safely represented in TypeScript`,
    );
    this.name = 'TimestampOverflowError';
  }
}

/**
 * Convert a TypeScript epoch-ms number to a Motoko-compatible Nat64 bigint.
 *
 * Rejects:
 * - Negative values
 * - Non-integer values
 * - Values exceeding Number.MAX_SAFE_INTEGER
 */
export function tsToNat64(ts: number): bigint {
  if (!Number.isInteger(ts) || ts < 0 || ts > MAX_SAFE_TS) {
    throw new TimestampOverflowError(ts, 'ts-to-motoko');
  }
  return BigInt(ts);
}

/**
 * Convert a Motoko Nat64 bigint to a TypeScript epoch-ms number.
 *
 * Rejects values exceeding Number.MAX_SAFE_INTEGER.
 */
export function nat64ToTs(nat64: bigint): number {
  if (nat64 < 0n || nat64 > BigInt(MAX_SAFE_TS)) {
    throw new TimestampOverflowError(nat64, 'motoko-to-ts');
  }
  return Number(nat64);
}

/**
 * Validate that a timestamp value is a valid epoch-ms integer.
 * Used at system boundaries (user input, external APIs).
 */
export function validateEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a Python-side timestamp integer for interoperability.
 * Python int range for safe interop: 0 <= ts <= 2^63-1.
 */
const PYTHON_MAX_TS = (2n ** 63n) - 1n;

export function validatePythonTimestamp(value: number): boolean {
  if (!Number.isInteger(value) || value < 0) return false;
  return BigInt(value) <= PYTHON_MAX_TS;
}
