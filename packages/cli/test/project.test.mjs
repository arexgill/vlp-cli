import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeProject } from '../src/project.mjs';

const expectedConfig = {
  version: 1,
  source: {
    include: ['**/*'],
    exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv'],
  },
  runtime: null,
  agentReview: 'off',
};

const expectedGitignore = ['reviews/.sessions/', 'reviews/.cache/', 'reviews/*.tmp', ''].join('\n');

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-init-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  return root;
}

test('initializeProject rejects non-Git roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-no-git-'));

  await assert.rejects(initializeProject(root), /git repository or worktree/i);
});

test('initializeProject creates the exact .vlp tree and is idempotent', async () => {
  const root = await makeRoot();

  const first = await initializeProject(root);
  assert.deepEqual(first.created.directories, ['.vlp', '.vlp/contracts', '.vlp/reviews']);
  assert.deepEqual(first.created.files, ['.vlp/config.json', '.vlp/.gitignore']);

  assert.deepEqual(await readdir(path.join(root, '.vlp')), ['.gitignore', 'config.json', 'contracts', 'reviews']);
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'contracts')), []);
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'reviews')), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.vlp', 'config.json'), 'utf8')), expectedConfig);
  assert.equal(await readFile(path.join(root, '.vlp', '.gitignore'), 'utf8'), expectedGitignore);

  const second = await initializeProject(root);
  assert.deepEqual(second.created.directories, []);
  assert.deepEqual(second.created.files, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.vlp', 'config.json'), 'utf8')), expectedConfig);
});
