import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CORE_LIMITS, buildReport, discoverSources, reviewContract } from '@arexgill/vlp-core';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'source-tree');

async function materializeFixtureTree() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-fixture-'));
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
  const session = await reviewContract({ contract, sources });
  const correction = 'Search name, description, category, and tags.';
  const acceptedQuestion = session.questions.find((question) => question.type === 'wrong-value') ?? session.questions[0];
  const correctedQuestion = session.questions.find((question) => question.type === 'missing-step') ?? session.questions[0];
  const ignoredQuestion = session.questions.find((question) => question.id !== correctedQuestion.id && question.id !== acceptedQuestion.id);

  const markdown = buildReport({
    contract,
    session: {
      ...session,
      diagnostics: [{ file: 'broken.ts', line: 3, message: 'Unexpected token' }],
    },
    decisions: [
      { questionId: correctedQuestion.id, decision: 'correct', answer: correction },
      { questionId: acceptedQuestion.id, decision: 'accept', answer: 'Keep that behavior.' },
      ...(ignoredQuestion ? [{ questionId: ignoredQuestion.id, decision: 'irrelevant', answer: '' }] : []),
    ],
  });

  assert.match(markdown, /# VLP Review Report/);
  assert.match(markdown, /Search name, description, category, and tags/);
  assert.match(markdown, /Keep that behavior/);
  assert.match(markdown, /broken\.ts:3/);
  assert.match(markdown, /Update the generated code/);
  assert.doesNotMatch(markdown, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(markdown, /\/Users\//);
});

test('rejects unknown questions, decisions, duplicate answers, empty corrections, and oversized responses', async () => {
  const sourceRoot = await materializeFixtureTree();
  const sources = await discoverSources({ root: sourceRoot });
  const session = await reviewContract({ contract, sources });
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
