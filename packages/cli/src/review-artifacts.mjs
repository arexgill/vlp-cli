import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { applyDecisions, buildReport } from '@arexgill/vlp-core';

import { createJsonEnvelope, reviewContractPayload, reviewQuestionPayloads } from './json-output.mjs';
import { stageAtomicFile } from './staged-file.mjs';
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

async function cleanupStages(stages, { suppress = false } = {}) {
  let firstError = null;

  for (const stage of stages) {
    if (!stage?.cleanup) continue;
    try {
      await stage.cleanup();
    } catch (error) {
      firstError ??= error;
      if (!suppress) {
        throw error;
      }
    }
  }

  return firstError;
}

async function rollbackStages(stages, { suppress = false } = {}) {
  let firstError = null;

  for (const stage of [...stages].reverse()) {
    if (!stage?.rollback) continue;
    try {
      await stage.rollback();
    } catch (error) {
      firstError ??= error;
      if (!suppress) {
        throw error;
      }
    }
  }

  return firstError;
}

async function stageArtifactFile(directory, fileName, contents, {
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
} = {}) {
  const finalPath = path.join(directory, fileName);
  return stageAtomicFile(finalPath, contents, {
    writeFileFn,
    renameFn,
    rmFn,
    result: finalPath,
  });
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
  const committedStages = [];

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
    committedStages.push(reportStage);

    await auditStage.commit();
    committedStages.push(auditStage);

    await sessionStage.commit();
    committedStages.push(sessionStage);
  } catch (error) {
    await rollbackStages(committedStages, { suppress: true });
    await cleanupStages(stages, { suppress: true });
    throw error;
  }

  await cleanupStages(stages);
  return { envelope, exitCode, reportPath, auditPath, markdown };
}
