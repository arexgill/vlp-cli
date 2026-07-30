import { buildReport } from '@arexgill/vlp-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createJsonEnvelope, reviewContractPayload } from './json-output.mjs';
import { saveSession } from './session-store.mjs';

export function reviewExitCode(session) {
  if ((session.questions || []).length !== (session.decisions || []).length) return 3;
  return (session.decisions || []).some((decision) => decision.decision === 'correct') ? 2 : 0;
}

async function ensureReviewDirectory(root) {
  const directory = path.join(root, '.vlp', 'reviews');
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function writeFinalArtifacts(root, command, resolvedSession) {
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

  await writeFile(path.join(reviewDirectory, `${resolvedSession.sessionId}.md`), markdown);
  await writeFile(path.join(reviewDirectory, `${resolvedSession.sessionId}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  await saveSession(root, resolvedSession);

  return { envelope, exitCode, reportPath, auditPath, markdown };
}
