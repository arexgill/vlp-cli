import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeSources } from '@monkeypaw/core';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python');

const js = {
  path: 'search.js',
  language: 'javascript',
  content: `export function search(products, query) {
  if (!query) return products;
  const normalized = query.toLowerCase();
  return products.filter(product => product.name.toLowerCase().includes(normalized));
}`,
};

const ts = {
  path: 'limit.ts',
  language: 'typescript',
  content: `export const limit = (value: number): number => {
  if (value > 100) throw new Error('too large');
  return value;
};`,
};

async function pythonSource(name, fileName = name) {
  return {
    path: name,
    language: 'python',
    content: await readFile(path.join(fixtureRoot, fileName), 'utf8'),
  };
}

test('documents JS/TS behavior and general python structure without changing unit ids or diagnostics', async () => {
  const result = await analyzeSources([js, ts, await pythonSource('analytics.py')]);

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.docUnits.some((unit) => unit.symbol === 'search' && unit.kind === 'signature'), true);
  assert.equal(
    result.docUnits.some(
      (unit) => unit.file === 'search.js' && unit.kind === 'condition' && unit.code === '!query',
    ),
    true,
  );
  assert.equal(
    result.docUnits.some((unit) => unit.file === 'search.js' && unit.kind === 'call' && unit.code.includes('.filter')),
    true,
  );
  assert.equal(result.docUnits.some((unit) => unit.file === 'limit.ts' && unit.kind === 'throw'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'analytics.py' && unit.kind === 'module'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'analytics.py' && unit.kind === 'class'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'analytics.py' && unit.kind === 'decorator'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'analytics.py' && unit.kind === 'yield'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'analytics.py' && unit.kind === 'catch'), true);
  assert.equal(result.docUnits.every((unit) => unit.lineStart >= 1 && unit.id.startsWith('doc-')), true);
  assert.equal(new Set(result.docUnits.map((unit) => unit.id)).size, result.docUnits.length);
});

test('returns diagnostics for invalid JS/Python files and preserves other parseable files', async () => {
  const brokenJs = { path: 'broken.js', language: 'javascript', content: 'function {' };
  const result = await analyzeSources([
    brokenJs,
    js,
    await pythonSource('poison.py'),
    await pythonSource('broken.py'),
  ]);

  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.file === 'broken.js'), true);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.file === 'broken.py'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'search.js'), true);
  assert.equal(result.docUnits.some((unit) => unit.file === 'poison.py' && unit.kind === 'raise'), true);
});

test('propagates python infrastructure failures instead of folding them into diagnostics', async () => {
  const missingPythonChild = {
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: { write() {}, end() {} },
    on(event, handler) {
      if (event === 'error') {
        queueMicrotask(() => handler(Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })));
      }
      return this;
    },
    kill() {},
  };

  const spawnFn = () => missingPythonChild;

  await assert.rejects(
    analyzeSources([{ path: 'broken.py', language: 'python', content: 'def example():\n    return 1\n' }], { spawnFn }),
    (error) => {
      assert.equal(error.code, 'ERR_MONKEYPAW_PYTHON_ANALYSIS');
      assert.equal(error.message, 'Python analysis failed');
      return true;
    },
  );
});
