import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FASTAPI_BUILD_TIMEOUT_MS,
  FASTAPI_CLEANUP_TIMEOUT_MS,
  FASTAPI_RUNTIME_TIMEOUT_MS,
  collectFastApiOpenApi,
} from '../src/fastapi-runtime.mjs';

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-fastapi-runtime-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('exports the exact FastAPI sandbox deadlines', () => {
  assert.equal(FASTAPI_BUILD_TIMEOUT_MS, 600000);
  assert.equal(FASTAPI_RUNTIME_TIMEOUT_MS, 30000);
  assert.equal(FASTAPI_CLEANUP_TIMEOUT_MS, 5000);
});

test('collectFastApiOpenApi uses requirements-only build input and a locked-down runtime sandbox', async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'requirements.txt'), 'fastapi\nuvicorn\n');
    await writeFile(path.join(root, 'src', 'app.py'), 'print(\'do not package me\')\n');

    let buildArgs = null;
    let runArgs = null;
    let cleanupArgs = null;
    let buildInput = null;

    const runDocker = async (args, options = {}) => {
      if (args[0] === 'build') {
        buildArgs = args;
        buildInput = options.input;
        return { stdout: 'image-123\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'run') {
        runArgs = args;
        return {
          stdout: JSON.stringify({
            paths: {
              '/items/{item_id}': {
                get: {
                  responses: {
                    '200': {
                      content: {
                        'application/json': {
                          schema: { $ref: '#/components/schemas/Item' },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'rmi') {
        cleanupArgs = args;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    };

    const result = await collectFastApiOpenApi({
      root,
      appTarget: 'service.api:create_app',
      runDocker,
    });

    assert.equal(result.diagnostic, null);
    assert.deepEqual(result.openapi, {
      paths: {
        '/items/{item_id}': {
          get: {
            responses: {
              '200': {
                schemaRef: '#/components/schemas/Item',
              },
            },
          },
        },
      },
    });

    assert.deepEqual(buildArgs, ['build', '-q', '-']);
    assert.match(buildInput, /FROM python:3\.11-slim/);
    assert.match(buildInput, /pip install --no-cache-dir -r requirements\.txt -t \/deps/);
    assert.equal(buildInput.includes(Buffer.from('fastapi\nuvicorn\n').toString('base64')), true);
    assert.doesNotMatch(buildInput, /do not package me/);
    assert.doesNotMatch(buildInput, /src\/app\.py/);

    assert.equal(runArgs[0], 'run');
    assert.equal(runArgs.includes('--network=none'), true);
    assert.equal(runArgs.includes('--read-only'), true);
    assert.equal(runArgs.includes('--tmpfs=/tmp'), true);
    assert.equal(runArgs.includes('--cpus=1'), true);
    assert.equal(runArgs.includes('--memory=512m'), true);
    assert.equal(runArgs.includes('--pids-limit=50'), true);
    assert.equal(runArgs.includes('--rm'), true);
    assert.equal(runArgs.includes('-e'), true);
    assert.equal(runArgs.includes('PYTHONPATH=/deps'), true);
    assert.equal(runArgs.includes('image-123'), true);
    assert.doesNotMatch(runArgs.join(' '), /\.ssh|docker\.sock|credentials|home/);

    assert.deepEqual(cleanupArgs, ['rmi', '-f', 'image-123']);
  });
});

test('collectFastApiOpenApi returns stable diagnostics when runtime collection fails', async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, 'requirements.txt'), 'fastapi\n');

    const result = await collectFastApiOpenApi({
      root,
      appTarget: 'service.api:create_app',
      runDocker: async (args) => {
        if (args[0] === 'build') {
          return { stdout: 'image-123\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'run') {
          return { stdout: 'not json', stderr: 'RAW SECRET SHOULD NOT LEAK', exitCode: 1 };
        }
        if (args[0] === 'rmi') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error('unexpected');
      },
    });

    assert.equal(result.openapi, null);
    assert.equal(result.diagnostic.type, 'docker_error');
    assert.equal(result.diagnostic.message.includes('RAW SECRET'), false);
  });
});

test('collectFastApiOpenApi returns a missing-manifest diagnostic when requirements are absent', async () => {
  await withTempDir(async (root) => {
    const result = await collectFastApiOpenApi({
      root,
      appTarget: 'service.api:create_app',
      runDocker: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });

    assert.equal(result.openapi, null);
    assert.equal(result.diagnostic.type, 'missing_manifest');
  });
});
