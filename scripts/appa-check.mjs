#!/usr/bin/env node
// Checks the OpenAPPA battery in integrations/openappa/:
//   1. the audience source's unit tests (python3), and
//   2. `appa describe --check` and `appa replay` over the replay traces,
//      against the OpenAPPA version the battery is pinned to.
// Each step is skipped, with a message, when its program is missing:
// python3 for (1), and `appa` on PATH (or $APPA naming the binary) for (2).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_APPA = '0.30.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const battery = join(root, 'integrations', 'openappa', 'polytician');
const replay = join(root, 'integrations', 'openappa', 'replay');
const appa = process.env.APPA || 'appa';

let failed = false;

/** Runs a program with inherited output; null when it is not installed. */
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error?.code === 'ENOENT') return null;
  if (result.error) throw result.error;
  return result.status;
}

function version(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf-8' });
  if (result.error?.code === 'ENOENT') return null;
  return result.status === 0 ? result.stdout.trim() : '';
}

if (version('python3') === null) {
  console.log('appa:check: python3 not found; skipping the audience source tests');
} else {
  console.log('appa:check: audience source unit tests');
  const status = run(
    'python3',
    ['-m', 'unittest', 'discover', '-s', battery, '-p', 'test_*.py'],
    { PYTHONDONTWRITEBYTECODE: '1' }
  );
  if (status !== 0) failed = true;
}

const appaVersion = version(appa);
if (appaVersion === null) {
  console.log(
    `appa:check: ${appa} not found on PATH; skipping describe --check and replay (the battery is pinned to OpenAPPA ${PINNED_APPA}; set APPA to the binary to run them)`
  );
} else {
  if (!appaVersion.endsWith(` ${PINNED_APPA}`)) {
    console.warn(
      `appa:check: ${appaVersion || appa} is not the pinned OpenAPPA ${PINNED_APPA}; results may differ`
    );
  }
  // The replay's audience source reads the fixture's namespace readers.
  const env = { POLYTICIAN_NAMESPACE_READERS: join(replay, 'namespace-readers.json') };
  const config = join(replay, 'appa.toml');
  console.log(`appa:check: ${appaVersion} describe --check`);
  if (run(appa, ['describe', '--config', config, '--check'], env) !== 0) failed = true;
  console.log(`appa:check: ${appaVersion} replay`);
  if (run(appa, ['replay', '--config', config, join(replay, 'traces')], env) !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
