import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { buildContractDocument } from '@arexgill/vlp-core';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { initializeProject } from '../src/project.mjs';

const exec = promisify(execFile);
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'run-cli.mjs');
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

async function makeCliRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-cli-'));
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
          '- Search relevance must consider product name, description, category, and tags.',
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

function runCli(args, { cwd, input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      cwd,
      env: {
        ...process.env,
        VLP_TEST_RUNNER: '1',
        VLP_TEST_CLOCK: fixedClock,
        VLP_TEST_UUID: fixedUuid,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI parses global commands and routes init/contract flows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-cli-init-'));
  await git(root, 'init');

  const version = await runCli(['--version'], { cwd: root });
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^0\.1\.0\n$/);
  assert.equal(version.stderr, '');

  const help = await runCli(['--help'], { cwd: root });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /vlp review/);

  const init = await runCli(['init'], { cwd: root });
  assert.equal(init.code, 0);
  assert.match(init.stdout, /Initialized VLP project/);
  await stat(path.join(root, '.vlp', 'config.json'));

  const create = await runCli(['contract', 'new', 'Sample Task'], { cwd: root });
  assert.equal(create.code, 0);
  assert.match(create.stdout, /sample-task/);

  const confirm = await runCli(['contract', 'confirm', 'Sample Task'], { cwd: root });
  assert.equal(confirm.code, 0);
  assert.match(confirm.stdout, /confirmed/);

  const unknown = await runCli(['wat'], { cwd: root });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command/);
});

test('review defaults to terminal mode in a TTY and aborts without writing a partial report', async () => {
  const root = await makeCliRepo();

  const result = await runCli(['review'], {
    cwd: root,
    input: 'q\n',
    env: {
      VLP_TEST_STDIN_TTY: '1',
      VLP_TEST_STDOUT_TTY: '1',
      VLP_TEST_STDERR_TTY: '1',
    },
  });

  assert.equal(result.code, 3);
  assert.match(result.stdout, /Question 1\//);
  assert.match(result.stdout, /\[a\]ccept \[c\]orrect \[i\]rrelevant \[q\]uit/i);
  assert.match(result.stderr, /aborted/i);

  const sessionId = `session-v1-${fixedUuid.replaceAll('-', '')}`;
  const reviewDir = path.join(root, '.vlp', 'reviews');
  const reviewDirEntries = await readdir(reviewDir);
  assert.deepEqual(reviewDirEntries, []);
  await assert.rejects(() => stat(path.join(reviewDir, '.sessions')), /ENOENT/);
  await assert.rejects(() => stat(path.join(reviewDir, `${sessionId}.md`)), /ENOENT/);
  await assert.rejects(() => stat(path.join(reviewDir, `${sessionId}.json`)), /ENOENT/);
});

test('plain review fails safely in a non-TTY and points callers to JSON or web mode', async () => {
  const root = await makeCliRepo();

  const result = await runCli(['review'], { cwd: root });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--json/);
  assert.match(result.stderr, /--web/);

  const reviewDir = path.join(root, '.vlp', 'reviews');
  const sessionId = `session-v1-${fixedUuid.replaceAll('-', '')}`;
  const reviewDirEntries = await readdir(reviewDir);
  assert.deepEqual(reviewDirEntries, []);
  await assert.rejects(() => stat(path.join(reviewDir, '.sessions')), /ENOENT/);
  await assert.rejects(() => stat(path.join(reviewDir, `${sessionId}.md`)), /ENOENT/);
  await assert.rejects(() => stat(path.join(reviewDir, `${sessionId}.json`)), /ENOENT/);
});

test('review --json emits the exact envelope schema and exit code 3 for unresolved questions', async () => {
  const root = await makeCliRepo();

  const result = await runCli(['review', '--json'], { cwd: root });

  assert.equal(result.code, 3);
  assert.equal(result.stderr, '');

  const json = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(json), ['schemaVersion', 'command', 'status', 'sessionId', 'contract', 'questions', 'reportPath', 'error']);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.command, 'review');
  assert.equal(json.status, 'unresolved');
  assert.equal(json.sessionId, `session-v1-${fixedUuid.replaceAll('-', '')}`);
  assert.equal(json.reportPath, null);
  assert.equal(json.error, null);
  assert.equal(json.contract.id, 'search-scope');
  assert.equal(json.contract.path, '.vlp/contracts/search-scope.md');
  assert.equal(Array.isArray(json.questions), true);
  assert.equal(json.questions.length > 0, true);
  assert.equal(JSON.stringify(json).includes(root), false);

  await stat(path.join(root, '.vlp', 'reviews', '.sessions', `${json.sessionId}.json`));
});

test('resolve accepts file input, validates against the persisted session, and returns exit code 2 when corrections are required', async () => {
  const root = await makeCliRepo();
  const review = await runCli(['review', '--json'], { cwd: root });
  const envelope = JSON.parse(review.stdout);

  const decisions = envelope.questions.map((question, index) => ({
    questionId: question.id,
    decision: index === 0 ? 'correct' : 'accept',
    answer: index === 0 ? 'Search name, description, category, and tags.' : '',
  }));
  const inputPath = path.join(root, 'decisions.json');
  await writeFile(inputPath, `${JSON.stringify({ sessionId: envelope.sessionId, decisions }, null, 2)}\n`);

  const result = await runCli(['resolve', '--session', envelope.sessionId, '--input', 'decisions.json', '--json'], { cwd: root });

  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');

  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.command, 'resolve');
  assert.equal(json.status, 'corrections-required');
  assert.equal(json.sessionId, envelope.sessionId);
  assert.equal(json.reportPath, `.vlp/reviews/${envelope.sessionId}.md`);
  assert.equal(json.error, null);
  assert.equal(JSON.stringify(json).includes(root), false);
  assert.equal((await readFile(path.join(root, json.reportPath), 'utf8')).includes('Search name, description, category, and tags.'), true);
  assert.equal((await readFile(path.join(root, '.vlp', 'reviews', `${envelope.sessionId}.json`), 'utf8')).includes(root), false);
});

test('resolve accepts stdin input and returns exit code 0 when all decisions are non-corrective', async () => {
  const root = await makeCliRepo();
  const review = await runCli(['review', '--json'], { cwd: root });
  const envelope = JSON.parse(review.stdout);

  const decisions = envelope.questions.map((question) => ({
    questionId: question.id,
    decision: 'accept',
    answer: '',
  }));

  const result = await runCli(['resolve', '--session', envelope.sessionId, '--input', '-', '--json'], {
    cwd: root,
    input: `${JSON.stringify({ sessionId: envelope.sessionId, decisions })}\n`,
  });

  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'completed');
  assert.equal(json.reportPath, `.vlp/reviews/${envelope.sessionId}.md`);
});

test('status and doctor stay redacted and never expose environment credential values', async () => {
  const root = await makeCliRepo();
  const secret = 'super-secret-token-value';

  const status = await runCli(['status'], {
    cwd: root,
    env: {
      AWS_SECRET_ACCESS_KEY: secret,
      OPENAI_API_KEY: secret,
    },
  });
  assert.equal(status.code, 0);
  assert.match(status.stdout, /Active contract: search-scope/);
  assert.doesNotMatch(status.stdout, new RegExp(secret));
  assert.doesNotMatch(status.stdout, /\/Users\//);

  const doctor = await runCli(['doctor'], {
    cwd: root,
    env: {
      AWS_SECRET_ACCESS_KEY: secret,
      OPENAI_API_KEY: secret,
    },
  });
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /Node:/);
  assert.match(doctor.stdout, /Git:/);
  assert.doesNotMatch(doctor.stdout, new RegExp(secret));
  assert.doesNotMatch(doctor.stdout, /OPENAI_API_KEY/);
  assert.doesNotMatch(doctor.stdout, /\/Users\//);
});

test('review --web parses but returns a clear not-yet-available result until Task 8', async () => {
  const root = await makeCliRepo();

  const result = await runCli(['review', '--web'], { cwd: root });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /not yet available/i);
});
