import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createReviewSession } from '@arexgill/vlp-core';

import { runTerminalReview } from '../src/terminal-review.mjs';

const session = createReviewSession(
  {
    contract: { id: 'sample', text: 'Keep the answer correct.' },
    docUnits: [
      { id: 'doc-1', file: 'src/app.js', lineStart: 2, text: 'const answer = 42;' },
      { id: 'doc-2', file: 'src/app.js', lineStart: 5, text: 'return answer;' },
    ],
    diagnostics: [],
    questions: [
      {
        id: 'q-1',
        type: 'wrong-value',
        severity: 'medium',
        title: 'Validate the answer',
        ask: 'Should the answer stay 42?',
        reason: 'The contract does not mention 42.',
        promptEvidence: 'Keep the answer correct.',
        docUnitIds: ['doc-1', 'doc-2'],
      },
    ],
  },
  { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' },
);

function makeIo(input) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    output += chunk;
  });
  stderr.on('data', (chunk) => {
    errors += chunk;
  });

  stdin.end(input);
  return { stdin, stdout, stderr, output: () => output, errors: () => errors };
}

test('runTerminalReview collects single-line corrective input, numbers evidence, and prints a summary', async () => {
  const io = makeIo('c\nKeep it at 7.\n');

  const result = await runTerminalReview({ session, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.decisions, [{ questionId: 'q-1', decision: 'correct', answer: 'Keep it at 7.' }]);
  assert.match(io.output(), /1\. src\/app\.js:2 — const answer = 42;/);
  assert.match(io.output(), /2\. src\/app\.js:5 — return answer;/);
  assert.match(io.output(), /Correction:/);
  assert.match(io.output(), /Accepted: 0/);
  assert.match(io.output(), /Corrected: 1/);
  assert.equal(io.errors(), '');
});

test('runTerminalReview prints FastAPI source and runtime evidence when present', async () => {
  const io = makeIo('a\n');
  const fastApiSession = createReviewSession(
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

  const result = await runTerminalReview({ session: fastApiSession, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr });

  assert.equal(result.status, 'completed');
  assert.match(io.output(), /Source evidence: src\/api\.py:6 \(Target: \/items\/\{item_id\}\)/);
  assert.match(io.output(), /Runtime OpenAPI evidence: \[openapi-drift\] \/items\/\{item_id\} post/);
  assert.equal(io.errors(), '');
});

test('runTerminalReview aborts cleanly when the reviewer quits', async () => {
  const io = makeIo('q\n');

  const result = await runTerminalReview({ session, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr });

  assert.equal(result.status, 'aborted');
  assert.deepEqual(result.decisions, []);
  assert.match(io.errors(), /aborted/i);
});

test('runTerminalReview aborts on EOF at Correction without reprompting', async () => {
  const io = makeIo('c\n');
  const result = await Promise.race([
    runTerminalReview({ session, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for EOF abort')), 150);
    }),
  ]);

  assert.equal(result.status, 'aborted');
  assert.deepEqual(result.decisions, []);
  assert.match(io.errors(), /aborted/i);
  assert.match(io.output(), /Correction:/);
});
