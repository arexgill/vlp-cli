import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  applyDecisions,
  createReviewSession,
  createSourcePathMatcher,
  discoverSources,
  loadConfig,
  normalizeContractSlug,
  readContractDocument,
  reviewContract,
} from '@arexgill/vlp-core';

import { handleContractConfirm, handleContractCreate } from './commands/contract.mjs';
import { handleWebReview } from './commands/web-review.mjs';
import { collectFastApiOpenApi } from './fastapi-runtime.mjs';
import { handleInit } from './commands/init.mjs';
import { selectChangedFiles } from './git-scope.mjs';
import { createJsonEnvelope, reviewContractPayload, reviewQuestionPayloads, serializeJsonError, writeJson } from './json-output.mjs';
import { helpText, parseArgs } from './parse-args.mjs';
import { readDecisionEnvelopeInput } from './resolve-input.mjs';
import { resolveProjectRoot } from './project.mjs';
import { finalizeDecisionSubmission, writeFinalArtifacts } from './review-artifacts.mjs';
import { latestReviewSummary, nextStatusCommand } from './status.mjs';
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
  const config = await loadConfig(root);
  const matcher = createSourcePathMatcher(config.source);
  const contracts = await listContracts(root);
  const confirmed = contracts.filter((record) => record.status === 'confirmed');
  const activeContract = confirmed.length === 1 ? confirmed[0].slug : confirmed.length > 1 ? 'multiple' : 'none';
  const changedFiles = (await selectChangedFiles(root)).filter((filePath) =>
    SUPPORTED_EXTENSIONS.has(path.extname(filePath)) && matcher.matches(filePath),
  );
  const latestReview = await latestReviewSummary(root);

  return [
    `Version: ${version}`,
    `Repository: ${relativeDisplayPath(cwd, root)}`,
    `Active contract: ${activeContract}`,
    `Changed supported files: ${changedFiles.length}`,
    `Latest review: ${latestReview ? `${latestReview.status} (${latestReview.sessionId})` : 'none'}`,
    `Next: ${nextStatusCommand(contracts, latestReview)}`,
  ];
}

async function projectNeedsPython(root, config) {
  if (!root) return false;
  if (config?.runtime?.type === 'fastapi') return true;

  try {
    await discoverSources({ root, languageMode: 'python', sourceConfig: config?.source });
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
  const lines = [
    `Version: ${version}`,
    `Node: available (${process.versions.node})`,
    `Git: ${await commandAvailable('git') ? 'available' : 'missing'}`,
  ];

  let root = null;
  try {
    root = await resolveProjectRoot(cwd);
  } catch {
    return [
      ...lines,
      'Project: not a Git repository or worktree',
      'Python: not required',
      'Docker: not required',
    ];
  }

  let config;
  try {
    config = await loadConfig(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    return [
      ...lines,
      `Project: not initialized (${relativeDisplayPath(cwd, root)})`,
      'Python: not required',
      'Docker: not required',
    ];
  }

  const needsDocker = config?.runtime?.type === 'fastapi';
  const needsPython = await projectNeedsPython(root, config);

  return [
    ...lines,
    `Project: ${relativeDisplayPath(cwd, root)}`,
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
  const { cwd, stdin, stdout, stderr, randomUUID, tty, artifactIO } = context;

  const root = await resolveProjectRoot(cwd);
  const config = await loadConfig(root);
  const contractRecord = await selectContract(root, parsed.contract);
  const changedPaths = await selectChangedFiles(root, { staged: parsed.staged, base: parsed.base || undefined });
  const sources = await discoverSources({ root, paths: changedPaths, sourceConfig: config.source });

  let runtimeEvidence = null;
  if (config?.runtime?.type === 'fastapi') {
    try {
      runtimeEvidence = await collectFastApiOpenApi({ root, appTarget: config.runtime.app });
    } catch {
      runtimeEvidence = null;
    }
  }

  const analysis = await reviewContract({ contract: { content: contractRecord.content }, sources, runtimeEvidence });
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
      return writeFinalArtifacts(root, 'review', resolved, artifactIO);
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

  if (parsed.web) {
    await saveSession(root, session);
    return handleWebReview({ root, session, stdout, open: !parsed.noOpen });
  }

  if (!isInteractive(tty, stdin, stdout)) {
    throw new Error('Plain review requires an interactive terminal; use --json or --web');
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
  return writeFinalArtifacts(root, 'review', resolved, artifactIO);
}

async function runResolve(parsed, context) {
  const { cwd, stdin, artifactIO } = context;
  const root = await resolveProjectRoot(cwd);
  const session = await loadSession(root, parsed.session);
  const submitted = await readDecisionEnvelopeInput(cwd, parsed.input, stdin);
  return finalizeDecisionSubmission(root, 'resolve', session, submitted, artifactIO);
}

export async function run({ argv = process.argv.slice(2), cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, isTTY: tty = {}, randomUUID, artifactIO = {} } = {}) {
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
      const result = await runReview(parsed, { cwd, stdin, stdout, stderr, randomUUID, tty, artifactIO });
      if (parsed.json) {
        writeJson(stdout, result.envelope);
      } else if (!parsed.web && result.reportPath) {
        printLine(stdout, `Review report: ${result.reportPath}`);
      }
      return result.exitCode;
    }

    if (parsed.command === 'resolve') {
      const result = await runResolve(parsed, { cwd, stdin, artifactIO });
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
