import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';

const expectedConfig = {
  version: 1,
  source: {
    include: ['**/*'],
    exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv'],
  },
  runtime: null,
  agentReview: 'off',
};

async function makeConfigRoot(config) {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-config-'));
  await mkdir(path.join(root, '.vlp'), { recursive: true });
  await writeFile(path.join(root, '.vlp', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

test('loadConfig returns the exact version 1 project config', async () => {
  const root = await makeConfigRoot(expectedConfig);

  assert.deepEqual(await loadConfig(root), expectedConfig);
});

test('loadConfig rejects unknown top-level trust-boundary keys', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    trustBoundary: 'host-files',
  });

  await assert.rejects(loadConfig(root), /unknown top-level config key/i);
});
