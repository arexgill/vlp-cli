import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContractDocument } from '@arexgill/vlp-core';

import { confirmContract, createContract } from '../src/commands/contract.mjs';
import { initializeProject } from '../src/project.mjs';

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-contract-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  const nested = path.join(root, 'packages', 'app', 'src');
  const otherNested = path.join(root, 'services', 'api');
  await mkdir(nested, { recursive: true });
  await mkdir(otherNested, { recursive: true });
  await initializeProject(nested);
  return { root, nested, otherNested };
}

const clock = () => new Date('2026-07-30T12:34:56.000Z');

test('createContract rejects unsafe names and uses an atomic exclusive write unless force is set', async () => {
  const { nested } = await makeRepo();

  await assert.rejects(() => createContract(nested, '../escape', { clock }), /unsafe contract name/i);

  const exclusiveWrites = [];
  const created = await createContract(nested, 'Sample Task', {
    clock,
    async writeFileFn(filePath, content, options) {
      exclusiveWrites.push({ filePath, options });
      return writeFile(filePath, content, options);
    },
  });
  assert.equal(created.slug, 'sample-task');
  assert.equal(created.status, 'draft');
  assert.equal(created.path, '.vlp/contracts/sample-task.md');
  assert.match(created.content, /status: draft/);
  assert.equal(exclusiveWrites.length, 1);
  assert.deepEqual(exclusiveWrites[0].options, { flag: 'wx' });

  await assert.rejects(() => createContract(nested, 'Sample Task', { clock }), /already exists/i);

  const forcedWrites = [];
  const forced = await createContract(nested, 'Sample Task', {
    clock,
    force: true,
    async writeFileFn(filePath, content, options) {
      forcedWrites.push({ filePath, options });
      return writeFile(filePath, content, options);
    },
  });
  assert.equal(forced.slug, 'sample-task');
  assert.equal(forced.status, 'draft');
  assert.equal(forcedWrites.length, 1);
  assert.equal(forcedWrites[0].options, undefined);
});

test('createContract and confirmContract resolve the repository root from nested paths', async () => {
  const { root, nested, otherNested } = await makeRepo();

  const created = await createContract(nested, 'Sample Task', { clock });
  assert.equal(created.path, '.vlp/contracts/sample-task.md');
  assert.equal(await readFile(path.join(root, '.vlp/contracts/sample-task.md'), 'utf8'), created.content);
  await assert.rejects(readFile(path.join(nested, '.vlp/contracts/sample-task.md'), 'utf8'));

  const confirmed = await confirmContract(otherNested, 'Sample Task');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(await readFile(path.join(root, '.vlp/contracts/sample-task.md'), 'utf8'), confirmed.content);
  assert.match(confirmed.content, /status: confirmed/);
  await assert.rejects(readFile(path.join(otherNested, '.vlp/contracts/sample-task.md'), 'utf8'));
});

test('confirmContract requires the draft sections and promotes status to confirmed', async () => {
  const { root, nested } = await makeRepo();
  const draft = await createContract(nested, 'Sample Task', { clock });

  const confirmed = await confirmContract(nested, 'Sample Task');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.slug, 'sample-task');
  assert.match(await readFile(path.join(root, '.vlp/contracts/sample-task.md'), 'utf8'), /status: confirmed/);

  await writeFile(
    path.join(root, '.vlp/contracts/sample-task.md'),
    draft.content.replace(/\n## Context\n[\s\S]*$/, '\n'),
  );

  await assert.rejects(() => confirmContract(nested, 'sample-task'), /required section/i);
});

test('createContract and confirmContract reject non-Git roots even with fake config and draft data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-no-git-contract-'));
  await mkdir(path.join(root, '.vlp'), { recursive: true });
  await writeFile(
    path.join(root, '.vlp', 'config.json'),
    `${JSON.stringify({
      version: 1,
      source: {
        include: ['**/*'],
        exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv'],
      },
      runtime: null,
      agentReview: 'off',
    }, null, 2)}\n`,
  );
  await mkdir(path.join(root, '.vlp', 'contracts'), { recursive: true });
  await writeFile(
    path.join(root, '.vlp', 'contracts', 'sample-task.md'),
    buildContractDocument({ slug: 'sample-task', created: '2026-07-30T12:34:56.000Z' }),
  );

  await assert.rejects(() => createContract(root, 'Sample Task', { clock }), /git repository or worktree/i);
  await assert.rejects(() => confirmContract(root, 'Sample Task'), /git repository or worktree/i);
});
