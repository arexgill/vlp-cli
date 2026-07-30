import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyDecisions, createReviewSession } from '@arexgill/vlp-core';

import { writeFinalArtifacts } from '../src/review-artifacts.mjs';
import { loadSession, saveSession } from '../src/session-store.mjs';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const oldReport = '# Previous report\n';
const oldAudit = '{"status":"previous"}\n';

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-review-artifacts-'));
  await mkdir(path.join(root, '.git'));
  return root;
}

function makeSessions() {
  const session = createReviewSession(
    {
      contract: {
        id: 'task-8',
        slug: 'task-8',
        status: 'confirmed',
        path: '.vlp/contracts/task-8.md',
        content: '# Task 8\n\n- Restore prior final artifacts on failure.',
      },
      sources: [
        {
          path: 'src/app.js',
          content: 'export const answer = 42;\n',
        },
      ],
      docUnits: [
        {
          id: 'doc-1',
          file: 'src/app.js',
          lineStart: 1,
          kind: 'function',
          text: 'export const answer = 42;',
        },
      ],
      diagnostics: [],
      questions: [
        {
          id: 'q-1',
          type: 'wrong-value',
          severity: 'high',
          title: 'Validate the answer',
          ask: 'Should the answer stay 42?',
          reason: 'The contract says yes.',
          promptEvidence: 'Keep the answer at 42.',
          docUnitIds: ['doc-1'],
        },
      ],
      meta: {
        sourceCount: 1,
        docUnitCount: 1,
        questionCount: 1,
      },
    },
    { randomUUID: () => uuid },
  );

  const resolved = applyDecisions(session, {
    sessionId: session.sessionId,
    decisions: [{ questionId: 'q-1', decision: 'correct', answer: 'Keep the answer at 42.' }],
  });

  return { session, resolved };
}

async function seedExistingArtifacts(root, session) {
  const reviewDir = path.join(root, '.vlp', 'reviews');
  await mkdir(reviewDir, { recursive: true });
  await saveSession(root, session);
  await writeFile(path.join(reviewDir, `${session.sessionId}.md`), oldReport);
  await writeFile(path.join(reviewDir, `${session.sessionId}.json`), oldAudit);
}

async function assertArtifactsUnchanged(root, sessionId) {
  const reviewDir = path.join(root, '.vlp', 'reviews');
  const sessionDir = path.join(reviewDir, '.sessions');

  assert.equal(await readFile(path.join(reviewDir, `${sessionId}.md`), 'utf8'), oldReport);
  assert.equal(await readFile(path.join(reviewDir, `${sessionId}.json`), 'utf8'), oldAudit);
  assert.deepEqual((await loadSession(root, sessionId)).decisions, []);
  assert.deepEqual((await readdir(reviewDir)).sort(), ['.sessions', `${sessionId}.json`, `${sessionId}.md`]);
  assert.deepEqual(await readdir(sessionDir), [`${sessionId}.json`]);
}

function failWriteOnCall(targetCall, message) {
  let writeCount = 0;

  return async (filePath, contents, options) => {
    writeCount += 1;
    if (writeCount === targetCall) {
      await writeFile(filePath, 'partial write', options);
      throw new Error(message);
    }
    return writeFile(filePath, contents, options);
  };
}

function failCommitWhere(shouldFail, message) {
  return async (from, to) => {
    if (from.endsWith('.tmp') && shouldFail({ from, to })) {
      throw new Error(message);
    }
    return rename(from, to);
  };
}

function failOnce(when, message) {
  return { when, message, persistent: false, used: false };
}

function createRmPlan(rules = []) {
  const calls = [];

  return {
    calls,
    async fn(target, options) {
      calls.push({ target, options });
      for (const rule of rules) {
        if (!rule.when({ target, options })) continue;
        if (!rule.persistent && rule.used) continue;
        rule.used = true;
        throw new Error(rule.message);
      }
      return rm(target, options);
    },
  };
}

test('writeFinalArtifacts removes a partial temp file when the report stage write throws', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      writeFileFn: failWriteOnCall(1, 'Injected report stage write failure'),
    }),
    /Injected report stage write failure/,
  );

  await assertArtifactsUnchanged(root, session.sessionId);
});

test('writeFinalArtifacts removes a partial temp file when the audit stage write throws', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      writeFileFn: failWriteOnCall(2, 'Injected audit stage write failure'),
    }),
    /Injected audit stage write failure/,
  );

  await assertArtifactsUnchanged(root, session.sessionId);
});

test('writeFinalArtifacts rolls back the committed report and restores prior artifacts when the audit commit throws', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);
  const auditPath = path.join(root, '.vlp', 'reviews', `${session.sessionId}.json`);

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      renameFn: failCommitWhere(({ to }) => to === auditPath, 'Injected audit commit failure'),
    }),
    /Injected audit commit failure/,
  );

  await assertArtifactsUnchanged(root, session.sessionId);
});

test('writeFinalArtifacts removes a partial temp file when the session stage write throws', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      writeFileFn: failWriteOnCall(3, 'Injected session stage write failure'),
    }),
    /Injected session stage write failure/,
  );

  await assertArtifactsUnchanged(root, session.sessionId);
});

test('writeFinalArtifacts rolls back committed report and audit files when the session commit throws', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);
  const sessionFileName = `${session.sessionId}.json`;

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      renameFn: failCommitWhere(
        ({ to }) => to.endsWith(path.join('.sessions', sessionFileName)),
        'Injected session commit failure',
      ),
    }),
    /Injected session commit failure/,
  );

  await assertArtifactsUnchanged(root, session.sessionId);
});

test('writeFinalArtifacts attempts cleanup for every stage before throwing aggregated cleanup failures', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);

  const rmPlan = createRmPlan([
    failOnce(
      ({ target }) => target.includes(path.join('.vlp', 'reviews', `.${session.sessionId}.md.`)) && target.endsWith('.bak'),
      'Injected report cleanup failure',
    ),
    failOnce(
      ({ target }) => target.includes(path.join('.vlp', 'reviews', `.${session.sessionId}.json.`))
        && !target.includes(path.join('.vlp', 'reviews', '.sessions'))
        && target.endsWith('.bak'),
      'Injected audit cleanup failure',
    ),
    failOnce(
      ({ target }) => target.includes(path.join('.vlp', 'reviews', '.sessions', `.${session.sessionId}.json.`)) && target.endsWith('.bak'),
      'Injected session cleanup failure',
    ),
  ]);

  const error = await writeFinalArtifacts(root, 'resolve', resolved, {
    rmFn: rmPlan.fn,
  }).catch((caught) => caught);

  assert.equal(error?.message, 'Injected report cleanup failure');
  assert.deepEqual(error?.secondaryErrors?.map((failure) => failure.message), [
    'Injected audit cleanup failure',
    'Injected session cleanup failure',
  ]);
  assert.equal(rmPlan.calls.some(({ target }) => target.includes(path.join('.vlp', 'reviews', `.${session.sessionId}.md.`))), true);
  assert.equal(rmPlan.calls.some(({ target }) => target.includes(path.join('.vlp', 'reviews', `.${session.sessionId}.json.`)) && !target.includes(path.join('.vlp', 'reviews', '.sessions'))), true);
  assert.equal(rmPlan.calls.some(({ target }) => target.includes(path.join('.vlp', 'reviews', '.sessions', `.${session.sessionId}.json.`))), true);

  await rm(root, { recursive: true, force: true });
});

test('writeFinalArtifacts commits the session stage after report and audit files on success', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);
  const renameCalls = [];

  const result = await writeFinalArtifacts(root, 'resolve', resolved, {
    renameFn: async (from, to) => {
      renameCalls.push({ from, to });
      return rename(from, to);
    },
  });

  const commitTargets = renameCalls
    .filter(({ from }) => from.endsWith('.tmp'))
    .map(({ to }) => (
      to.endsWith(path.join('.sessions', `${session.sessionId}.json`))
        ? path.join('.vlp', 'reviews', '.sessions', `${session.sessionId}.json`)
        : path.relative(root, to)
    ));

  assert.deepEqual(commitTargets.slice(-3), [
    path.join('.vlp', 'reviews', `${session.sessionId}.md`),
    path.join('.vlp', 'reviews', `${session.sessionId}.json`),
    path.join('.vlp', 'reviews', '.sessions', `${session.sessionId}.json`),
  ]);
  assert.equal(result.reportPath, `.vlp/reviews/${session.sessionId}.md`);
});

test('writeFinalArtifacts preserves the primary failure when rollback or cleanup also fail', async () => {
  const root = await makeRoot();
  const { session, resolved } = makeSessions();
  await seedExistingArtifacts(root, session);
  const sessionFileName = `${session.sessionId}.json`;

  await assert.rejects(
    () => writeFinalArtifacts(root, 'resolve', resolved, {
      renameFn: failCommitWhere(
        ({ to }) => to.endsWith(path.join('.sessions', sessionFileName)),
        'Injected session commit failure',
      ),
      rmFn: async () => {
        throw new Error('Injected cleanup failure');
      },
    }),
    (error) => {
      assert.equal(error.message, 'Injected session commit failure');
      return true;
    },
  );

  await rm(root, { recursive: true, force: true });
});
