import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { ConfigurationError } from '../errors/index.js';

/**
 * The AES-256 key that encrypts backup files. It never comes from the config
 * file: either POLYTICIAN_BACKUP_KEY, or a key file readable only by its owner
 * (POLYTICIAN_BACKUP_KEY_FILE, default {dataDir}/backup.key). Polytician never
 * generates one, because a key that only exists on the machine being backed
 * up cannot decrypt the backup after that machine is lost.
 */

export const BACKUP_KEY_ENV = 'POLYTICIAN_BACKUP_KEY';
export const BACKUP_KEY_FILE_ENV = 'POLYTICIAN_BACKUP_KEY_FILE';

const KEY_BYTES = 32;

export interface BackupKey {
  key: Buffer;
  /** Public fingerprint of the key, recorded in encrypted files to name the key they need. */
  keyId: string;
}

export function backupKeyFile(): string {
  return process.env[BACKUP_KEY_FILE_ENV] ?? join(getConfig().dataDir, 'backup.key');
}

/** 32 bytes written as 64 hex characters or as base64 / base64url. */
function decodeKey(text: string, source: string): Buffer {
  const trimmed = text.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'base64');
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new ConfigurationError(
      `${source} must hold a 256-bit key written as 64 hex characters or as base64`
    );
  }
  return key;
}

export function backupKeyId(key: Buffer): string {
  return createHash('sha256')
    .update('polytician-backup-key-id\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

/** The configured backup key, or null when none is configured. */
export function loadBackupKey(): BackupKey | null {
  const fromEnv = process.env[BACKUP_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const key = decodeKey(fromEnv, BACKUP_KEY_ENV);
    return { key, keyId: backupKeyId(key) };
  }

  const path = backupKeyFile();
  if (!existsSync(path)) return null;
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    throw new ConfigurationError(
      `The backup key file ${path} is readable by other users; restrict it with chmod 600`
    );
  }
  const key = decodeKey(readFileSync(path, 'utf-8'), `The backup key file ${path}`);
  return { key, keyId: backupKeyId(key) };
}

/** The configured backup key; throws a ConfigurationError explaining how to add one. */
export function requireBackupKey(purpose: string): BackupKey {
  const key = loadBackupKey();
  if (key) return key;
  const path = backupKeyFile();
  throw new ConfigurationError(
    `${purpose} needs a backup encryption key, and none is configured. Set ${BACKUP_KEY_ENV} to 32 random bytes in base64, or create ${path} (for example: openssl rand -base64 32 > ${path} && chmod 600 ${path}). Keep a copy of the key off this machine: an encrypted backup cannot be restored without it.`
  );
}
