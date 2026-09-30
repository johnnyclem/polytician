import { v4 as uuidv4 } from 'uuid';
import { PolyticianError, VersionConflictError } from '../errors/index.js';
import { withRequestLogging } from '../logger.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Wrap a payload in the MCP text-content envelope every tool returns. */
export function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Error envelope: same shape as jsonResult but flagged so clients can branch on failure. */
export function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

/**
 * `{ error, code }` for errors with a stable code (NOT_FOUND, VALIDATION_ERROR,
 * VERSION_CONFLICT + currentVersion, NAMESPACE_DENIED, OVERWRITE_REFUSED,
 * CONVERSION_ERROR); `{ error }` for anything else.
 */
export function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof VersionConflictError) {
    return { error: err.message, code: err.code, currentVersion: err.currentVersion };
  }
  if (err instanceof PolyticianError) return { error: err.message, code: err.code };
  return { error: err instanceof Error ? err.message : String(err) };
}

/** Run a tool handler with request logging; coded errors become error results. */
export function runTool(operation: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return withRequestLogging(operation, uuidv4(), async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PolyticianError) return errorResult(errorPayload(err));
      throw err;
    }
  });
}
