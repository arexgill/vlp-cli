import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { buildContractDocument } from '@arexgill/vlp-core';
import { access, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { initializeProject } from '../src/project.mjs';
import { run } from '../src/run.mjs';

const exec = promisify(execFile);
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'run-cli.mjs');
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

async function makePythonCliRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-cli-py-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'search.py'),
    'def search_products(products, query):\n    return products\n',
  );
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');

  await writeFile(
    path.join(root, 'src', 'search.py'),
    'def search_products(products, query):\n    if not query:\n        return products\n    normalized = query.lower()\n    return [product for product in products if normalized in product["name"].lower()]\n',
  );

  await initializeProject(root);
  await writeFile(
    path.join(root, '.vlp', 'contracts', 'search-scope.md'),
    buildContractDocument({
      slug: 'search-scope',
      created: fixedClock,
      status: 'confirmed',
      sections: {
        Intent: ['Build search_products(products, query).'],
        'Acceptance Criteria': [
          '- Search relevance must consider product name, description, category, and tags.',
          '- If the query is empty, return all products.',
          '- Matching must be case-insensitive.',
        ],
        Exclusions: ['- None.'],
        Context: ['- Review only the changed Python source.'],
      },
    }),
  );

  return root;
}

async function makeFastApiCliRepo({ runtimeOptIn = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-cli-fastapi-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'api.py'),
    'def placeholder():\n    return {"ok": True}\n',
  );
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');

  await writeFile(
    path.join(root, 'src', 'api.py'),
    'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/items/{item_id}")\nasync def read_item(item_id: int):\n    return {"item_id": item_id}\n',
  );

  await initializeProject(root);

  if (runtimeOptIn) {
    const configPath = path.join(root, '.vlp', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.runtime = { type: 'fastapi', app: 'src.api:app' };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  await writeFile(
    path.join(root, '.vlp', 'contracts', 'api-runtime.md'),
    buildContractDocument({
      slug: 'api-runtime',
      created: fixedClock,
      status: 'confirmed',
      sections: {
        Intent: ['Review the FastAPI route implementation.'],
        'Acceptance Criteria': [
          '- Route /items/{item_id} should stay available.',
        ],
        Exclusions: ['- No other runtime integrations.'],
        Context: ['- Review only the changed Python source.'],
      },
    }),
  );

  return root;
}

async function makeDeleteOnlyCliRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-cli-delete-only-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'keep.js'), 'export const keep = true;\n');
  await writeFile(path.join(root, 'src', 'remove-me.js'), 'export const removeMe = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');

  await stat(path.join(root, 'src', 'remove-me.js'));
  await initializeProject(root);
  await writeFile(
    path.join(root, '.vlp', 'contracts', 'delete-only.md'),
    buildContractDocument({
      slug: 'delete-only',
      created: fixedClock,
      status: 'confirmed',
      sections: {
        Intent: ['Review only changed JS source.'],
        'Acceptance Criteria': ['- Keep the remaining files stable.'],
        Exclusions: ['- No other source edits.'],
        Context: ['- Delete-only changes should not trigger whole-repo discovery.'],
      },
    }),
  );

  await exec('git', ['rm', 'src/remove-me.js'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

  return root;
}

async function writeConfig(root, updater) {
  const configPath = path.join(root, '.vlp', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  updater(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function commandPath(command) {
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to locate ${command}`);
}

async function makeGitOnlyPath() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-git-only-'));
  await symlink(await commandPath('git'), path.join(root, 'git'));
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


test('real review and resolve flows are reflected in status from persisted session state without absolute paths', async () => {
  const root = await makeCliRepo();
  const review = await runCli(['review', '--json'], { cwd: root });
  assert.equal(review.code, 3);
  const unresolved = JSON.parse(review.stdout);

  const statusAfterReview = await runCli(['status'], { cwd: root });
  assert.equal(statusAfterReview.code, 0);
  assert.match(statusAfterReview.stdout, new RegExp(`Latest review: unresolved \\(${unresolved.sessionId}\\)`));
  assert.match(statusAfterReview.stdout, new RegExp(`Next: vlp resolve --session ${unresolved.sessionId} --input <file> --json`));
  assert.equal(statusAfterReview.stdout.includes(root), false);

  const decisions = unresolved.questions.map((question) => ({
    questionId: question.id,
    decision: 'accept',
    answer: '',
  }));
  const resolve = await runCli(['resolve', '--session', unresolved.sessionId, '--input', '-', '--json'], {
    cwd: root,
    input: `${JSON.stringify({ sessionId: unresolved.sessionId, decisions })}\n`,
  });
  assert.equal(resolve.code, 0);

  const statusAfterResolve = await runCli(['status'], { cwd: root });
  assert.equal(statusAfterResolve.code, 0);
  assert.match(statusAfterResolve.stdout, new RegExp(`Latest review: completed \\(${unresolved.sessionId}\\)`));
  assert.match(statusAfterResolve.stdout, /Next: vlp review$/m);
  assert.equal(statusAfterResolve.stdout.includes(root), false);
});

test('resolve leaves the unresolved persisted session unchanged when staged artifact writing fails', async () => {
  const root = await makeCliRepo();
  const review = await runCli(['review', '--json'], { cwd: root });
  const envelope = JSON.parse(review.stdout);
  const sessionPath = path.join(root, '.vlp', 'reviews', '.sessions', `${envelope.sessionId}.json`);
  const before = await readFile(sessionPath, 'utf8');
  const stdout = writableBuffer();
  const stderr = writableBuffer();
  let writeCount = 0;

  const exitCode = await run({
    argv: ['resolve', '--session', envelope.sessionId, '--input', '-', '--json'],
    cwd: root,
    stdin: Readable.from([JSON.stringify({
      sessionId: envelope.sessionId,
      decisions: envelope.questions.map((question, index) => ({
        questionId: question.id,
        decision: index === 0 ? 'correct' : 'accept',
        answer: index === 0 ? 'Search name, description, category, and tags.' : '',
      })),
    })]),
    stdout: stdout.stream,
    stderr: stderr.stream,
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

  assert.equal(exitCode, 1);
  assert.equal(stderr.text(), '');
  const json = JSON.parse(stdout.text());
  assert.equal(json.status, 'error');
  assert.equal(json.error.message, 'Injected staged write failure');
  assert.equal(await readFile(sessionPath, 'utf8'), before);
  assert.deepEqual((await readdir(path.join(root, '.vlp', 'reviews'))).sort(), ['.sessions']);
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
  assert.match(doctor.stdout, /Python: not required/);
  assert.doesNotMatch(doctor.stdout, new RegExp(secret));
  assert.doesNotMatch(doctor.stdout, /OPENAI_API_KEY/);
  assert.doesNotMatch(doctor.stdout, /\/Users\//);
});

test('status and review honor configured include/exclude globs for changed files', async () => {
  const root = await makeCliRepo();
  await writeConfig(root, (config) => {
    config.source.include = ['src/**/*.js'];
    config.source.exclude = ['src/search.js'];
  });

  const status = await runCli(['status'], { cwd: root });
  assert.equal(status.code, 0);
  assert.match(status.stdout, /Changed supported files: 0/);

  const review = await runCli(['review', '--json'], { cwd: root });
  assert.equal(review.code, 1);
  const json = JSON.parse(review.stdout);
  assert.equal(json.status, 'error');
  assert.equal(json.error.message, 'No supported source files were found');
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'reviews')), []);
});

test('invalid existing config fails status, doctor, and review visibly', async () => {
  const root = await makeCliRepo();
  await writeConfig(root, (config) => {
    config.source.include = ['/tmp/**/*.js'];
  });

  const status = await runCli(['status'], { cwd: root });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /relative glob/i);

  const doctor = await runCli(['doctor'], { cwd: root });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stderr, /relative glob/i);

  const review = await runCli(['review', '--json'], { cwd: root });
  assert.equal(review.code, 1);
  const json = JSON.parse(review.stdout);
  assert.equal(json.status, 'error');
  assert.match(json.error.message, /relative glob/i);
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'reviews')), []);
});


test('review --json analyzes changed python files and doctor requires python without Docker for python projects', async () => {
  const root = await makePythonCliRepo();

  const doctor = await runCli(['doctor'], { cwd: root });
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /Python: available/);
  assert.match(doctor.stdout, /Docker: not required/);

  const review = await runCli(['review', '--json'], { cwd: root });
  assert.equal(review.code, 3);
  assert.equal(review.stderr, '');

  const json = JSON.parse(review.stdout);
  assert.equal(json.command, 'review');
  assert.equal(json.status, 'unresolved');
  assert.equal(json.contract.id, 'search-scope');
  assert.equal(Array.isArray(json.questions), true);
  assert.equal(json.questions.length > 0, true);
  assert.equal(JSON.stringify(json).includes(root), false);
});

test('review exits 1 with a stable python analysis error and no persistence when python3 is unavailable', async () => {
  const root = await makePythonCliRepo();
  const gitOnlyPath = await makeGitOnlyPath();

  const result = await runCli(['review', '--json'], {
    cwd: root,
    env: { PATH: gitOnlyPath },
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');

  const json = JSON.parse(result.stdout);
  assert.equal(json.command, 'review');
  assert.equal(json.status, 'error');
  assert.equal(json.reportPath, null);
  assert.equal(json.questions, null);
  assert.equal(json.error.code, 'ERR_VLP_PYTHON_ANALYSIS');
  assert.equal(json.error.message, 'Python analysis failed');
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'reviews')), []);
  await assert.rejects(() => stat(path.join(root, '.vlp', 'reviews', '.sessions')), /ENOENT/);
});

test('delete-only review fails cleanly without falling back to whole-repo discovery', async () => {
  const root = await makeDeleteOnlyCliRepo();

  const result = await runCli(['review', '--json'], { cwd: root });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'error');
  assert.equal(json.error.message, 'No supported source files were found');
  assert.deepEqual(await readdir(path.join(root, '.vlp', 'reviews')), []);
  await assert.rejects(() => stat(path.join(root, '.vlp', 'reviews', '.sessions')), /ENOENT/);
});

test('review --json injects explicit FastAPI runtime diagnostics into JSON/report output while preserving Python analysis', async () => {
  const root = await makeFastApiCliRepo({ runtimeOptIn: true });

  const review = await runCli(['review', '--json'], { cwd: root });

  assert.equal(review.code, 3);
  assert.equal(review.stderr, '');

  const json = JSON.parse(review.stdout);
  const runtimeQuestion = json.questions.find((question) => question.type === 'runtime-diagnostic');
  assert.ok(runtimeQuestion);
  assert.deepEqual(runtimeQuestion.sourceEvidence, { file: 'fastapi runtime', lineStart: 0 });
  assert.deepEqual(runtimeQuestion.runtimeEvidence, { type: 'diagnostic', message: 'No requirements.txt found' });
  assert.equal(JSON.stringify(json).includes(root), false);

  const storedSession = JSON.parse(await readFile(path.join(root, '.vlp', 'reviews', '.sessions', `${json.sessionId}.json`), 'utf8'));
  assert.equal(storedSession.docUnits.some((unit) => unit.file === 'src/api.py'), true);
  assert.equal(storedSession.questions.some((question) => question.type === 'runtime-diagnostic'), true);

  const decisions = json.questions.map((question) => ({
    questionId: question.id,
    decision: 'accept',
    answer: '',
  }));
  const resolve = await runCli(['resolve', '--session', json.sessionId, '--input', '-', '--json'], {
    cwd: root,
    input: `${JSON.stringify({ sessionId: json.sessionId, decisions })}\n`,
  });

  assert.equal(resolve.code, 0);
  const resolved = JSON.parse(resolve.stdout);
  const report = await readFile(path.join(root, resolved.reportPath), 'utf8');
  assert.match(report, /Runtime OpenAPI evidence:\*\* \[Diagnostic\] No requirements\.txt found/);
  assert.doesNotMatch(report, /\/Users\//);
});

test('review --json does not inject FastAPI runtime diagnostics without explicit runtime config', async () => {
  const root = await makeFastApiCliRepo();

  const review = await runCli(['review', '--json'], { cwd: root });

  assert.equal(review.stderr, '');
  const json = JSON.parse(review.stdout);
  const questions = Array.isArray(json.questions) ? json.questions : [];
  assert.equal(questions.some((question) => question.type === 'runtime-diagnostic'), false);
});

test('review rejects --no-open unless --web is also selected', async () => {
  const root = await makeCliRepo();

  const result = await runCli(['review', '--no-open'], { cwd: root });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--no-open/i);
  assert.match(result.stderr, /--web/i);
});
