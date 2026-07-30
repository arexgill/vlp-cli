import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSources } from '@arexgill/vlp-core';

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

test('documents signatures, conditions, calls, returns, and throws', async () => {
  const result = await analyzeSources([js, ts]);

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
  assert.equal(result.docUnits.every((unit) => unit.lineStart >= 1 && unit.id.startsWith('doc-')), true);
  assert.equal(new Set(result.docUnits.map((unit) => unit.id)).size, result.docUnits.length);
});

test('returns a diagnostic and preserves other parseable files', async () => {
  const broken = { path: 'broken.js', language: 'javascript', content: 'function {' };
  const result = await analyzeSources([broken, js]);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].file, 'broken.js');
  assert.equal(result.docUnits.some((unit) => unit.file === 'search.js'), true);
});
