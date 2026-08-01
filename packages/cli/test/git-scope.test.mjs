import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { selectChangedFiles } from '../src/git-scope.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  await exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
}

async function gitOutput(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  return stdout.trim();
}

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-git-scope-'));
  await git(root, 'init');
  return root;
}

async function writeTree(root, entries) {
  for (const [relativePath, content] of entries) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

test('selectChangedFiles returns deterministically ordered working tree changes within the requested scope', async () => {
  const repo = await makeRepo();
  const scopeRoot = path.join(repo, 'scope');
  await writeTree(repo, [
    ['scope/alpha.txt', 'alpha'],
    ['scope/bravo.txt', 'bravo'],
    ['scope/rename-old.txt', 'rename'],
    ['scope/zulu.txt', 'zulu'],
    ['outside.txt', 'outside'],
  ]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');

  await writeTree(repo, [
    ['scope/alpha.txt', 'alpha changed'],
    ['scope/extra.txt', 'extra'],
    ['outside.txt', 'outside changed'],
  ]);
  await rm(path.join(repo, 'scope', 'bravo.txt'));
  await git(repo, 'mv', 'scope/rename-old.txt', 'scope/rename-new.txt');

  const changed = await selectChangedFiles(scopeRoot);

  assert.deepEqual(changed, [
    'alpha.txt',
    'extra.txt',
    'rename-new.txt',
  ]);
});

test('selectChangedFiles can scope staged changes and ignores changes outside the requested scope', async () => {
  const repo = await makeRepo();
  const scopeRoot = path.join(repo, 'scope');
  await writeTree(repo, [
    ['scope/keep.txt', 'keep'],
    ['scope/drop.txt', 'drop'],
    ['scope/rename-old.txt', 'rename'],
    ['outside.txt', 'outside'],
  ]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');

  await writeTree(repo, [
    ['scope/staged.txt', 'staged'],
    ['scope/unstaged.txt', 'unstaged'],
    ['outside.txt', 'outside changed'],
  ]);
  await git(repo, 'add', 'scope/staged.txt');
  await git(repo, 'rm', 'scope/drop.txt');
  await git(repo, 'mv', 'scope/rename-old.txt', 'scope/rename-new.txt');

  const changed = await selectChangedFiles(scopeRoot, { staged: true });

  assert.deepEqual(changed, [
    'rename-new.txt',
    'staged.txt',
  ]);
});

test('selectChangedFiles accepts an explicit base ref, keeps only rename destinations, and skips deletions', async () => {
  const repo = await makeRepo();
  const scopeRoot = path.join(repo, 'scope');
  await writeTree(repo, [
    ['scope/base.txt', 'base'],
    ['scope/drop.txt', 'drop'],
    ['scope/rename-old.txt', 'rename'],
    ['scope/keep.txt', 'keep'],
    ['outside.txt', 'outside'],
  ]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const base = await gitOutput(repo, 'rev-parse', 'HEAD');

  await writeTree(repo, [
    ['scope/base.txt', 'base changed'],
    ['scope/new.txt', 'new'],
    ['outside.txt', 'outside changed'],
  ]);
  await git(repo, 'add', 'scope/new.txt');
  await git(repo, 'rm', 'scope/drop.txt');
  await git(repo, 'mv', 'scope/rename-old.txt', 'scope/rename-new.txt');

  const changed = await selectChangedFiles(scopeRoot, { base });
  assert.deepEqual(changed, ['base.txt', 'new.txt', 'rename-new.txt']);

  await assert.rejects(
    () => selectChangedFiles(scopeRoot, { base: 'does-not-exist' }),
    /invalid ref/i,
  );
});

test('selectChangedFiles returns no paths for delete-only changes in the requested scope', async () => {
  const repo = await makeRepo();
  const scopeRoot = path.join(repo, 'scope');
  await writeTree(repo, [
    ['scope/remove-me.txt', 'remove'],
    ['scope/keep.txt', 'keep'],
  ]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');

  await rm(path.join(repo, 'scope', 'remove-me.txt'));

  const changed = await selectChangedFiles(scopeRoot);
  assert.deepEqual(changed, []);
});
