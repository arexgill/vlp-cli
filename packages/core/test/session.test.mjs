import assert from 'node:assert/strict';
import test from 'node:test';

import { CORE_LIMITS, DecisionEnvelopeValidationError, applyDecisions, createReviewSession } from '@arexgill/vlp-core';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function makeSession(overrides = {}) {
  return createReviewSession(
    {
      contract: { id: 'task-4', text: 'Review the task.' },
      docUnits: [
        { id: 'doc-1', file: 'src/app.js', lineStart: 2, text: 'const answer = 42;' },
      ],
      diagnostics: [],
      questions: [
        {
          id: 'q-1',
          type: 'missing-step',
          title: 'Check the answer',
          ask: 'Should the answer stay 42?',
          reason: 'The contract says so.',
          promptEvidence: 'Keep the answer at 42.',
          docUnitIds: ['doc-1'],
        },
      ],
      ...overrides,
    },
    { randomUUID: () => uuid },
  );
}

test('createReviewSession generates a versioned opaque session id from the injected UUID', () => {
  const first = makeSession();
  const second = createReviewSession(
    {
      contract: { id: 'task-4', text: 'A different contract.' },
      docUnits: [],
      diagnostics: [],
      questions: [],
    },
    { randomUUID: () => uuid },
  );

  assert.equal(first.sessionId, `session-v1-${uuid.replaceAll('-', '')}`);
  assert.equal(first.sessionId, second.sessionId);
  assert.match(first.sessionId, /^session-v1-[0-9a-f]{32}$/);
  assert.equal(first.version, 1);
});

test('applyDecisions keeps original question evidence and strips caller-supplied replacements when the session id matches', () => {
  const session = makeSession();
  const resolved = applyDecisions(session, {
    sessionId: ` ${session.sessionId}\r\n`,
    decisions: [
      {
        questionId: 'q-1',
        decision: 'correct',
        answer: 'Keep it at 42.',
        question: { ask: 'replace me' },
        promptEvidence: 'replace me',
        docUnitIds: ['evil'],
      },
    ],
  });

  assert.equal(resolved.sessionId, session.sessionId);
  assert.deepEqual(resolved.decisions, [
    {
      questionId: 'q-1',
      decision: 'correct',
      answer: 'Keep it at 42.',
    },
  ]);
  assert.equal(resolved.questions[0].ask, 'Should the answer stay 42?');
  assert.equal(resolved.questions[0].promptEvidence, 'Keep the answer at 42.');
});

test('applyDecisions rejects malformed submitted session ids before validating question decisions', () => {
  const session = makeSession();
  let error = null;

  try {
    applyDecisions(session, {
      sessionId: 'bad',
      decisions: [{ questionId: 'bad', decision: 'accept', answer: '' }],
    });
  } catch (thrown) {
    error = thrown;
  }

  assert(error instanceof DecisionEnvelopeValidationError);
  assert.equal(error.code, 'ERR_VLP_DECISION_SESSION');
  assert.match(error.message, /invalid/i);
});

test('applyDecisions rejects mismatched submitted session ids before validating question decisions', () => {
  const session = makeSession();
  let error = null;

  try {
    applyDecisions(session, {
      sessionId: 'session-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      decisions: [{ questionId: 'bad', decision: 'accept', answer: '' }],
    });
  } catch (thrown) {
    error = thrown;
  }

  assert(error instanceof DecisionEnvelopeValidationError);
  assert.equal(error.code, 'ERR_VLP_DECISION_SESSION_MISMATCH');
  assert.match(error.message, /does not match loaded session/);
});

test('applyDecisions rejects unknown questions, duplicate answers, invalid decisions, blank corrections, and oversized responses', () => {
  const session = makeSession();

  assert.throws(
    () =>
      applyDecisions(session, {
        sessionId: session.sessionId,
        decisions: [{ questionId: 'bad', decision: 'accept', answer: '' }],
      }),
    /Unknown question/,
  );
  assert.throws(
    () =>
      applyDecisions(session, {
        sessionId: session.sessionId,
        decisions: [{ questionId: 'q-1', decision: 'maybe', answer: '' }],
      }),
    /Invalid decision/,
  );
  assert.throws(
    () =>
      applyDecisions(session, {
        sessionId: session.sessionId,
        decisions: [{ questionId: 'q-1', decision: 'correct', answer: ' ' }],
      }),
    /Correction text is required/,
  );
  assert.throws(
    () =>
      applyDecisions(session, {
        sessionId: session.sessionId,
        decisions: [
          { questionId: 'q-1', decision: 'accept', answer: '' },
          { questionId: 'q-1', decision: 'accept', answer: '' },
        ],
      }),
    /Duplicate response/,
  );
  assert.throws(
    () =>
      applyDecisions(session, {
        sessionId: session.sessionId,
        decisions: [
          {
            questionId: 'q-1',
            decision: 'accept',
            answer: 'x'.repeat(CORE_LIMITS.maxResponseCharacters + 1),
          },
        ],
      }),
    new RegExp(`exceeds ${CORE_LIMITS.maxResponseCharacters} characters`),
  );
});
