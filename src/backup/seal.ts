import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing shared by backup files and Arweave archives. The
 * sealed form is ciphertext followed by the 16-byte tag; the 96-bit nonce
 * and the AAD travel next to it in the caller's (plaintext) header.
 */

export const CIPHER_NAME = 'AES-256-GCM';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A fresh random nonce. Never reuse one with the same key. */
export function newNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}

export function sealBytes(plaintext: Buffer, key: Buffer, nonce: Buffer, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf-8'));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Throws when the key, nonce, AAD or ciphertext do not match (authentication tag mismatch). */
export function openBytes(sealed: Buffer, key: Buffer, nonce: Buffer, aad: string): Buffer {
  if (sealed.length < TAG_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error('sealed data is truncated');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf-8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}
