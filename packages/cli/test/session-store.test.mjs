import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReviewSession } from '@monkeypaw/core';
import { loadSession, saveSession, stageSessionSave } from '../src/session-store.mjs';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'monkeypaw-session-store-'));
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

function failOnce(when, message) {
  return { when, message, persistent: false, used: false };
}

function failAlways(when, message) {
  return { when, message, persistent: true, used: false };
}

function createRenamePlan(rules = []) {
  return async (from, to) => {
    for (const rule of rules) {
      if (!rule.when({ from, to })) continue;
      if (!rule.persistent && rule.used) continue;
      rule.used = true;
      throw new Error(rule.message);
    }
    return rename(from, to);
  };
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

test('saveSession writes a private atomic session file and loadSession preserves repository-relative evidence', async () => {
  const root = await makeRoot();
  const session = makeSession();

  const saved = await saveSession(root, session);
  const sessionPath = path.join(root, '.monkeypaw', 'reviews', '.sessions', `${session.sessionId}.json`);

  assert.equal(saved.sessionId, session.sessionId);
  assert.equal((await readFile(sessionPath, 'utf8')).includes(root), false);

  const loaded = await loadSession(root, session.sessionId);
  assert.equal(loaded.sessionId, session.sessionId);
  assert.equal(loaded.docUnits[0].file, 'src/app.js');

  if (process.platform !== 'win32') {
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  }

  const sessionJson = await readFile(path.join(root, '.monkeypaw', 'reviews', '.sessions', `${session.sessionId}.json`), 'utf8');
  assert.match(sessionJson, /session-v1-/);
});

test('stageSessionSave removes a partial temp file when the initial write throws', async () => {
  const root = await makeRoot();
  const session = makeSession();
  const sessionDir = path.join(root, '.monkeypaw', 'reviews', '.sessions');

  await assert.rejects(
    () => stageSessionSave(root, session, {
      async writeFileFn(filePath, _contents, options) {
        await writeFile(filePath, 'partial write', options);
        throw new Error('Injected session stage write failure');
      },
    }),
    /Injected session stage write failure/,
  );

  assert.deepEqual(await readdir(sessionDir), []);
});

test('saveSession retains a recoverable backup and exposes the restore failure when a commit cannot restore the original session file', async () => {
  const root = await makeRoot();
  const session = makeSession();
  await saveSession(root, session);
  const sessionPath = path.join(root, '.monkeypaw', 'reviews', '.sessions', `${session.sessionId}.json`);
  const previousContent = await readFile(sessionPath, 'utf8');
  const updated = {
    ...session,
    contract: { ...session.contract, text: 'Updated review task.' },
  };

  const error = await saveSession(root, updated, {
    renameFn: createRenamePlan([
      failOnce(
        ({ from, to }) => from.endsWith('.tmp') && to.endsWith(path.join('.sessions', `${session.sessionId}.json`)),
        'Injected session commit failure',
      ),
      failAlways(
        ({ from, to }) => from.endsWith('.bak') && to.endsWith(path.join('.sessions', `${session.sessionId}.json`)),
        'Injected session restore failure',
      ),
    ]),
  }).catch((caught) => caught);

  assert.equal(error?.message, 'Injected session commit failure');
  assert.deepEqual(error?.secondaryErrors?.map((failure) => failure.message), ['Injected session restore failure']);

  const sessionDirEntries = (await readdir(path.dirname(sessionPath))).sort();
  const backupEntry = sessionDirEntries.find((entry) => entry.endsWith('.bak'));

  assert.equal(sessionDirEntries.includes(`${session.sessionId}.json`), false);
  assert.equal(sessionDirEntries.some((entry) => entry.endsWith('.tmp')), false);
  assert.ok(backupEntry);
  assert.equal(await readFile(path.join(path.dirname(sessionPath), backupEntry), 'utf8'), previousContent);
});

test('saveSession keeps the commit failure primary and still attempts backup cleanup when later cleanup fails', async () => {
  const root = await makeRoot();
  const session = makeSession();
  await saveSession(root, session);
  const sessionPath = path.join(root, '.monkeypaw', 'reviews', '.sessions', `${session.sessionId}.json`);
  const updated = {
    ...session,
    contract: { ...session.contract, text: 'Updated review task.' },
  };
  const rmPlan = createRmPlan([
    failOnce(({ target }) => target.endsWith('.tmp'), 'Injected session cleanup failure'),
  ]);

  const error = await saveSession(root, updated, {
    renameFn: createRenamePlan([
      failOnce(
        ({ from, to }) => from.endsWith('.tmp') && to.endsWith(path.join('.sessions', `${session.sessionId}.json`)),
        'Injected session commit failure',
      ),
    ]),
    rmFn: rmPlan.fn,
  }).catch((caught) => caught);

  assert.equal(error?.message, 'Injected session commit failure');
  assert.deepEqual(error?.secondaryErrors?.map((failure) => failure.message), ['Injected session cleanup failure']);
  assert.equal(rmPlan.calls.some(({ target }) => target.endsWith('.bak')), true);
});

test('saveSession leaves no temp or backup residue after a normal commit failure', async () => {
  const root = await makeRoot();
  const session = makeSession();
  await saveSession(root, session);
  const sessionPath = path.join(root, '.monkeypaw', 'reviews', '.sessions', `${session.sessionId}.json`);
  const previousContent = await readFile(sessionPath, 'utf8');
  const updated = {
    ...session,
    contract: { ...session.contract, text: 'Updated review task.' },
  };

  await assert.rejects(
    () => saveSession(root, updated, {
      renameFn: createRenamePlan([
        failOnce(
          ({ from, to }) => from.endsWith('.tmp') && to.endsWith(path.join('.sessions', `${session.sessionId}.json`)),
          'Injected session commit failure',
        ),
      ]),
    }),
    /Injected session commit failure/,
  );

  assert.equal(await readFile(sessionPath, 'utf8'), previousContent);
  assert.deepEqual(await readdir(path.dirname(sessionPath)), [`${session.sessionId}.json`]);
});

test('loadSession rejects malformed or corrupt session files', async () => {
  const root = await makeRoot();
  const session = makeSession();
  const sessionDir = path.join(root, '.monkeypaw', 'reviews', '.sessions');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, `${session.sessionId}.json`), '{"broken":');

  await assert.rejects(() => loadSession(root, session.sessionId), /malformed|corrupt/i);
});

test('saveSession and loadSession reject traversal ids and symlinked session paths', async () => {
  const root = await makeRoot();
  const session = makeSession();
  const outside = await mkdtemp(path.join(tmpdir(), 'monkeypaw-session-outside-'));

  await assert.rejects(() => loadSession(root, '../escape'), /invalid review session id/i);

  await mkdir(path.join(root, '.monkeypaw'), { recursive: true });
  await symlink(outside, path.join(root, '.monkeypaw', 'reviews'));
  await assert.rejects(() => saveSession(root, session), /symbolic link/i);

  await rm(path.join(root, '.monkeypaw'), { recursive: true, force: true });
  const sessionDir = path.join(root, '.monkeypaw', 'reviews', '.sessions');
  await mkdir(sessionDir, { recursive: true });
  const realSessionPath = path.join(outside, `${session.sessionId}.json`);
  await writeFile(realSessionPath, JSON.stringify(session));
  await symlink(realSessionPath, path.join(sessionDir, `${session.sessionId}.json`));

  await assert.rejects(() => loadSession(root, session.sessionId), /symbolic link/i);
});
