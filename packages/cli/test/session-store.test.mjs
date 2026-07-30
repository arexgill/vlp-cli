import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReviewSession } from '@arexgill/vlp-core';
import { loadSession, saveSession } from '../src/session-store.mjs';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-session-store-'));
  await mkdir(path.join(root, '.git'));
  return root;
}

function makeSession() {
  return createReviewSession(
    {
      contract: { id: 'task-4', text: 'Review the task.' },
      docUnits: [{ id: 'doc-1', file: 'src/app.js', lineStart: 1, text: 'const answer = 42;' }],
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
    },
    { randomUUID: () => uuid },
  );
}

test('saveSession writes a private atomic session file and loadSession preserves repository-relative evidence', async () => {
  const root = await makeRoot();
  const session = makeSession();

  const saved = await saveSession(root, session);
  const sessionPath = path.join(root, '.vlp', 'reviews', '.sessions', `${session.sessionId}.json`);

  assert.equal(saved.sessionId, session.sessionId);
  assert.equal((await readFile(sessionPath, 'utf8')).includes(root), false);

  const loaded = await loadSession(root, session.sessionId);
  assert.equal(loaded.sessionId, session.sessionId);
  assert.equal(loaded.docUnits[0].file, 'src/app.js');

  if (process.platform !== 'win32') {
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  }

  const sessionJson = await readFile(path.join(root, '.vlp', 'reviews', '.sessions', `${session.sessionId}.json`), 'utf8');
  assert.match(sessionJson, /session-v1-/);
});

test('loadSession rejects malformed or corrupt session files', async () => {
  const root = await makeRoot();
  const session = makeSession();
  const sessionDir = path.join(root, '.vlp', 'reviews', '.sessions');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, `${session.sessionId}.json`), '{"broken":');

  await assert.rejects(() => loadSession(root, session.sessionId), /malformed|corrupt/i);
});
