import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { CORE_LIMITS, createReviewSession } from '@arexgill/vlp-core';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import { run } from '../src/run.mjs';
import { saveSession } from '../src/session-store.mjs';

const exec = promisify(execFile);
const fixedUuid = '123e4567-e89b-12d3-a456-426614174000';

async function git(cwd, ...args) {
  await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function writableBuffer() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

function chunkText(text, size = 4096) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

class TrackingReadable extends Readable {
  constructor(chunks) {
    super();
    this.chunks = [...chunks];
    this.destroyCount = 0;
  }

  _read() {
    if (this.chunks.length === 0) {
      this.push(null);
      return;
    }

    this.push(this.chunks.shift());
  }

  destroy(error, callback) {
    this.destroyCount += 1;
    return super.destroy(error, callback);
  }
}

async function makeResolveRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-resolve-bound-'));
  await git(root, 'init');
  return root;
}

async function createResolveSession(root) {
  const session = createReviewSession(
    {
      contract: {
        id: 'search-scope',
        slug: 'search-scope',
        status: 'confirmed',
        path: '.vlp/contracts/search-scope.md',
        content: '# Search Scope\n\n- Search name and description.\n',
      },
      sources: [],
      docUnits: [],
      diagnostics: [],
      questions: [{
        id: 'q-1',
        type: 'missing-behavior',
        severity: 'high',
        title: 'Question',
        ask: 'Should the change stay local?',
        reason: 'The test only needs a valid review session.',
        promptEvidence: 'Keep the change local.',
        docUnitIds: [],
      }],
      meta: {
        sourceCount: 0,
        docUnitCount: 0,
        questionCount: 1,
      },
    },
    { randomUUID: () => fixedUuid },
  );

  await saveSession(root, session);
  return session;
}

function buildEnvelopePayload(sessionId, decisions, limitBytes = CORE_LIMITS.decisionEnvelopeBytes) {
  const base = JSON.stringify({ sessionId, decisions, padding: '' });
  const paddingBytes = limitBytes - Buffer.byteLength(base, 'utf8');
  assert.ok(paddingBytes >= 0);

  const payload = JSON.stringify({ sessionId, decisions, padding: 'x'.repeat(paddingBytes) });
  assert.equal(Buffer.byteLength(payload, 'utf8'), limitBytes);
  return payload;
}

function buildOversizePayload(sessionId, decisions) {
  return buildEnvelopePayload(sessionId, decisions, CORE_LIMITS.decisionEnvelopeBytes + 1);
}

async function runResolve({ root, sessionId, input, stdin, artifactIO = {} }) {
  const stdout = writableBuffer();
  const stderr = writableBuffer();
  const code = await run({
    argv: ['resolve', '--session', sessionId, '--input', input, '--json'],
    cwd: root,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    artifactIO,
  });

  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function acceptDecisions(session) {
  return session.questions.map((question) => ({
    questionId: question.id,
    decision: 'accept',
    answer: '',
  }));
}

test('resolve --input - accepts an exact-boundary stdin envelope and rejects an oversized stdin envelope without persisting artifacts', async () => {
  const boundaryRoot = await makeResolveRepo();
  const boundarySession = await createResolveSession(boundaryRoot);
  const boundaryPayload = buildEnvelopePayload(boundarySession.sessionId, acceptDecisions(boundarySession));

  const boundary = await runResolve({
    root: boundaryRoot,
    sessionId: boundarySession.sessionId,
    input: '-',
    stdin: Readable.from(chunkText(boundaryPayload)),
  });

  assert.equal(boundary.code, 0);
  assert.equal(boundary.stderr, '');
  const boundaryJson = JSON.parse(boundary.stdout);
  assert.equal(boundaryJson.status, 'completed');
  assert.equal(boundaryJson.error, null);
  assert.equal(boundaryJson.sessionId, boundarySession.sessionId);
  assert.equal(boundaryJson.reportPath, `.vlp/reviews/${boundarySession.sessionId}.md`);
  assert.equal(JSON.stringify(boundaryJson).includes(boundaryRoot), false);
  assert.equal((await readFile(path.join(boundaryRoot, boundaryJson.reportPath), 'utf8')).length > 0, true);

  const oversizeRoot = await makeResolveRepo();
  const oversizeSession = await createResolveSession(oversizeRoot);
  const oversizePayload = buildOversizePayload(oversizeSession.sessionId, acceptDecisions(oversizeSession));
  const stdin = new TrackingReadable(chunkText(oversizePayload));
  const artifactCalls = [];
  const oversize = await runResolve({
    root: oversizeRoot,
    sessionId: oversizeSession.sessionId,
    input: '-',
    stdin,
    artifactIO: {
      async writeFileFn() {
        artifactCalls.push('writeFileFn');
      },
      async renameFn() {
        artifactCalls.push('renameFn');
      },
      async rmFn() {
        artifactCalls.push('rmFn');
      },
      async stageSessionSaveFn() {
        artifactCalls.push('stageSessionSaveFn');
      },
    },
  });

  assert.equal(oversize.code, 1);
  assert.equal(oversize.stderr, '');
  const oversizeJson = JSON.parse(oversize.stdout);
  assert.equal(oversizeJson.status, 'error');
  assert.equal(oversizeJson.error.code, 'ERR_VLP_DECISION_ENVELOPE_TOO_LARGE');
  assert.equal(oversizeJson.error.message, `Decision envelope exceeds ${CORE_LIMITS.decisionEnvelopeBytes} bytes`);
  assert.equal(JSON.stringify(oversizeJson).includes(oversizeRoot), false);
  assert.ok(stdin.destroyCount > 0);
  assert.deepEqual(artifactCalls, []);
  assert.deepEqual((await readdir(path.join(oversizeRoot, '.vlp', 'reviews'))).sort(), ['.sessions']);
});

test('resolve --input <file> accepts an exact-boundary file envelope and rejects an oversized file envelope without persisting artifacts', async () => {
  const boundaryRoot = await makeResolveRepo();
  const boundarySession = await createResolveSession(boundaryRoot);
  const boundaryPayload = buildEnvelopePayload(boundarySession.sessionId, acceptDecisions(boundarySession));
  const boundaryInput = path.join(boundaryRoot, 'boundary.json');
  await writeFile(boundaryInput, boundaryPayload);

  const boundary = await runResolve({
    root: boundaryRoot,
    sessionId: boundarySession.sessionId,
    input: 'boundary.json',
    stdin: Readable.from([]),
  });

  assert.equal(boundary.code, 0);
  const boundaryJson = JSON.parse(boundary.stdout);
  assert.equal(boundaryJson.status, 'completed');
  assert.equal(boundaryJson.reportPath, `.vlp/reviews/${boundarySession.sessionId}.md`);
  assert.equal(JSON.stringify(boundaryJson).includes(boundaryRoot), false);
  assert.equal((await readFile(path.join(boundaryRoot, boundaryJson.reportPath), 'utf8')).length > 0, true);

  const oversizeRoot = await makeResolveRepo();
  const oversizeSession = await createResolveSession(oversizeRoot);
  const oversizePayload = buildOversizePayload(oversizeSession.sessionId, acceptDecisions(oversizeSession));
  const oversizeInput = path.join(oversizeRoot, 'oversize.json');
  await writeFile(oversizeInput, oversizePayload);

  const oversize = await runResolve({
    root: oversizeRoot,
    sessionId: oversizeSession.sessionId,
    input: 'oversize.json',
    stdin: Readable.from([]),
  });

  assert.equal(oversize.code, 1);
  const oversizeJson = JSON.parse(oversize.stdout);
  assert.equal(oversizeJson.status, 'error');
  assert.equal(oversizeJson.error.code, 'ERR_VLP_DECISION_ENVELOPE_TOO_LARGE');
  assert.equal(oversizeJson.error.message, `Decision envelope exceeds ${CORE_LIMITS.decisionEnvelopeBytes} bytes`);
  assert.equal(JSON.stringify(oversizeJson).includes(oversizeRoot), false);
  assert.deepEqual((await readdir(path.join(oversizeRoot, '.vlp', 'reviews'))).sort(), ['.sessions']);
});
