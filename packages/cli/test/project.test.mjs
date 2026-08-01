import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

async function makeRepoRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-init-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  return root;
}

test('initializeProject resolves a nested path to the repository root', async () => {
  const root = await makeRepoRoot();
  const nested = path.join(root, 'packages', 'app', 'src');
  await mkdir(nested, { recursive: true });

  const first = await initializeProject(nested);
  assert.equal(first.root, root);
  assert.equal(first.gitRoot, root);
  assert.deepEqual(first.created.directories, ['.monkeypaw', '.monkeypaw/contracts', '.monkeypaw/reviews']);
  assert.deepEqual(first.created.files, ['.monkeypaw/config.json', '.monkeypaw/.gitignore']);

  assert.deepEqual(await readdir(path.join(root, '.monkeypaw')), ['.gitignore', 'config.json', 'contracts', 'reviews']);
  assert.deepEqual(await readdir(path.join(root, '.monkeypaw', 'contracts')), []);
  assert.deepEqual(await readdir(path.join(root, '.monkeypaw', 'reviews')), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.monkeypaw', 'config.json'), 'utf8')), expectedConfig);
  assert.equal(await readFile(path.join(root, '.monkeypaw', '.gitignore'), 'utf8'), expectedGitignore);

  const second = await initializeProject(nested);
  assert.equal(second.root, root);
  assert.deepEqual(second.created.directories, []);
  assert.deepEqual(second.created.files, []);
});

test('initializeProject rejects non-Git roots even with a fake config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-no-git-'));
  await mkdir(path.join(root, '.monkeypaw'), { recursive: true });
  await writeFile(path.join(root, '.monkeypaw', 'config.json'), `${JSON.stringify(expectedConfig, null, 2)}\n`);

  await assert.rejects(initializeProject(root), /git repository or worktree/i);
});
