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

test('loadConfig accepts bounded relative glob arrays and freezes a fastapi runtime object', async () => {
  const runtime = {
    type: 'fastapi',
    app: 'service.api:app',
  };
  const root = await makeConfigRoot({
    ...expectedConfig,
    source: {
      include: ['src/**/*.ts', 'scripts/*.py', '*.js'],
      exclude: ['dist', '**/*.spec.ts', '**/*.snap.py'],
    },
    runtime,
  });

  const loaded = await loadConfig(root);
  assert.deepEqual(loaded, {
    ...expectedConfig,
    source: {
      include: ['src/**/*.ts', 'scripts/*.py', '*.js'],
      exclude: ['dist', '**/*.spec.ts', '**/*.snap.py'],
    },
    runtime,
  });
  assert.equal(Object.isFrozen(loaded.source.include), true);
  assert.equal(Object.isFrozen(loaded.source.exclude), true);
  assert.equal(Object.isFrozen(loaded.runtime), true);
  assert.equal(loaded.runtime.type, 'fastapi');
  assert.equal(loaded.runtime.app, 'service.api:app');
});

test('loadConfig rejects unknown runtime keys', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    runtime: {
      type: 'fastapi',
      app: 'service.api:app',
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
      app: 'service.api:app',
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

test('loadConfig rejects invalid source glob arrays before trust-boundary checks continue', async () => {
  const emptyRoot = await makeConfigRoot({
    ...expectedConfig,
    source: {
      include: [''],
      exclude: expectedConfig.source.exclude,
    },
  });
  await assert.rejects(loadConfig(emptyRoot), /source\.include/i);

  const absoluteRoot = await makeConfigRoot({
    ...expectedConfig,
    source: {
      include: ['/tmp/**/*.js'],
      exclude: expectedConfig.source.exclude,
    },
  });
  await assert.rejects(loadConfig(absoluteRoot), /relative glob/i);

  const traversalRoot = await makeConfigRoot({
    ...expectedConfig,
    source: {
      include: ['src/**/*.js'],
      exclude: ['../secrets'],
    },
  });
  await assert.rejects(loadConfig(traversalRoot), /relative glob/i);
});

test('loadConfig rejects unknown top-level trust-boundary keys', async () => {
  const root = await makeConfigRoot({
    ...expectedConfig,
    trustBoundary: 'host-files',
  });

  await assert.rejects(loadConfig(root), /unknown top-level config key/i);
});
