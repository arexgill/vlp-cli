import assert from 'node:assert/strict';
import test from 'node:test';

import { CORE_LIMITS, analyzeSources, detectQuestions } from '@arexgill/vlp-core';

const contract = {
  text: 'Build searchProducts(products, query). Search relevance must consider product name, description, category, and tags. If the query is empty, return all products. Matching must be case-insensitive.',
};

const source = {
  path: 'search.js',
  language: 'javascript',
  content: `export function searchProducts(products, query) {
  if (!query) return products;
  return products.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));
}`,
};

test('asks a targeted missing-step question with trace evidence', async () => {
  const analysis = await analyzeSources([source]);
  const questions = detectQuestions({ contract, analysis });
  const question = questions.find((item) => item.type === 'missing-step');

  assert.ok(question);
  assert.match(question.ask, /description|category|tags/i);
  assert.match(question.promptEvidence, /Search relevance/);
  assert.ok(question.docUnitIds.length > 0);
  assert.match(question.reason, /not strongly represented/i);
  assert.equal(
    questions.some(
      (item) => item.type === 'missing-step' && /empty query|case-insensitive/i.test(item.promptEvidence),
    ),
    false,
  );
});

test('flags an unprompted comparison literal as a value to validate', () => {
  const analysis = {
    docUnits: [
      {
        id: 'doc-limit',
        file: 'limit.js',
        symbol: 'limit',
        kind: 'condition',
        lineStart: 2,
        lineEnd: 2,
        text: 'When items.length > 25, execution follows this branch.',
        code: 'items.length > 25',
        keywords: ['items', 'length'],
      },
    ],
    diagnostics: [],
  };

  const questions = detectQuestions({ contract: { text: 'Limit the results.' }, analysis });

  assert.equal(
    questions.some((item) => item.type === 'wrong-value' && item.ask.includes('25')),
    true,
  );
});

test('returns stable, severity-ordered, de-duplicated questions capped by the central limit', async () => {
  const analysis = await analyzeSources([source]);
  const first = detectQuestions({ contract, analysis });
  const second = detectQuestions({ contract, analysis });
  const weights = { high: 3, medium: 2, low: 1 };

  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((item) => item.id)).size, first.length);
  assert.deepEqual(
    first.map((item) => weights[item.severity]),
    first.map((item) => weights[item.severity]).sort((left, right) => right - left),
  );
  assert.equal(first.length <= CORE_LIMITS.maxQuestions, true);
});

test('keeps only the most actionable category for each prompt trace', () => {
  const analysis = {
    docUnits: [
      {
        id: 'doc-return',
        file: 'input.js',
        symbol: 'read',
        kind: 'return',
        lineStart: 2,
        lineEnd: 2,
        text: 'read returns an empty array.',
        code: '[]',
        keywords: ['read', 'return', 'empty', 'array'],
      },
    ],
    diagnostics: [],
  };
  const overlapPrompt = 'Invalid non-array input must produce a clear error. Relevance must consider description and category.';
  const questions = detectQuestions({ contract: { text: overlapPrompt }, analysis });
  const invalidTrace = questions.filter((item) => /Invalid non-array/.test(item.promptEvidence));
  const relevanceTrace = questions.filter((item) => /Relevance must/.test(item.promptEvidence));

  assert.equal(invalidTrace.length, 1);
  assert.equal(invalidTrace[0].type, 'api-use');
  assert.equal(relevanceTrace.length, 1);
  assert.equal(relevanceTrace[0].type, 'missing-step');
});
