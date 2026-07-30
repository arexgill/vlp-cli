import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  applyDecisions,
  buildReport,
  createReviewSession,
  discoverSources,
  loadConfig,
  normalizeContractSlug,
  readContractDocument,
  reviewContract,
} from '@arexgill/vlp-core';

import { handleContractConfirm, handleContractCreate } from './commands/contract.mjs';
import { handleInit } from './commands/init.mjs';
import { selectChangedFiles } from './git-scope.mjs';
import { createJsonEnvelope, reviewContractPayload, reviewQuestionPayloads, serializeJsonError, writeJson } from './json-output.mjs';
import { helpText, parseArgs } from './parse-args.mjs';
import { resolveProjectRoot } from './project.mjs';
import { loadSession, saveSession } from './session-store.mjs';
import { runTerminalReview } from './terminal-review.mjs';

const exec = promisify(execFile);
const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);

function isInteractive(tty = {}, stdin, stdout) {
  const inputTty = typeof tty?.stdin === 'boolean' ? tty.stdin : Boolean(stdin?.isTTY);
  const outputTty = typeof tty?.stdout === 'boolean' ? tty.stdout : Boolean(stdout?.isTTY);
  return inputTty && outputTty;
}

function relativeDisplayPath(cwd, targetPath) {
  const relative = path.relative(path.resolve(cwd), path.resolve(targetPath));
  if (!relative) return '.';
  return relative.split(path.sep).join('/');
}

async function cliVersion() {
  const filePath = new URL('../package.json', import.meta.url);
  return JSON.parse(await readFile(filePath, 'utf8')).version;
}

function printLine(stream, message = '') {
  stream.write(`${message}\n`);
}

async function listContracts(root) {
  const directory = path.join(root, '.vlp', 'contracts');
  const entries = await readdir(directory, { withFileTypes: true });
  const contracts = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    contracts.push(await readContractDocument(root, entry.name.slice(0, -3)));
  }

  return contracts;
}

function reviewableContractRecord(record) {
  return {
    id: record.slug,
    status: record.status,
    path: record.path,
    content: record.content,
  };
}

async function selectContract(root, requestedName) {
  if (requestedName) {
    const record = await readContractDocument(root, normalizeContractSlug(requestedName));
    if (record.status !== 'confirmed') {
      throw new Error('Contract must be confirmed before review');
    }
    return record;
  }

  const confirmed = (await listContracts(root)).filter((record) => record.status === 'confirmed');
  if (confirmed.length === 0) {
    throw new Error('No confirmed contract found');
  }
  if (confirmed.length > 1) {
    throw new Error('Multiple confirmed contracts found; use --contract <name>');
  }
  return confirmed[0];
}

function reviewExitCode(session) {
  if ((session.questions || []).length !== (session.decisions || []).length) return 3;
  return (session.decisions || []).some((decision) => decision.decision === 'correct') ? 2 : 0;
}

async function ensureReviewDirectory(root) {
  const directory = path.join(root, '.vlp', 'reviews');
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeFinalArtifacts(root, command, contractRecord, resolvedSession) {
  const reviewDirectory = await ensureReviewDirectory(root);
  const reportPath = `.vlp/reviews/${resolvedSession.sessionId}.md`;
  const auditPath = `.vlp/reviews/${resolvedSession.sessionId}.json`;
  const markdown = buildReport({ contract: resolvedSession.contract, session: resolvedSession, decisions: resolvedSession.decisions });
  const exitCode = reviewExitCode(resolvedSession);
  const status = exitCode === 2 ? 'corrections-required' : 'completed';
  const envelope = createJsonEnvelope({
    command,
    status,
    sessionId: resolvedSession.sessionId,
    contract: reviewContractPayload(contractRecord || resolvedSession.contract),
    questions: null,
    reportPath,
    error: null,
  });

  await writeFile(path.join(reviewDirectory, `${resolvedSession.sessionId}.md`), markdown);
  await writeFile(path.join(reviewDirectory, `${resolvedSession.sessionId}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  await saveSession(root, resolvedSession);

  return { envelope, exitCode, reportPath };
}

async function readInput(stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readResolveEnvelope(cwd, inputPath, stdin) {
  const content = inputPath === '-' ? await readInput(stdin) : await readFile(path.join(cwd, inputPath), 'utf8');
  return JSON.parse(content);
}

async function commandAvailable(command, args = ['--version']) {
  try {
    await exec(command, args, { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function statusLines(cwd) {
  const version = await cliVersion();
  const root = await resolveProjectRoot(cwd);
  const contracts = await listContracts(root);
  const confirmed = contracts.filter((record) => record.status === 'confirmed');
  const activeContract = confirmed.length === 1 ? confirmed[0].slug : confirmed.length > 1 ? 'multiple' : 'none';
  const changedFiles = (await selectChangedFiles(root)).filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath)));

  return [
    `Version: ${version}`,
    `Repository: ${relativeDisplayPath(cwd, root)}`,
    `Active contract: ${activeContract}`,
    `Changed supported files: ${changedFiles.length}`,
    `Latest review: none`,
    `Next: ${activeContract === 'none' ? 'vlp contract confirm <name>' : 'vlp review'}`,
  ];
}

async function projectNeedsPython(root, config) {
  if (!root) return false;
  if (config?.runtime?.type === 'fastapi') return true;

  try {
    await discoverSources({ root, languageMode: 'python' });
    return true;
  } catch (error) {
    if (/No supported source files were found/i.test(error.message)) {
      return false;
    }
    return true;
  }
}

async function doctorLines(cwd) {
  const version = await cliVersion();
  let root = null;
  let config = null;

  try {
    root = await resolveProjectRoot(cwd);
    config = await loadConfig(root);
  } catch {
    root = null;
    config = null;
  }

  const needsDocker = config?.runtime?.type === 'fastapi';
  const needsPython = await projectNeedsPython(root, config);

  return [
    `Version: ${version}`,
    `Node: available (${process.versions.node})`,
    `Git: ${await commandAvailable('git') ? 'available' : 'missing'}`,
    `Python: ${needsPython ? (await commandAvailable('python3') ? 'available' : 'missing') : 'not required'}`,
    `Docker: ${needsDocker ? (await commandAvailable('docker') ? 'available' : 'missing') : 'not required'}`,
  ];
}

async function handlePlainStructuredResult(result, stdout, stderr, successMessage) {
  if (!result.ok) {
    printLine(stderr, result.error.message);
    return 1;
  }

  printLine(stdout, successMessage(result.result));
  return 0;
}

async function runReview(parsed, context) {
  const { cwd, stdin, stdout, stderr, randomUUID, tty } = context;
  if (parsed.web) {
    throw new Error('review --web is not yet available until Task 8');
  }

  const root = await resolveProjectRoot(cwd);
  const contractRecord = await selectContract(root, parsed.contract);
  const changedPaths = await selectChangedFiles(root, { staged: parsed.staged, base: parsed.base || undefined });
  const sources = await discoverSources({ root, paths: changedPaths });
  const analysis = await reviewContract({ contract: { content: contractRecord.content }, sources });
  if (!parsed.json && !isInteractive(tty, stdin, stdout)) {
    throw new Error('Plain review requires an interactive terminal; use --json or --web');
  }

  const session = createReviewSession(
    {
      contract: reviewableContractRecord(contractRecord),
      sources: analysis.sources,
      docUnits: analysis.docUnits,
      diagnostics: analysis.diagnostics,
      questions: analysis.questions,
      meta: analysis.meta,
    },
    { randomUUID },
  );

  if (parsed.json) {
    if (session.questions.length === 0) {
      const resolved = applyDecisions(session, { sessionId: session.sessionId, decisions: [] });
      return writeFinalArtifacts(root, 'review', contractRecord, resolved);
    }

    await saveSession(root, session);
    return {
      envelope: createJsonEnvelope({
        command: 'review',
        status: 'unresolved',
        sessionId: session.sessionId,
        contract: reviewContractPayload(contractRecord),
        questions: reviewQuestionPayloads(session),
        reportPath: null,
        error: null,
      }),
      exitCode: 3,
      reportPath: null,
    };
  }

  const terminalResult = await runTerminalReview({ session, stdin, stdout, stderr });
  if (terminalResult.status !== 'completed') {
    return {
      envelope: createJsonEnvelope({
        command: 'review',
        status: 'unresolved',
        sessionId: session.sessionId,
        contract: reviewContractPayload(contractRecord),
        questions: reviewQuestionPayloads(session),
        reportPath: null,
        error: null,
      }),
      exitCode: 3,
      reportPath: null,
    };
  }

  const resolved = applyDecisions(session, { sessionId: session.sessionId, decisions: terminalResult.decisions });
  return writeFinalArtifacts(root, 'review', contractRecord, resolved);
}

async function runResolve(parsed, context) {
  const { cwd, stdin } = context;
  const root = await resolveProjectRoot(cwd);
  const session = await loadSession(root, parsed.session);
  const submitted = await readResolveEnvelope(cwd, parsed.input, stdin);
  const resolved = applyDecisions(session, submitted);

  await saveSession(root, resolved);
  if (resolved.decisions.length !== resolved.questions.length) {
    return {
      envelope: createJsonEnvelope({
        command: 'resolve',
        status: 'unresolved',
        sessionId: resolved.sessionId,
        contract: reviewContractPayload(resolved.contract),
        questions: reviewQuestionPayloads(resolved),
        reportPath: null,
        error: null,
      }),
      exitCode: 3,
      reportPath: null,
    };
  }

  return writeFinalArtifacts(root, 'resolve', resolved.contract, resolved);
}

export async function run({ argv = process.argv.slice(2), cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, isTTY: tty = {}, randomUUID } = {}) {
  try {
    const parsed = parseArgs(argv);

    if (parsed.command === 'help') {
      stdout.write(helpText());
      return 0;
    }

    if (parsed.command === 'version') {
      printLine(stdout, await cliVersion());
      return 0;
    }

    if (parsed.command === 'init') {
      return handlePlainStructuredResult(await handleInit({ root: cwd }), stdout, stderr, (result) => `Initialized VLP project at ${relativeDisplayPath(cwd, result.root)}`);
    }

    if (parsed.command === 'contract' && parsed.action === 'new') {
      return handlePlainStructuredResult(
        await handleContractCreate({ root: cwd, name: parsed.name, force: parsed.force }),
        stdout,
        stderr,
        (result) => `Created contract ${result.slug} at ${result.path}`,
      );
    }

    if (parsed.command === 'contract' && parsed.action === 'confirm') {
      return handlePlainStructuredResult(
        await handleContractConfirm({ root: cwd, name: parsed.name }),
        stdout,
        stderr,
        (result) => `contract confirmed: ${result.slug} at ${result.path}`,
      );
    }

    if (parsed.command === 'review') {
      const result = await runReview(parsed, { cwd, stdin, stdout, stderr, randomUUID, tty });
      if (parsed.json) {
        writeJson(stdout, result.envelope);
      } else if (result.reportPath) {
        printLine(stdout, `Review report: ${result.reportPath}`);
      }
      return result.exitCode;
    }

    if (parsed.command === 'resolve') {
      const result = await runResolve(parsed, { cwd, stdin });
      writeJson(stdout, result.envelope);
      return result.exitCode;
    }

    if (parsed.command === 'status') {
      (await statusLines(cwd)).forEach((line) => printLine(stdout, line));
      return 0;
    }

    if (parsed.command === 'doctor') {
      (await doctorLines(cwd)).forEach((line) => printLine(stdout, line));
      return 0;
    }

    throw new Error(`Unknown command: ${parsed.command}`);
  } catch (error) {
    if (argv.includes('--json')) {
      writeJson(stdout, createJsonEnvelope({
        command: parseArgsSafe(argv),
        status: 'error',
        sessionId: null,
        contract: null,
        questions: null,
        reportPath: null,
        error: serializeJsonError(error),
      }));
      return 1;
    }

    printLine(stderr, error.message);
    return 1;
  }
}

function parseArgsSafe(argv) {
  try {
    return parseArgs(argv).command;
  } catch {
    return 'unknown';
  }
}
