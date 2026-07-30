import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { confirmContract, createContract } from '../src/commands/contract.mjs';
import { initializeProject } from '../src/project.mjs';

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-contract-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await initializeProject(root);
  return root;
}

const clock = () => new Date('2026-07-30T12:34:56.000Z');

test('createContract rejects unsafe names and refuses overwrite without force', async () => {
  const root = await makeRoot();

  await assert.rejects(() => createContract(root, '../escape', { clock }), /unsafe contract name/i);

  const created = await createContract(root, 'Sample Task', { clock });
  assert.equal(created.slug, 'sample-task');
  assert.equal(created.status, 'draft');
  assert.equal(created.path, '.vlp/contracts/sample-task.md');
  assert.match(created.content, /status: draft/);

  await assert.rejects(() => createContract(root, 'Sample Task', { clock }), /already exists/i);

  const forced = await createContract(root, 'Sample Task', { clock, force: true });
  assert.equal(forced.slug, 'sample-task');
  assert.equal(forced.status, 'draft');
});

test('confirmContract requires the draft sections and promotes status to confirmed', async () => {
  const root = await makeRoot();
  const draft = await createContract(root, 'Sample Task', { clock });

  const confirmed = await confirmContract(root, 'Sample Task');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.slug, 'sample-task');
  assert.match(await readFile(path.join(root, '.vlp/contracts/sample-task.md'), 'utf8'), /status: confirmed/);

  await writeFile(
    path.join(root, '.vlp/contracts/sample-task.md'),
    draft.content.replace(/\n## Context\n[\s\S]*$/, '\n'),
  );

  await assert.rejects(() => confirmContract(root, 'sample-task'), /required section/i);
});
