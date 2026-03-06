/**
 * ThoughtForm serialization helpers with optional encryption support.
 *
 * The {@link encryptBundle} stub is a placeholder for future VetKeys-style
 * encryption via the AgentVault security module.  When `encrypt` is false
 * (the default) the buffer passes through untouched.
 */

import { getConfig } from '../config.js';

/**
 * Encrypt a serialized ThoughtForm bundle.
 *
 * Currently a no-op that returns the input buffer unchanged.
 * Will be replaced with AgentVault VetKeys integration in a future release.
 */
export async function encryptBundle(buffer: Buffer): Promise<Buffer> {
  const { encrypt } = getConfig();

  if (!encrypt) {
    return buffer;
  }

  // TODO: integrate with AgentVault security module (VetKeys)
  return buffer;
}

/**
 * Decrypt a serialized ThoughtForm bundle.
 *
 * Currently a no-op that returns the input buffer unchanged.
 * Will be replaced with AgentVault VetKeys integration in a future release.
 */
export async function decryptBundle(buffer: Buffer): Promise<Buffer> {
  const { encrypt } = getConfig();

  if (!encrypt) {
    return buffer;
  }

  // TODO: integrate with AgentVault security module (VetKeys)
  return buffer;
}
