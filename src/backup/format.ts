import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AssertionStatusSchema,
  LedgerRefSchema,
  MarkdownSchema,
  NamespaceSchema,
  ProvenanceMapSchema,
  TagsSchema,
  type AssertionStatus,
  type ProvenanceMap,
} from '../types/concept.js';
import { StoredThoughtFormSchema, type StoredThoughtForm } from '../types/thoughtform.js';
import { ConfigurationError, ValidationError } from '../errors/index.js';
import type { BackupKey } from './key.js';
import { CIPHER_NAME, newNonce, openBytes, sealBytes } from './seal.js';

/**
 * Polytician backup file, format version 1 (JSONL, UTF-8, one JSON object per line).
 *
 * Plaintext:
 *   line 1      header   {"type":"header","format":"polytician-backup","formatVersion":1,...,"encryption":null}
 *   lines 2..n  concept  {"type":"concept","id":...,"tags":[...],"thoughtform":{...},"embedding":[...],"provenance":{...},"assertionStatus":...}
 *   last line   footer   {"type":"footer","conceptCount":n,"namespaces":{...},"sha256":...}
 *
 * Encrypted: the header (with `encryption`) followed by one line holding
 * base64(AES-256-GCM(concept lines + footer line) || 16-byte tag). The
 * nonce and the AAD are stored in the header; the AAD names the format and
 * the backupId, so a body cannot be moved under another header.
 *
 * The footer's sha256 covers the header line and every concept line, newlines
 * included, so truncation and edits are detected (and, when encrypted, a
 * changed header is detected after decryption). It is an integrity check,
 * not a signature: anyone who can write the file can recompute it.
 */

export const BACKUP_FORMAT = 'polytician-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_CIPHER = CIPHER_NAME;

const EncryptionSchema = z
  .object({
    alg: z.literal(BACKUP_CIPHER),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    aad: z.string().max(200),
  })
  .strict();

export const BackupHeaderSchema = z
  .object({
    type: z.literal('header'),
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    backupId: z.string().uuid(),
    createdAt: z.string().datetime(),
    embeddingModel: z.string().min(1).max(200),
    embeddingDimension: z.number().int().positive(),
    encryption: EncryptionSchema.nullable(),
  })
  .strict();

export type BackupHeader = z.infer<typeof BackupHeaderSchema>;

const epochMs = z.number().int().nonnegative();

/** One concept, with every representation as a JSON value (never a JSON-encoded string). */
export const BackupRecordSchema = z
  .object({
    type: z.literal('concept'),
    id: z.string().uuid(),
    namespace: NamespaceSchema,
    version: z.number().int().positive(),
    createdAt: epochMs,
    updatedAt: epochMs,
    tags: TagsSchema,
    markdown: MarkdownSchema.nullable(),
    thoughtform: StoredThoughtFormSchema.nullable(),
    embedding: z.array(z.number()).nullable(),
    provenance: ProvenanceMapSchema,
    assertionStatus: AssertionStatusSchema.nullable(),
    ledgerRef: LedgerRefSchema.nullable(),
  })
  .strict();

export interface BackupRecord {
  type: 'concept';
  id: string;
  namespace: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  markdown: string | null;
  thoughtform: StoredThoughtForm | null;
  embedding: number[] | null;
  provenance: ProvenanceMap;
  assertionStatus: AssertionStatus | null;
  ledgerRef: string | null;
}

export const BackupFooterSchema = z
  .object({
    type: z.literal('footer'),
    conceptCount: z.number().int().nonnegative(),
    namespaces: z.record(z.number().int().nonnegative()),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type BackupFooter = z.infer<typeof BackupFooterSchema>;

export interface DecodedBackup {
  header: BackupHeader;
  records: BackupRecord[];
  footer: BackupFooter;
}

/**
 * Raised for files that are not an intact backup. Messages name line numbers
 * and field names only; they never quote the file's content.
 */
export class BackupFormatError extends ValidationError {}

function aadFor(backupId: string): string {
  return `${BACKUP_FORMAT}/${BACKUP_FORMAT_VERSION}:${backupId}`;
}

/** Concepts per namespace, keys sorted. */
function countNamespaces(records: BackupRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.namespace, (counts.get(r.namespace) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface EncodeInput {
  records: BackupRecord[];
  embeddingModel: string;
  embeddingDimension: number;
  /** Encrypt the concept lines with this key; plaintext when null. */
  key: BackupKey | null;
  /** For tests; defaults to now. */
  createdAt?: Date;
}

export function encodeBackup(input: EncodeInput): {
  bytes: Buffer;
  header: BackupHeader;
  footer: BackupFooter;
} {
  const backupId = randomUUID();
  const nonce = input.key ? newNonce() : null;
  const header: BackupHeader = {
    type: 'header',
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    embeddingModel: input.embeddingModel,
    embeddingDimension: input.embeddingDimension,
    encryption:
      input.key && nonce
        ? {
            alg: BACKUP_CIPHER,
            keyId: input.key.keyId,
            nonce: nonce.toString('base64'),
            aad: aadFor(backupId),
          }
        : null,
  };

  const headerLine = JSON.stringify(header) + '\n';
  const recordLines = input.records.map(r => JSON.stringify(r) + '\n').join('');
  const footer: BackupFooter = {
    type: 'footer',
    conceptCount: input.records.length,
    namespaces: countNamespaces(input.records),
    sha256: createHash('sha256')
      .update(headerLine, 'utf-8')
      .update(recordLines, 'utf-8')
      .digest('hex'),
  };
  const body = recordLines + JSON.stringify(footer) + '\n';

  if (!input.key || !nonce || !header.encryption) {
    return { bytes: Buffer.from(headerLine + body, 'utf-8'), header, footer };
  }

  const sealed = sealBytes(Buffer.from(body, 'utf-8'), input.key.key, nonce, header.encryption.aad);
  return {
    bytes: Buffer.from(headerLine + sealed.toString('base64') + '\n', 'utf-8'),
    header,
    footer,
  };
}

function parseLine(line: string, lineNo: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new BackupFormatError(`Backup line ${lineNo} is not valid JSON`);
  }
}

/** First offending top-level field of a zod failure; field names come from the schema. */
function invalidField(error: z.ZodError): string {
  const field = error.issues[0]?.path[0];
  return typeof field === 'string' ? `field '${field}' is invalid` : 'unexpected structure';
}

/** Read just the header (line 1) of a backup file, e.g. to list backups. Null if it is not one. */
export function readBackupHeader(firstLine: string): BackupHeader | null {
  try {
    const parsed = BackupHeaderSchema.safeParse(JSON.parse(firstLine));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Parse and verify a backup file. `getKey` is only called for encrypted files.
 * Throws BackupFormatError (a ValidationError) for anything that is not an
 * intact backup, and ConfigurationError when an encrypted file needs a key
 * that is not configured.
 */
export function decodeBackup(bytes: Buffer, getKey: () => BackupKey | null): DecodedBackup {
  const text = bytes.toString('utf-8');
  const firstNewline = text.indexOf('\n');
  if (firstNewline < 0) throw new BackupFormatError('Not a Polytician backup file');
  const headerLine = text.slice(0, firstNewline + 1);

  const rawHeader = parseLine(headerLine, 1);
  const peek = rawHeader as { format?: unknown; formatVersion?: unknown } | null;
  if (!peek || typeof peek !== 'object' || peek.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('Not a Polytician backup file');
  }
  if (typeof peek.formatVersion === 'number' && peek.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `This backup uses format version ${peek.formatVersion}; this Polytician reads version ${BACKUP_FORMAT_VERSION}. Upgrade Polytician to import it.`
    );
  }
  const headerResult = BackupHeaderSchema.safeParse(rawHeader);
  if (!headerResult.success) {
    throw new BackupFormatError(`Backup header: ${invalidField(headerResult.error)}`);
  }
  const header = headerResult.data;

  let body = text.slice(firstNewline + 1);
  if (header.encryption) {
    const enc = header.encryption;
    if (enc.aad !== aadFor(header.backupId)) {
      throw new BackupFormatError('Backup header was modified (AAD does not match)');
    }
    const key = getKey();
    if (!key) {
      throw new ConfigurationError(
        `This backup is encrypted (key ${enc.keyId}), and no backup key is configured. Set POLYTICIAN_BACKUP_KEY or the key file to the key it was written with.`
      );
    }
    if (key.keyId !== enc.keyId) {
      throw new BackupFormatError(
        `Wrong backup key: this backup was encrypted with key ${enc.keyId}, but the configured key is ${key.keyId}`
      );
    }
    const sealedLine = body.endsWith('\n') ? body.slice(0, -1) : body;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealedLine)) {
      throw new BackupFormatError('Encrypted backup body is not base64');
    }
    try {
      body = openBytes(
        Buffer.from(sealedLine, 'base64'),
        key.key,
        Buffer.from(enc.nonce, 'base64'),
        enc.aad
      ).toString('utf-8');
    } catch {
      throw new BackupFormatError(
        'Backup decryption failed: the file was modified or corrupted (authentication tag mismatch)'
      );
    }
  }

  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  // Line numbers as a reader of the plaintext stream sees them (header is line 1).
  const records: BackupRecord[] = [];
  const hash = createHash('sha256').update(headerLine, 'utf-8');
  let footer: BackupFooter | null = null;
  lines.forEach((line, i) => {
    const lineNo = i + 2;
    const raw = parseLine(line, lineNo);
    if ((raw as { type?: unknown } | null)?.type === 'footer' && i === lines.length - 1) {
      const parsed = BackupFooterSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BackupFormatError(`Backup footer: ${invalidField(parsed.error)}`);
      }
      footer = parsed.data;
      return;
    }
    hash.update(line + '\n', 'utf-8');
    const parsed = BackupRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BackupFormatError(`Backup line ${lineNo}: ${invalidField(parsed.error)}`);
    }
    // Keep the value as written: schema defaults and key stripping must not
    // change what is restored (a thoughtform is stored exactly as saved).
    records.push(raw as BackupRecord);
  });
  if (!footer) throw new BackupFormatError('Backup is incomplete: it has no footer');
  const verified: BackupFooter = footer;

  if (hash.digest('hex') !== verified.sha256) {
    throw new BackupFormatError('Backup checksum mismatch: the file was modified or corrupted');
  }
  if (verified.conceptCount !== records.length) {
    throw new BackupFormatError(
      `Backup footer counts ${verified.conceptCount} concepts, but the file holds ${records.length}`
    );
  }
  const counts = countNamespaces(records);
  const footerNamespaces = Object.keys(verified.namespaces);
  if (
    footerNamespaces.length !== Object.keys(counts).length ||
    footerNamespaces.some(ns => verified.namespaces[ns] !== counts[ns])
  ) {
    throw new BackupFormatError('Backup footer namespace counts do not match its concepts');
  }
  const ids = new Set<string>();
  records.forEach((r, i) => {
    if (ids.has(r.id)) throw new BackupFormatError(`Backup line ${i + 2}: duplicate concept id`);
    ids.add(r.id);
  });

  return { header, records, footer: verified };
}
