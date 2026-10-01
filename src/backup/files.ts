import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from '../config.js';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { readBackupHeader, type BackupHeader } from './format.js';

/**
 * Backup files live in {dataDir}/backups (mode 0700), each file mode 0600.
 * Tools address a backup by its file name only; resolveBackupFile() refuses
 * anything that is not a regular file directly inside that directory.
 */

export const BACKUP_EXTENSION = '.jsonl';

/** File names tools may pass: no separators, no leading dot. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export function backupsDir(): string {
  return join(getConfig().dataDir, 'backups');
}

/** Create a directory (and parents) readable only by its owner; tighten it if it exists. */
export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

/**
 * Write a file with mode 0600: to a temporary sibling first, then renamed into
 * place, so a crash never leaves a truncated file under the final name.
 */
export function writePrivateFile(path: string, bytes: Buffer): void {
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

/** polytician-<prefix>-<ISO time>-<backupId prefix>.jsonl, so names sort by creation time. */
export function newBackupFileName(
  prefix: 'backup' | 'auto',
  createdAt: string,
  backupId: string
): string {
  return `polytician-${prefix}-${createdAt.replace(/[:.]/g, '-')}-${backupId.slice(0, 8)}${BACKUP_EXTENSION}`;
}

/**
 * Absolute path of a backup named by a tool caller. Only a plain file name is
 * accepted, and the resolved file (after symlinks) must be a regular file
 * directly inside the backups directory.
 */
export function resolveBackupFile(name: string): string {
  if (!FILE_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      'file must be the name of a backup in the backups directory (no path separators); list_backups shows them'
    );
  }
  const dir = backupsDir();
  const candidate = join(dir, name);
  if (!existsSync(candidate)) throw new NotFoundError('Backup', name);
  const real = realpathSync(candidate);
  if (dirname(real) !== realpathSync(dir) || !statSync(real).isFile()) {
    throw new ValidationError('file must be a regular file inside the backups directory');
  }
  return real;
}

/** First line of a file, reading at most `limit` bytes. */
function readFirstLine(path: string, limit = 4096): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, 0);
    const text = buf.subarray(0, n).toString('utf-8');
    const newline = text.indexOf('\n');
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    closeSync(fd);
  }
}

export interface BackupFileInfo {
  file: string;
  sizeBytes: number;
  backupId: string;
  createdAt: string;
  encrypted: boolean;
  keyId: string | null;
  embeddingModel: string;
}

/** Backups in the backups directory, newest first. Files that are not backups are left out. */
export function listBackupFiles(): BackupFileInfo[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  const infos: BackupFileInfo[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(BACKUP_EXTENSION) || !FILE_NAME_PATTERN.test(file)) continue;
    const path = join(dir, file);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const header: BackupHeader | null = readBackupHeader(readFirstLine(path));
    if (!header) continue;
    infos.push({
      file,
      sizeBytes: stat.size,
      backupId: header.backupId,
      createdAt: header.createdAt,
      encrypted: header.encryption !== null,
      keyId: header.encryption?.keyId ?? null,
      embeddingModel: header.embeddingModel,
    });
  }
  return infos.sort((a, b) =>
    a.createdAt === b.createdAt ? b.file.localeCompare(a.file) : a.createdAt < b.createdAt ? 1 : -1
  );
}

/** Delete all but the `keep` newest files named polytician-<prefix>-*.jsonl. */
export function pruneBackups(prefix: 'backup' | 'auto', keep: number): string[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  const pattern = `polytician-${prefix}-`;
  const files = readdirSync(dir)
    .filter(f => f.startsWith(pattern) && f.endsWith(BACKUP_EXTENSION))
    .sort()
    .reverse();
  const removed = files.slice(Math.max(keep, 0));
  for (const file of removed) rmSync(join(dir, file), { force: true });
  return removed;
}
