import { promisify } from 'node:util';
import { gzip as gzipCb, gunzip as gunzipCb, constants } from 'node:zlib';

const gzipAsync = promisify(gzipCb);
const gunzipAsync = promisify(gunzipCb);

export type CompressionMode = 'none' | 'gzip';

export async function compress(
  data: Uint8Array,
  mode: CompressionMode
): Promise<Uint8Array> {
  if (mode === 'none') {
    return data;
  }
  const buf = await gzipAsync(Buffer.from(data), {
    level: constants.Z_DEFAULT_COMPRESSION,
  });
  return new Uint8Array(buf);
}

export async function decompress(
  data: Uint8Array,
  mode: CompressionMode
): Promise<Uint8Array> {
  if (mode === 'none') {
    return data;
  }
  const buf = await gunzipAsync(Buffer.from(data));
  return new Uint8Array(buf);
}
