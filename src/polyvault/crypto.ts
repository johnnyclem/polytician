import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export type EncryptionMode = 'none' | 'vetkeys-aes-gcm-v1';

export interface EncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface CryptoAdapter {
  readonly mode: EncryptionMode;
  encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptResult>;
  decrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array
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

  async encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptResult> {
    validateKeyLength(key);
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
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
    nonce: Uint8Array
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
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(encData),
        decipher.final(),
      ]);
      return new Uint8Array(decrypted);
    } catch {
      throw new DecryptionError('Decryption failed: authentication tag mismatch');
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
