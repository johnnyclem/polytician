import { getConfig } from '../config.js';
import { NamespaceDeniedError } from '../errors/index.js';

/**
 * Operator policy for which namespaces MCP tool calls may address, from
 * POLYTICIAN_NAMESPACES (or `namespaces` in the config file). Tool handlers
 * resolve every namespace through here; service-layer callers inside the
 * process are trusted and are not checked.
 */

/** The namespace a tool call addresses (default 'default'), if the allowlist permits it. */
export function resolveNamespace(namespace: string | undefined): string {
  const ns = namespace ?? 'default';
  const allowed = getConfig().namespaces;
  if (allowed !== null && allowed !== '*' && !allowed.includes(ns)) {
    throw new NamespaceDeniedError(
      `Namespace '${ns}' is not in this server's POLYTICIAN_NAMESPACES allowlist`
    );
  }
  return ns;
}

/**
 * Namespaces a crossNamespace search spans: the allowlist, or all when it is
 * '*'. Refused when the operator has not configured POLYTICIAN_NAMESPACES.
 */
export function crossNamespaceScope(): readonly string[] | '*' {
  const allowed = getConfig().namespaces;
  if (allowed === null) {
    throw new NamespaceDeniedError(
      'crossNamespace search is disabled on this server; the operator enables it by setting POLYTICIAN_NAMESPACES to a list of namespaces or *'
    );
  }
  return allowed;
}
