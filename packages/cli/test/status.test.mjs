import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { buildContractDocument } from '@arexgill/vlp-core';
import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import { createJsonEnvelope } from '../src/json-output.mjs';
import { initializeProject } from '../src/project.mjs';
import { run } from '../src/run.mjs';

const exec = promisify(execFile);
const fixedClock = '2026-07-30T12:34:56.000Z';

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

async function makeStatusRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-status-'));
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
  return root;
}

async function writeContract(root, slug, status) {
  await writeFile(
    path.join(root, '.vlp', 'contracts', `${slug}.md`),
    buildContractDocument({
      slug,
      created: fixedClock,
      status,
      sections: {
        Intent: [`Review ${slug}.`],
        'Acceptance Criteria': ['- Keep the review local.'],
        Exclusions: ['- None.'],
        Context: ['- Test status guidance.'],
      },
    }),
  );
}

async function writeAudit(root, { sessionId, status, mtime, command = 'resolve' }) {
  const reviewDir = path.join(root, '.vlp', 'reviews');
  await mkdir(reviewDir, { recursive: true });
  const filePath = path.join(reviewDir, `${sessionId}.json`);
  const payload = createJsonEnvelope({
    command,
    status,
    sessionId,
    contract: {
      id: 'search-scope',
      status: 'confirmed',
      path: '.vlp/contracts/search-scope.md',
    },
    questions: null,
    reportPath: status === 'unresolved' ? null : `.vlp/reviews/${sessionId}.md`,
    error: null,
  });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  await utimes(filePath, mtime, mtime);
}

async function writeMalformedAudit(root, name, mtime) {
  const reviewDir = path.join(root, '.vlp', 'reviews');
  await mkdir(reviewDir, { recursive: true });
  const filePath = path.join(reviewDir, name);
  await writeFile(filePath, '{not-json');
  await utimes(filePath, mtime, mtime);
}

async function writeSymlinkAudit(root, name) {
  const reviewDir = path.join(root, '.vlp', 'reviews');
  await mkdir(reviewDir, { recursive: true });
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vlp-status-audit-target-'));
  const targetPath = path.join(targetDir, 'linked.json');
  await writeFile(targetPath, '{"status":"completed"}\n');
  await symlink(targetPath, path.join(reviewDir, name));
}

async function runStatus(root) {
  const stdout = writableBuffer();
  const stderr = writableBuffer();
  const code = await run({
    argv: ['status'],
    cwd: root,
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

test('status reports the latest completed review and recommends review for a confirmed contract', async () => {
  const root = await makeStatusRepo();
  await writeContract(root, 'search-scope', 'confirmed');
  await writeAudit(root, {
    sessionId: 'session-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    status: 'completed',
    mtime: new Date('2026-07-30T12:35:00.000Z'),
  });

  const result = await runStatus(root);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Latest review: completed \(session-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\)/);
  assert.match(result.stdout, /Next: vlp review$/m);
  assert.match(result.stdout, /Active contract: search-scope/);
  assert.equal(result.stdout.includes(root), false);
});

test('status reports the newest corrections-required review, breaks ties by name, and asks for review with --contract when multiple confirmed contracts exist', async () => {
  const root = await makeStatusRepo();
  await writeContract(root, 'alpha-task', 'confirmed');
  await writeContract(root, 'beta-task', 'confirmed');
  const tieTime = new Date('2026-07-30T12:35:00.000Z');
  await writeAudit(root, {
    sessionId: 'session-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    status: 'corrections-required',
    mtime: tieTime,
  });
  await writeAudit(root, {
    sessionId: 'session-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    status: 'completed',
    mtime: tieTime,
  });

  const result = await runStatus(root);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Latest review: corrections-required \(session-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\)/);
  assert.match(result.stdout, /Next: vlp review --contract/);
  assert.match(result.stdout, /Active contract: multiple/);
  assert.equal(result.stdout.includes(root), false);
});

test('status reports the latest unresolved review and confirms a single draft before review', async () => {
  const root = await makeStatusRepo();
  await writeContract(root, 'draft-task', 'draft');
  await writeAudit(root, {
    sessionId: 'session-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    status: 'unresolved',
    mtime: new Date('2026-07-30T12:35:00.000Z'),
  });

  const result = await runStatus(root);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Latest review: unresolved \(session-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\)/);
  assert.match(result.stdout, /Next: vlp contract confirm draft-task/);
  assert.match(result.stdout, /Active contract: none/);
  assert.equal(result.stdout.includes(root), false);
});

test('status falls back to contract new when no contracts exist and skips malformed or symlinked audits safely', async () => {
  const root = await makeStatusRepo();
  await writeMalformedAudit(root, 'broken.json', new Date('2026-07-30T12:36:00.000Z'));
  await writeSymlinkAudit(root, 'linked.json');

  const result = await runStatus(root);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Latest review: none/);
  assert.match(result.stdout, /Next: vlp contract new/);
  assert.match(result.stdout, /Active contract: none/);
  assert.equal(result.stdout.includes(root), false);
  assert.deepEqual((await readdir(path.join(root, '.vlp', 'reviews'))).sort(), ['broken.json', 'linked.json']);
});
