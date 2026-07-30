import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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

test('loadConfig returns the exact version 1 project config with runtime null', async () => {
  const root = await makeConfigRoot(expectedConfig);

  assert.deepEqual(await loadConfig(root), expectedConfig);
});

test('loadConfig accepts and freezes a fastapi runtime object', async () => {
  const runtime = {
    type: 'fastapi',
    app: 'service.api:create_app',
  };
  const root = await makeConfigRoot({
    ...expectedConfig,
    runtime,
  });

  const loaded = await loadConfig(root);
  assert.deepEqual(loaded, {
    ...expectedConfig,
    runtime,
  });
  assert.equal(Object.isFrozen(loaded.runtime), true);
  assert.equal(loaded.runtime.type, 'fastapi');
  assert.equal(loaded.runtime.app, 'service.api:create_app');
});

test('loadConfig rejects unknown runtime keys', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    runtime: {
      type: 'fastapi',
      app: 'service.api:create_app',
      extra: true,
    },
  });

  await assert.rejects(loadConfig(root), /unknown runtime key/i);
});

test('loadConfig rejects unsupported runtime types', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    runtime: {
      type: 'celery',
      app: 'service.api:create_app',
    },
  });

  await assert.rejects(loadConfig(root), /unsupported runtime type/i);
});

test('loadConfig rejects invalid runtime app targets', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    runtime: {
      type: 'fastapi',
      app: 'service-api:create-app',
    },
  });

  await assert.rejects(loadConfig(root), /conservative python module\/attribute syntax/i);
});

test('loadConfig rejects unknown top-level trust-boundary keys', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    trustBoundary: 'host-files',
  });

  await assert.rejects(loadConfig(root), /unknown top-level config key/i);
});
