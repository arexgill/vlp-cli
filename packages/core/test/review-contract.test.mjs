import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverSources, reviewContract } from '@monkeypaw/core';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'source-tree');

async function materializeFixtureTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-fixture-'));
  const sourceRoot = path.join(root, 'src');

  const files = [
    ['a.js', 'a.js.txt'],
    ['b.ts', 'b.ts.txt'],
    ['poison.js', 'poison.js.txt'],
    ['note.txt', 'note.txt'],
    ['node_modules/ignored.js', 'ignored.js.txt'],
  ];

  for (const [relativePath, fixtureName] of files) {
    const targetPath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(path.join(fixtureRoot, fixtureName), 'utf8'));
  }

  return sourceRoot;
}

const contract = {
  id: 'search-scope',
  text: 'Build searchProducts(products, query). Search relevance must consider product name, description, category, and tags. If the query is empty, return all products. Matching must be case-insensitive.',
};

test('creates stable analysis and fingerprint data without leaking absolute fixture paths', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({ root: sourceRoot });
  const first = await reviewContract({ contract, sources });
  const second = await reviewContract({ contract, sources });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(Object.hasOwn(first, 'id'), false);
  assert.equal(Object.hasOwn(first, 'sessionId'), false);
  assert.equal(first.meta.sourceCount, 3);
  assert.equal(first.meta.engine, 'heuristic-local-poc');
  assert.equal(JSON.stringify(first).includes(sourceRoot), false);
  assert.equal(first.docUnits.some((unit) => unit.file === 'a.js'), true);
  assert.equal(first.diagnostics.length, 0);
  assert.equal(first.questions.some((question) => question.type === 'missing-step'), true);
  assert.equal(Object.isFrozen(first), true);
});
