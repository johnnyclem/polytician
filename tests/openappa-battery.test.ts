import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: { cacheDir: '' },
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { resetConfig } from '../src/config.js';
import { registerVaultTools } from '../src/integrations/agent-vault/tools/vault-tools.js';
import { AgentVaultConfigSchema } from '../src/integrations/agent-vault/config.js';
import { resetSharedArchivalConnector } from '../src/integrations/agent-vault/connectors/archival.connector.js';

const BATTERY = join(__dirname, '..', 'integrations', 'openappa', 'polytician', 'appa.toml');

/** Each contract's tool name and argument selector, from `name = "mcp/polytician/<tool>(...)"`. */
function contracts(): Array<{ tool: string; selector: string | null }> {
  return [...readFileSync(BATTERY, 'utf-8').matchAll(/^name = "mcp\/polytician\/(\w+)(\(.*\))?"$/gm)].map(
    m => ({ tool: m[1]!, selector: m[2] ?? null })
  );
}

async function toolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'battery-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map(t => t.name);
}

afterEach(() => {
  delete process.env['POLYTICIAN_BACKUP_KEY'];
  resetSharedArchivalConnector();
  resetConfig();
});

describe('OpenAPPA battery (integrations/openappa/polytician)', () => {
  it('has a contract for every tool the server can register, and none for tools it lacks', async () => {
    process.env['POLYTICIAN_BACKUP_KEY'] = randomBytes(32).toString('hex');
    resetConfig();
    const vault = new McpServer({ name: 'vault-only', version: '0.0.0' });
    registerVaultTools(
      vault,
      AgentVaultConfigSchema.parse({
        apiBaseUrl: 'https://av.example',
        archival: { enabled: true, tagFilter: ['archive'] },
      })
    );
    const served = [...(await toolNames(await createServer())), ...(await toolNames(vault))].sort();
    expect(served).toHaveLength(20);

    const covered = [...new Set(contracts().map(c => c.tool))].sort();
    expect(covered).toEqual(served);
  });

  it('follows every namespace-selected contract with one for the omitted namespace', () => {
    const all = contracts();
    for (const [i, contract] of all.entries()) {
      if (contract.selector === null) continue;
      expect(all[i + 1], `${contract.tool}${contract.selector}`).toEqual({
        tool: contract.tool,
        selector: null,
      });
    }
  });
});
