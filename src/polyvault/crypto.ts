import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export type EncryptionMode = 'none' | 'vetkeys-aes-gcm-v1';

export interface EncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface CryptoAdapter {
  readonly mode: EncryptionMode;
  /** `aad` (additional authenticated data) is bound to the ciphertext but not encrypted. */
  encrypt(plaintext: Uint8Array, key: Uint8Array, aad?: Uint8Array): Promise<EncryptResult>;
  decrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    aad?: Uint8Array
  ): Promise<Uint8Array>;
}

export class EncryptionRequiredError extends Error {
  constructor() {
    super('Encryption is required but no encryption adapter is available');
    this.name = 'EncryptionRequiredError';
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

// --- Noop adapter: encrypt=none passthrough ---

export class NoopCryptoAdapter implements CryptoAdapter {
  readonly mode: EncryptionMode = 'none';

  async encrypt(plaintext: Uint8Array): Promise<EncryptResult> {
    return { ciphertext: plaintext, nonce: new Uint8Array(0) };
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    return ciphertext;
  }
}

// --- AES-256-GCM adapter: VetKeys-compatible contract ---

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_KEY_BYTES = 32;
const AES_GCM_TAG_BYTES = 16;

export class AesGcmCryptoAdapter implements CryptoAdapter {
  readonly mode: EncryptionMode = 'vetkeys-aes-gcm-v1';

  async encrypt(plaintext: Uint8Array, key: Uint8Array, aad?: Uint8Array): Promise<EncryptResult> {
    validateKeyLength(key);
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    if (aad) cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = new Uint8Array(encrypted.length + tag.length);
    ciphertext.set(encrypted, 0);
    ciphertext.set(tag, encrypted.length);
    return { ciphertext, nonce: new Uint8Array(nonce) };
  }

  async decrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    aad?: Uint8Array
  ): Promise<Uint8Array> {
    validateKeyLength(key);
    if (nonce.length !== AES_GCM_NONCE_BYTES) {
      throw new DecryptionError(
        `Invalid nonce length: expected ${AES_GCM_NONCE_BYTES}, got ${nonce.length}`
      );
    }
    if (ciphertext.length < AES_GCM_TAG_BYTES) {
      throw new DecryptionError('Ciphertext too short to contain auth tag');
    }
    const encData = ciphertext.slice(0, ciphertext.length - AES_GCM_TAG_BYTES);
    const tag = ciphertext.slice(ciphertext.length - AES_GCM_TAG_BYTES);

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
      return new Uint8Array(decrypted);
    } catch {
      throw new DecryptionError(
        'Decryption failed: wrong key, or the data was modified (authentication tag mismatch)'
      );
    }
  }
}

function validateKeyLength(key: Uint8Array): void {
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new DecryptionError(
      `Invalid key length: expected ${AES_GCM_KEY_BYTES}, got ${key.length}`
    );
  }
}

export function createCryptoAdapter(mode: EncryptionMode): CryptoAdapter {
  switch (mode) {
    case 'none':
      return new NoopCryptoAdapter();
    case 'vetkeys-aes-gcm-v1':
      return new AesGcmCryptoAdapter();
  }
}

export function requireEncryptionAdapter(
  mode: EncryptionMode,
  encryptionRequired: boolean
): CryptoAdapter {
  if (encryptionRequired && mode === 'none') {
    throw new EncryptionRequiredError();
  }
  return createCryptoAdapter(mode);
}

// --- Stored payload envelope ---
//
// An encrypted PolyVault payload is stored as nonce (12 bytes) || ciphertext
// || tag (16 bytes), so each commit carries the nonce it was encrypted with
// and restore needs only the key. The AAD binds the payload to its bundle and
// commit ids, so chunks cannot be moved to another commit undetected.

/** AAD for a commit's payload. */
export function payloadAad(bundleId: string, commitId: string): Uint8Array {
  return new TextEncoder().encode(`polyvault/1:${bundleId}:${commitId}`);
}

/** Encrypt `plaintext` and prepend the nonce. */
export async function sealPayload(
  adapter: CryptoAdapter,
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const { ciphertext, nonce } = await adapter.encrypt(plaintext, key, aad);
  const sealed = new Uint8Array(nonce.length + ciphertext.length);
  sealed.set(nonce, 0);
  sealed.set(ciphertext, nonce.length);
  return sealed;
}

/** Split off the nonce written by sealPayload and decrypt. */
export async function openPayload(
  adapter: CryptoAdapter,
  sealed: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  if (sealed.length < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) {
    throw new DecryptionError('Encrypted payload too short to contain a nonce and auth tag');
  }
  return adapter.decrypt(
    sealed.slice(AES_GCM_NONCE_BYTES),
    key,
    sealed.slice(0, AES_GCM_NONCE_BYTES),
    aad
  );
}
