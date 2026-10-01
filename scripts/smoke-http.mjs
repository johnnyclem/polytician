#!/usr/bin/env node
// Smoke-test a running HTTP server (docker image, compose, k8s port-forward):
//   POLYTICIAN_HTTP_TOKEN=... node scripts/smoke-http.mjs [baseUrl] [--embed]
// Saves a concept with an explicit vector and finds it again. --embed also
// saves markdown and searches by text, which loads the embedding model.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const embed = args.includes('--embed');
const base = (args.find(a => !a.startsWith('--')) ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const token = process.env.POLYTICIAN_HTTP_TOKEN;
if (!token) throw new Error('set POLYTICIAN_HTTP_TOKEN');

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${base}/health`).then(r => r.ok, () => false);
    if (ok) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  fail(`${base}/health did not report ok within 60 s`);
}

function payload(result) {
  if (result.isError) fail(`tool error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

await waitForHealth();
const client = new Client({ name: 'polytician-smoke', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
);

const { tools } = await client.listTools();
if (!tools.some(t => t.name === 'save_concept')) fail('save_concept is not listed');

const vector = Array.from({ length: 384 }, (_, i) => (i === 7 ? 1 : 0));
const saved = payload(
  await client.callTool({ name: 'save_concept', arguments: { embedding: vector, tags: ['smoke'] } })
);
const { results: found } = payload(
  await client.callTool({ name: 'search_concepts', arguments: { vector, k: 1 } })
);
if (found[0]?.id !== saved.id) fail(`vector search returned ${JSON.stringify(found)}`);

if (embed) {
  const text = payload(
    await client.callTool({
      name: 'save_concept',
      arguments: { markdown: 'Polytician smoke test: shared semantic memory over HTTP' },
    })
  );
  const { results: hits } = payload(
    await client.callTool({
      name: 'search_concepts',
      arguments: { query: 'shared semantic memory', k: 1 },
    })
  );
  if (hits[0]?.id !== text.id) fail(`text search returned ${JSON.stringify(hits)}`);
}

await client.close();
console.log(`smoke: ok (${base}${embed ? ', with embedding model' : ''})`);
