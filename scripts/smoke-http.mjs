#!/usr/bin/env node
// Smoke-test a running HTTP server (docker image, compose, k8s port-forward):
//   POLYTICIAN_HTTP_TOKEN=... node scripts/smoke-http.mjs [baseUrl] [--embed]
// Saves a concept with an explicit vector and finds it again. --embed also
// saves markdown and searches by text, which loads the embedding model.
// Every concept it saves carries a tag unique to the run, which the searches
// filter on (so concepts already on the server, earlier smoke runs included,
// cannot change the result), and is deleted again before the script exits.
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const embed = args.includes('--embed');
const base = (args.find(a => !a.startsWith('--')) ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const token = process.env.POLYTICIAN_HTTP_TOKEN;
if (!token) throw new Error('set POLYTICIAN_HTTP_TOKEN');

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
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

/** Save → search with a vector (and with text for --embed), filtered on this run's tag. */
async function smoke(client, save) {
  const { tools } = await client.listTools();
  if (!tools.some(t => t.name === 'save_concept')) fail('save_concept is not listed');

  const runTag = `smoke-${randomUUID()}`;
  // A random unit vector, so two runs never save the same one.
  const raw = Array.from({ length: 384 }, () => Math.random() - 0.5);
  const norm = Math.hypot(...raw);
  const vector = raw.map(x => x / norm);
  const concept = await save({ embedding: vector, tags: [runTag] });
  const { results: found } = payload(
    await client.callTool({ name: 'search_concepts', arguments: { vector, k: 1, tags: [runTag] } })
  );
  if (found[0]?.id !== concept.id) fail(`vector search returned ${JSON.stringify(found)}`);

  if (embed) {
    const text = await save({
      markdown: `Polytician smoke test ${runTag}: shared semantic memory over HTTP`,
      tags: [runTag],
    });
    const { results: hits } = payload(
      await client.callTool({
        name: 'search_concepts',
        arguments: { query: 'shared semantic memory', k: 1, tags: [runTag] },
      })
    );
    if (hits[0]?.id !== text.id) fail(`text search returned ${JSON.stringify(hits)}`);
  }
}

async function main() {
  await waitForHealth();
  const client = new Client({ name: 'polytician-smoke', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );

  const saved = [];
  const save = async args => {
    const concept = payload(await client.callTool({ name: 'save_concept', arguments: args }));
    saved.push(concept.id);
    return concept;
  };
  try {
    await smoke(client, save);
  } finally {
    for (const id of saved) {
      const result = await client.callTool({ name: 'delete_concept', arguments: { id } });
      if (result.isError) console.error(`smoke: could not delete ${id}: ${result.content?.[0]?.text}`);
    }
    await client.close();
  }
}

try {
  await main();
  console.log(`smoke: ok (${base}${embed ? ', with embedding model' : ''})`);
} catch (err) {
  console.error(`smoke: ${err instanceof SmokeFailure ? err.message : err}`);
  process.exit(1);
}
