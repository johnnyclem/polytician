import { createHash } from 'node:crypto';

const ALGORITHM = 'sha256';

export function sha256(data: Uint8Array): string {
  return createHash(ALGORITHM).update(data).digest('hex');
}

export function sha256String(data: string): string {
  return createHash(ALGORITHM).update(data, 'utf-8').digest('hex');
}
