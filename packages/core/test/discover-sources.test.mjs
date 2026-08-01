import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CORE_LIMITS, discoverSources } from '@monkeypaw/core';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'source-tree');

async function materializeFixtureTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-fixture-'));
  const sourceRoot = path.join(root, 'src');

  const files = [
    ['a.js', 'a.js.txt'],
    ['b.ts', 'b.ts.txt'],
    ['c.py', 'c.py.txt'],
    ['poison.js', 'poison.js.txt'],
    ['note.txt', 'note.txt'],
    ['nested/build/skip.ts', 'b.ts.txt'],
    ['node_modules/ignored.js', 'ignored.js.txt'],
    ['node_modules/ignored.py', 'ignored.py.txt'],
  ];

  for (const [relativePath, fixtureName] of files) {
    const targetPath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(path.join(fixtureRoot, fixtureName), 'utf8'));
  }

  return sourceRoot;
}

test('discovers supported files deterministically with repository-relative paths', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({ root: sourceRoot });

  assert.deepEqual(sources.map((source) => source.path), ['a.js', 'b.ts', 'c.py', 'poison.js']);
  assert.deepEqual(sources.map((source) => source.language), [
    'javascript',
    'typescript',
    'python',
    'javascript',
  ]);
  assert.equal(sources[2].content.includes('name.strip().lower()'), true);
  assert.equal(sources[3].content.includes('fixture code must never execute'), true);
});

test('accepts one supported source file without leaking its absolute path', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({
    root: sourceRoot,
    paths: [path.join(sourceRoot, 'a.js')],
  });

  assert.deepEqual(sources.map((source) => source.path), ['a.js']);
  assert.equal(JSON.stringify(sources).includes(sourceRoot), false);
});

test('rejects unsupported and empty code inputs', async () => {
  const sourceRoot = await materializeFixtureTree();

  await assert.rejects(
    discoverSources({
      root: sourceRoot,
      paths: [path.join(sourceRoot, 'note.txt')],
    }),
    /Supported extensions/,
  );

  const empty = await mkdtemp(path.join(tmpdir(), 'monkeypaw-empty-'));
  await assert.rejects(discoverSources({ root: empty }), /No supported source files/);
});

test('enforces central file count and file size limits', async () => {
  const limitRoot = await mkdtemp(path.join(tmpdir(), 'monkeypaw-limit-'));

  for (let index = 0; index < CORE_LIMITS.maxSourceFiles + 1; index += 1) {
    await writeFile(path.join(limitRoot, `f${index}.ts`), 'export const value = 1;\n');
  }

  await assert.rejects(discoverSources({ root: limitRoot }), /Source limit exceeded/);

  const sizeRoot = await mkdtemp(path.join(tmpdir(), 'monkeypaw-size-'));
  await writeFile(path.join(sizeRoot, 'big.js'), 'x'.repeat(CORE_LIMITS.maxSourceFileBytes + 1));

  await assert.rejects(discoverSources({ root: sizeRoot }), /Source file exceeds 1 MiB/);
});

test('applies include/exclude globs to explicit paths and full discovery using repository-relative paths', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({
    root: sourceRoot,
    paths: ['a.js', 'b.ts', 'c.py', 'nested/build/skip.ts'],
    sourceConfig: {
      include: ['**/*.ts', '**/*.py'],
      exclude: ['build', '**/*.py'],
    },
  });

  assert.deepEqual(sources.map((source) => source.path), ['b.ts']);
});

test('skips raced deletions and permits in-root symlinks without importing fixture modules', async () => {
  delete globalThis.__monkeypawCoreFixtureImported;

  const sourceRoot = await materializeFixtureTree();
  const deletedPath = path.join(sourceRoot, 'deleted.js');
  await writeFile(deletedPath, 'export const deleted = true;\n');
  await rm(deletedPath);
  await symlink(path.join(sourceRoot, 'poison.js'), path.join(sourceRoot, 'linked-poison.js'));

  const sources = await discoverSources({
    root: sourceRoot,
    paths: [deletedPath, path.join(sourceRoot, 'linked-poison.js')],
  });

  assert.equal(globalThis.__monkeypawCoreFixtureImported, undefined);
  assert.deepEqual(sources.map((source) => source.path), ['linked-poison.js']);
  assert.equal(sources[0].content.includes('globalThis.__monkeypawCoreFixtureImported = true;'), true);
});

test('rejects explicit symlink escapes before reading external source content', async () => {
  const sourceRoot = await materializeFixtureTree();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'monkeypaw-outside-'));
  const externalTarget = path.join(outsideRoot, 'escape.js');
  await writeFile(externalTarget, 'globalThis.__outside = true;\n');
  await symlink(externalTarget, path.join(sourceRoot, 'escape.js'));

  await assert.rejects(
    discoverSources({
      root: sourceRoot,
      paths: [path.join(sourceRoot, 'escape.js')],
    }),
    /outside the configured root/i,
  );
});

test('reads source text without importing or evaluating fixture modules', async () => {
  delete globalThis.__monkeypawCoreFixtureImported;

  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({
    root: sourceRoot,
    paths: [path.join(sourceRoot, 'poison.js')],
  });

  assert.equal(globalThis.__monkeypawCoreFixtureImported, undefined);
  assert.equal(sources[0].content.includes('globalThis.__monkeypawCoreFixtureImported = true;'), true);
});
