import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { applyDecisions, buildReport } from '@arexgill/vlp-core';

import { createJsonEnvelope, reviewContractPayload, reviewQuestionPayloads } from './json-output.mjs';
import { stageSessionSave } from './session-store.mjs';

export function reviewExitCode(session) {
  if ((session.questions || []).length !== (session.decisions || []).length) return 3;
  return (session.decisions || []).some((decision) => decision.decision === 'correct') ? 2 : 0;
}

async function ensureReviewDirectory(root) {
  const directory = path.join(root, '.vlp', 'reviews');
  await mkdir(directory, { recursive: true });
  return directory;
}

function unresolvedEnvelope(command, session) {
  return createJsonEnvelope({
    command,
    status: 'unresolved',
    sessionId: session.sessionId,
    contract: reviewContractPayload(session.contract),
    questions: reviewQuestionPayloads(session),
    reportPath: null,
    error: null,
  });
}

async function cleanupStages(stages) {
  await Promise.all(stages.map(async (stage) => {
    if (!stage?.cleanup) return;
    try {
      await stage.cleanup();
    } catch {
      // Best effort cleanup only.
    }
  }));
}

async function stageArtifactFile(directory, fileName, contents, {
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
} = {}) {
  const tempPath = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
  const finalPath = path.join(directory, fileName);

  await writeFileFn(tempPath, contents, { mode: 0o600 });

  return {
    tempPath,
    finalPath,
    async commit() {
      await renameFn(tempPath, finalPath);
      return finalPath;
    },
    async cleanup() {
      await rmFn(tempPath, { force: true });
    },
  };
}

export function createUnresolvedDecisionResult(command, session) {
  return {
    envelope: unresolvedEnvelope(command, session),
    exitCode: 3,
    reportPath: null,
    auditPath: null,
    markdown: null,
  };
}

export async function finalizeDecisionSubmission(root, command, session, submitted, options = {}) {
  const resolved = applyDecisions(session, submitted);

  if (resolved.decisions.length !== resolved.questions.length) {
    return createUnresolvedDecisionResult(command, resolved);
  }

  return writeFinalArtifacts(root, command, resolved, options);
}

export async function writeFinalArtifacts(root, command, resolvedSession, options = {}) {
  const {
    writeFileFn = writeFile,
    renameFn = rename,
    rmFn = rm,
    stageSessionSaveFn = stageSessionSave,
  } = options;
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
    contract: reviewContractPayload(resolvedSession.contract),
    questions: null,
    reportPath,
    error: null,
  });
  const auditPayload = `${JSON.stringify(envelope, null, 2)}\n`;

  const stages = [];

  try {
    const reportStage = await stageArtifactFile(reviewDirectory, `${resolvedSession.sessionId}.md`, markdown, {
      writeFileFn,
      renameFn,
      rmFn,
    });
    stages.push(reportStage);

    const auditStage = await stageArtifactFile(reviewDirectory, `${resolvedSession.sessionId}.json`, auditPayload, {
      writeFileFn,
      renameFn,
      rmFn,
    });
    stages.push(auditStage);

    const sessionStage = await stageSessionSaveFn(root, resolvedSession, {
      writeFileFn,
      renameFn,
      rmFn,
    });
    stages.push(sessionStage);

    await reportStage.commit();
    await auditStage.commit();
    await sessionStage.commit();
  } catch (error) {
    await cleanupStages(stages);
    throw error;
  }

  await cleanupStages(stages);
  return { envelope, exitCode, reportPath, auditPath, markdown };
}
