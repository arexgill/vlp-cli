import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { buildContractDocument, createReviewSession } from '@arexgill/vlp-core';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import { handleWebReview } from '../src/commands/web-review.mjs';
import { run } from '../src/run.mjs';
import { loadSession, saveSession } from '../src/session-store.mjs';
import { BODY_LIMIT_BYTES, startWebReviewServer } from '../src/web-server.mjs';
import { initializeProject } from '../src/project.mjs';

const exec = promisify(execFile);
const fixedClock = '2026-07-30T12:34:56.000Z';
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

function fixedSession() {
  return createReviewSession({
    contract: {
      id: 'search-scope',
      slug: 'search-scope',
      status: 'confirmed',
      path: '.vlp/contracts/search-scope.md',
      content: '# Search Scope\n\n- Search name and description.',
    },
    sources: [
      {
        path: 'src/search.js',
        content: 'export function searchProducts(products, query) {\n  return products;\n}\n',
      },
    ],
    docUnits: [
      {
        id: 'unit-1',
        file: 'src/search.js',
        lineStart: 1,
        kind: 'function',
        text: 'searchProducts returns the full product list.',
      },
    ],
    diagnostics: [],
    questions: [
      {
        id: 'q-search-1',
        type: 'missing-behavior',
        severity: 'high',
        title: 'Search scope looks incomplete',
        ask: 'Should search include the product description as well as the name?',
        reason: 'The contract mentions description, but the changed implementation only checks the name.',
        promptEvidence: '- Search relevance must consider product name and description.',
        docUnitIds: ['unit-1'],
      },
    ],
    meta: {
      sourceCount: 1,
      docUnitCount: 1,
      questionCount: 1,
    },
  }, { randomUUID: () => fixedUuid });
}

async function makeCliRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-web-cli-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'search.js'),
    'export function searchProducts(products, query) {\n  return products;\n}\n',
  );
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');

  await writeFile(
    path.join(root, 'src', 'search.js'),
    'export function searchProducts(products, query) {\n  if (!query) return products;\n  return products.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));\n}\n',
  );

  await initializeProject(root);
  await writeFile(
    path.join(root, '.vlp', 'contracts', 'search-scope.md'),
    buildContractDocument({
      slug: 'search-scope',
      created: fixedClock,
      status: 'confirmed',
      sections: {
        Intent: ['Build searchProducts(products, query).'],
        'Acceptance Criteria': [
          '- Search relevance must consider product name and description.',
          '- If the query is empty, return all products.',
          '- Matching must be case-insensitive.',
        ],
        Exclusions: ['- None.'],
        Context: ['- Review only the changed JS source.'],
      },
    }),
  );

  return root;
}

test('handleWebReview opens the loopback URL by default and closes the server after completion', async () => {
  const opened = [];
  const events = [];
  const stdout = writableBuffer();

  const result = await handleWebReview({
    root: '/tmp/vlp-web-review',
    session: fixedSession(),
    stdout: stdout.stream,
    open: true,
    openBrowser: async (url) => {
      opened.push(url);
    },
    startServer: async () => ({
      url: 'http://127.0.0.1:43123',
      waitForCompletion: async () => ({ exitCode: 0, reportPath: '.vlp/reviews/session-v1-123.md', envelope: { status: 'completed' } }),
      close: async () => {
        events.push('closed');
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(opened, ['http://127.0.0.1:43123']);
  assert.deepEqual(events, ['closed']);
  assert.match(stdout.text(), /127\.0\.0\.1/);
  assert.match(stdout.text(), /Review report: \.vlp\/reviews\/session-v1-123\.md/);
});

test('handleWebReview honors open=false and skips the injected browser dependency', async () => {
  let opened = false;

  await handleWebReview({
    root: '/tmp/vlp-web-review',
    session: fixedSession(),
    stdout: writableBuffer().stream,
    open: false,
    openBrowser: async () => {
      opened = true;
    },
    startServer: async () => ({
      url: 'http://127.0.0.1:43123',
      waitForCompletion: async () => ({ exitCode: 0, reportPath: null, envelope: { status: 'completed' } }),
      close: async () => {},
    }),
  });

  assert.equal(opened, false);
});

test('startWebReviewServer binds to loopback, serves only allowlisted assets, and validates resolve requests against the persisted session', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-web-server-'));
  const session = await saveSession(root, fixedSession());
  const server = await startWebReviewServer({ root, sessionId: session.sessionId });
  t.after(async () => {
    await server.close();
  });

  assert.equal(server.host, '127.0.0.1');
  assert.equal(Number.isInteger(server.port) && server.port > 0, true);

  const sessionResponse = await fetch(`${server.url}/api/session`);
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
  assert.equal(sessionResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(sessionResponse.headers.get('content-security-policy'), /default-src 'self'/);
  const sessionPayload = await sessionResponse.json();
  assert.equal(sessionPayload.sessionId, session.sessionId);
  assert.equal(sessionPayload.questions.length, 1);
  assert.equal(sessionPayload.decisions, undefined);
  assert.equal(JSON.stringify(sessionPayload).includes(root), false);

  const staticHtml = await fetch(`${server.url}/`);
  assert.equal(staticHtml.status, 200);
  assert.match(staticHtml.headers.get('content-type'), /text\/html/);
  assert.match(staticHtml.headers.get('content-security-policy'), /default-src 'self'/);

  const staticModule = await fetch(`${server.url}/web-app.mjs`, { method: 'HEAD' });
  assert.equal(staticModule.status, 200);
  assert.match(staticModule.headers.get('content-type'), /javascript/);

  assert.equal((await fetch(`${server.url}/../package.json`)).status, 404);
  assert.equal((await fetch(`${server.url}/packages/ui/public/index.html`)).status, 404);
  assert.equal((await fetch(`${server.url}/src/search.js`)).status, 404);

  const wrongMethod = await fetch(`${server.url}/api/session`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);

  const wrongContentType = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'nope',
  });
  assert.equal(wrongContentType.status, 415);

  const malformed = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);

  const oversized = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, decisions: [], padding: 'x'.repeat(BODY_LIMIT_BYTES + 1) }),
  });
  assert.equal(oversized.status, 413);

  for (const body of [
    {
      sessionId: 'session-v1-ffffffffffffffffffffffffffffffff',
      decisions: [{ questionId: 'q-search-1', decision: 'accept', answer: '' }],
    },
    {
      sessionId: session.sessionId,
      decisions: [{ questionId: 'q-forged', decision: 'accept', answer: '', ask: 'FORGED QUESTION TEXT' }],
    },
    {
      sessionId: session.sessionId,
      decisions: [
        { questionId: 'q-search-1', decision: 'accept', answer: '' },
        { questionId: 'q-search-1', decision: 'accept', answer: '' },
      ],
    },
    {
      sessionId: session.sessionId,
      decisions: [{ questionId: 'q-search-1', decision: 'correct', answer: '' }],
    },
    {
      sessionId: session.sessionId,
      decisions: [{ questionId: 'q-search-1', decision: 'forge', answer: '' }],
    },
  ]) {
    const invalid = await fetch(`${server.url}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
    const invalidPayload = await invalid.json();
    assert.deepEqual(invalidPayload, { error: 'Invalid decision submission' });
    assert.equal(JSON.stringify(invalidPayload).includes('q-search-1'), false);
    assert.equal(JSON.stringify(invalidPayload).includes('FORGED QUESTION TEXT'), false);
  }

  const resolved = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      decisions: [{
        questionId: 'q-search-1',
        decision: 'correct',
        answer: 'Search both the product name and description.',
        ask: 'MALICIOUS QUESTION TEXT',
        evidence: [{ file: 'evil.js', line: 999, text: 'spoofed evidence' }],
      }],
      questions: [{ id: 'evil-question', ask: 'spoofed' }],
    }),
  });
  assert.equal(resolved.status, 200);
  const resolvedPayload = await resolved.json();
  assert.equal(resolvedPayload.envelope.status, 'corrections-required');
  assert.equal(resolvedPayload.envelope.sessionId, session.sessionId);
  assert.match(resolvedPayload.markdown, /Search both the product name and description\./);
  assert.match(resolvedPayload.markdown, /src\/search\.js:1 — searchProducts returns the full product list\./);
  assert.doesNotMatch(resolvedPayload.markdown, /MALICIOUS QUESTION TEXT/);
  assert.doesNotMatch(resolvedPayload.markdown, /spoofed evidence/);

  const storedReport = await readFile(path.join(root, '.vlp', 'reviews', `${session.sessionId}.md`), 'utf8');
  assert.equal(storedReport, resolvedPayload.markdown);

  const completion = await server.waitForCompletion();
  assert.equal(completion.exitCode, 2);
  assert.equal(completion.reportPath, `.vlp/reviews/${session.sessionId}.md`);

  const saved = await loadSession(root, session.sessionId);
  assert.deepEqual(saved.decisions, [{
    questionId: 'q-search-1',
    decision: 'correct',
    answer: 'Search both the product name and description.',
  }]);
});

test('web resolve leaves the unresolved persisted session unchanged and cleans staged temp files when final artifact staging fails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-web-server-failure-'));
  const session = await saveSession(root, fixedSession());
  const sessionPath = path.join(root, '.vlp', 'reviews', '.sessions', `${session.sessionId}.json`);
  const before = await readFile(sessionPath, 'utf8');
  let writeCount = 0;

  const server = await startWebReviewServer({
    root,
    sessionId: session.sessionId,
    artifactIO: {
      async writeFileFn(...args) {
        writeCount += 1;
        if (writeCount === 2) {
          throw new Error('Injected staged write failure');
        }
        return writeFile(...args);
      },
    },
  });
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      decisions: [{
        questionId: 'q-search-1',
        decision: 'correct',
        answer: 'Search both the product name and description.',
      }],
    }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
  assert.equal(await readFile(sessionPath, 'utf8'), before);

  const reviewDirEntries = await readdir(path.join(root, '.vlp', 'reviews'));
  assert.deepEqual(reviewDirEntries.sort(), ['.sessions']);
  const sessionDirEntries = await readdir(path.join(root, '.vlp', 'reviews', '.sessions'));
  assert.deepEqual(sessionDirEntries, [`${session.sessionId}.json`]);

  const loaded = await loadSession(root, session.sessionId);
  assert.deepEqual(loaded.decisions, []);
});

test('browser resolve writes a byte-identical report to terminal review for the same decisions', async (t) => {
  const terminalRoot = await makeCliRepo();
  const browserRoot = await makeCliRepo();

  const jsonStdout = writableBuffer();
  const jsonStderr = writableBuffer();
  const unresolvedCode = await run({
    argv: ['review', '--json'],
    cwd: browserRoot,
    stdin: Readable.from([]),
    stdout: jsonStdout.stream,
    stderr: jsonStderr.stream,
    randomUUID: () => fixedUuid,
  });
  assert.equal(unresolvedCode, 3);
  assert.equal(jsonStderr.text(), '');

  const unresolved = JSON.parse(jsonStdout.text());
  const acceptInput = `${unresolved.questions.map(() => 'a').join('\n')}\n`;

  const terminalStdout = writableBuffer();
  const terminalStderr = writableBuffer();
  const terminalCode = await run({
    argv: ['review'],
    cwd: terminalRoot,
    stdin: Readable.from([acceptInput]),
    stdout: terminalStdout.stream,
    stderr: terminalStderr.stream,
    isTTY: { stdin: true, stdout: true, stderr: true },
    randomUUID: () => fixedUuid,
  });
  assert.equal(terminalCode, 0);
  assert.match(terminalStdout.text(), /Review report: \.vlp\/reviews\//);
  assert.equal(terminalStderr.text(), '');

  const server = await startWebReviewServer({ root: browserRoot, sessionId: unresolved.sessionId });
  t.after(async () => {
    await server.close();
  });

  const browserResolved = await fetch(`${server.url}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sessionId: unresolved.sessionId,
      decisions: unresolved.questions.map((question) => ({
        questionId: question.id,
        decision: 'accept',
        answer: '',
      })),
    }),
  });
  assert.equal(browserResolved.status, 200);
  await server.waitForCompletion();

  const terminalReport = await readFile(path.join(terminalRoot, '.vlp', 'reviews', `${unresolved.sessionId}.md`), 'utf8');
  const browserReport = await readFile(path.join(browserRoot, '.vlp', 'reviews', `${unresolved.sessionId}.md`), 'utf8');
  assert.equal(browserReport, terminalReport);
});
