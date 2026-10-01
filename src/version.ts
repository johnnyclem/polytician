import { createRequire } from 'node:module';

/**
 * The package version, read from package.json (one directory above both src/
 * and dist/) so the MCP server never advertises a stale hard-coded one.
 */
export const POLYTICIAN_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
