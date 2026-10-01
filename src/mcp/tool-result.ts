import { v4 as uuidv4 } from 'uuid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PolyticianError, VersionConflictError } from '../errors/index.js';
import { withRequestLogging } from '../logger.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * A successful result: the payload as `structuredContent` (checked against
 * the tool's outputSchema) and, for clients that read text, the same JSON in
 * `content[0].text`.
 */
export function jsonResult(payload: object): ToolResult {
  const structured = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Error envelope: `isError` with the `{ error, code }` body as text. It
 * carries no structuredContent, since an error body does not match the
 * tool's outputSchema.
 */
export function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

/**
 * `{ error, code }`. Codes: NOT_FOUND, VALIDATION_ERROR, VERSION_CONFLICT
 * (+ currentVersion), NAMESPACE_DENIED, OVERWRITE_REFUSED, CONVERSION_ERROR,
 * EMBEDDING_MODEL_MISMATCH, CONFIG_ERROR, UPSTREAM_ERROR, and INTERNAL_ERROR
 * for anything that is not a PolyticianError.
 */
export function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof VersionConflictError) {
    return { error: err.message, code: err.code, currentVersion: err.currentVersion };
  }
  if (err instanceof PolyticianError) return { error: err.message, code: err.code };
  return { error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' };
}

/** Run a tool handler with request logging; every error becomes a coded error result. */
export async function runTool(
  operation: string,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await withRequestLogging(operation, uuidv4(), async () => {
      try {
        return await fn();
      } catch (err) {
        // Expected outcomes (not found, conflicts, ...) are results, not logged failures.
        if (err instanceof PolyticianError) return errorResult(errorPayload(err));
        throw err;
      }
    });
  } catch (err) {
    return errorResult(errorPayload(err));
  }
}

/**
 * The SDK answers a call whose arguments fail the tool's input schema, or
 * that names no tool, with a plain-text error result of its own. This gives
 * those the same `{ error, code }` body as every other tool error
 * (VALIDATION_ERROR, NOT_FOUND). The SDK (1.x) has no public hook for it, so
 * this replaces its private createToolError on this instance;
 * tests/mcp-typed-output.test.ts fails if an SDK upgrade stops calling it.
 */
export function useCodedToolErrors(server: McpServer): void {
  const target = server as unknown as { createToolError?: (message: string) => ToolResult };
  if (typeof target.createToolError !== 'function') return;
  target.createToolError = (message: string): ToolResult => {
    const error = message.replace(/^MCP error -?\d+: /, '');
    const code = error.startsWith('Input validation error')
      ? 'VALIDATION_ERROR'
      : /^Tool \S+ (not found|disabled)$/.test(error)
        ? 'NOT_FOUND'
        : 'INTERNAL_ERROR';
    return errorResult({ error, code });
  };
}
