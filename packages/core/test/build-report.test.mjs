import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CORE_LIMITS, buildReport, createReviewSession, discoverSources, reviewContract } from '@monkeypaw/core';

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
  text: 'Search all product fields.',
};

test('builds an agent-ready report without absolute paths', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({ root: sourceRoot });
  const analysis = await reviewContract({ contract, sources });
  const session = createReviewSession(
    {
      ...analysis,
      diagnostics: [{ file: 'broken.ts', line: 3, message: 'Unexpected token' }],
    },
    { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' },
  );
  const correction = 'Search name, description, category, and tags.';
  const acceptedQuestion = session.questions.find((question) => question.type === 'wrong-value') ?? session.questions[0];
  const correctedQuestion = session.questions.find((question) => question.type === 'missing-step') ?? session.questions[0];
  const ignoredQuestion = session.questions.find((question) => question.id !== correctedQuestion.id && question.id !== acceptedQuestion.id);

  const markdown = buildReport({
    contract,
    session,
    decisions: [
      { questionId: correctedQuestion.id, decision: 'correct', answer: correction },
      { questionId: acceptedQuestion.id, decision: 'accept', answer: 'Keep that behavior.' },
      ...(ignoredQuestion ? [{ questionId: ignoredQuestion.id, decision: 'irrelevant', answer: '' }] : []),
    ],
  });

  assert.match(markdown, /# Monkeypaw Review Report/);
  assert.match(markdown, new RegExp(`Session: ${session.sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(markdown, /Search name, description, category, and tags/);
  assert.match(markdown, /Keep that behavior/);
  assert.match(markdown, /broken\.ts:3/);
  assert.match(markdown, /Update the generated code/);
  assert.doesNotMatch(markdown, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(markdown, /\/Users\//);
});

test('buildReport renders FastAPI source and runtime evidence for reviewer-facing questions', () => {
  const session = createReviewSession(
    {
      contract: { id: 'api-runtime', text: 'Review the FastAPI route.' },
      docUnits: [],
      diagnostics: [],
      questions: [
        {
          id: 'q-fastapi',
          type: 'method-drift',
          severity: 'high',
          title: 'Method drift: /items/{item_id}',
          ask: 'Static analysis found GET /items/{item_id}, but the runtime schema exposes different methods. Which method is correct?',
          reason: 'The runtime OpenAPI methods do not match the static FastAPI decorator.',
          promptEvidence: '/items/{item_id}:get',
          sourceEvidence: { file: 'src/api.py', lineStart: 6, target: '/items/{item_id}' },
          runtimeEvidence: { type: 'openapi-drift', path: '/items/{item_id}', methods: ['post'] },
          docUnitIds: [],
        },
      ],
    },
    { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' },
  );

  const markdown = buildReport({
    contract: { id: 'api-runtime', text: 'Review the FastAPI route.' },
    session,
    decisions: [{ questionId: 'q-fastapi', decision: 'accept', answer: '' }],
  });

  assert.match(markdown, /Source evidence:\*\* src\/api\.py:6 \(Target: \/items\/\{item_id\}\)/);
  assert.match(markdown, /Runtime OpenAPI evidence:\*\* \[openapi-drift\] \/items\/\{item_id\} post/);
});

test('rejects unknown questions, decisions, duplicate answers, empty corrections, and oversized responses', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({ root: sourceRoot });
  const analysis = await reviewContract({ contract, sources });
  const session = createReviewSession(analysis, { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
  const questionId = session.questions[0].id;

  assert.throws(
    () => buildReport({ contract, session, decisions: [{ questionId: 'bad', decision: 'accept', answer: '' }] }),
    /Unknown question/,
  );
  assert.throws(
    () => buildReport({ contract, session, decisions: [{ questionId, decision: 'maybe', answer: '' }] }),
    /Invalid decision/,
  );
  assert.throws(
    () => buildReport({ contract, session, decisions: [{ questionId, decision: 'correct', answer: ' ' }] }),
    /Correction text is required/,
  );
  assert.throws(
    () =>
      buildReport({
        contract,
        session,
        decisions: [
          { questionId, decision: 'accept', answer: '' },
          { questionId, decision: 'accept', answer: '' },
        ],
      }),
    /Duplicate response/,
  );
  assert.throws(
    () =>
      buildReport({
        contract,
        session,
        decisions: [{ questionId, decision: 'accept', answer: 'x'.repeat(CORE_LIMITS.maxResponseCharacters + 1) }],
      }),
    new RegExp(`exceeds ${CORE_LIMITS.maxResponseCharacters} characters`),
  );
});
