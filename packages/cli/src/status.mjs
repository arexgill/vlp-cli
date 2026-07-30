import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeReviewSession, normalizeSessionId, validateSubmittedDecisions } from '@arexgill/vlp-core';

function reviewDirectory(root) {
  return path.join(root, '.vlp', 'reviews');
}

function reviewSessionDirectory(root) {
  return path.join(reviewDirectory(root), '.sessions');
}

function reviewSessionFilePath(root, sessionId) {
  return path.join(reviewSessionDirectory(root), `${sessionId}.json`);
}

function safeMtimeMs(stats) {
  return Number.isFinite(stats?.mtimeMs) ? stats.mtimeMs : 0;
}

function clean(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

export function nextStatusCommand(contracts = [], latestReview = null) {
  if (latestReview?.status === 'unresolved' && latestReview?.sessionId) {
    return `vlp resolve --session ${latestReview.sessionId} --input <file> --json`;
  }

  const confirmed = (contracts || []).filter((record) => record?.status === 'confirmed');
  const drafts = (contracts || []).filter((record) => record?.status === 'draft');

  if ((contracts || []).length === 0) {
    return 'vlp contract new';
  }

  if (confirmed.length === 0) {
    if (drafts.length === 1) {
      return `vlp contract confirm ${drafts[0].slug}`;
    }

    return 'vlp contract new';
  }

  if (confirmed.length === 1) {
    return 'vlp review';
  }

  return 'vlp review --contract <slug>';
}

async function reviewCandidates(directory, kind) {
  let directoryStats;
  try {
    directoryStats = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  const candidates = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      continue;
    }

    candidates.push({
      kind,
      name: entry.name,
      filePath,
      mtimeMs: safeMtimeMs(stats),
    });
  }

  return candidates;
}

function compareCandidates(left, right) {
  return right.mtimeMs - left.mtimeMs
    || left.name.localeCompare(right.name)
    || (left.kind === 'session' ? -1 : 1);
}

async function parseJsonObject(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload;
}

function questionCount(session) {
  const seen = new Set();
  const questions = Array.isArray(session?.questions) ? session.questions : [];

  for (const question of questions) {
    const questionId = clean(question?.id);
    if (!questionId || seen.has(questionId)) {
      throw new Error('Malformed session file');
    }
    seen.add(questionId);
  }

  return questions.length;
}

function deriveSessionStatus(session) {
  const totalQuestions = questionCount(session);
  const decisions = validateSubmittedDecisions(session, session.decisions ?? []);

  if (decisions.length !== totalQuestions) {
    return 'unresolved';
  }

  return decisions.some((decision) => decision.decision === 'correct') ? 'corrections-required' : 'completed';
}

async function parseSessionSummary(filePath) {
  const payload = await parseJsonObject(filePath);
  if (!payload) {
    return null;
  }

  try {
    const session = normalizeReviewSession(payload);
    return {
      status: deriveSessionStatus(session),
      sessionId: session.sessionId,
    };
  } catch {
    return null;
  }
}

async function parseAuditReference(filePath) {
  const payload = await parseJsonObject(filePath);
  if (!payload) {
    return null;
  }

  try {
    return normalizeSessionId(payload.sessionId);
  } catch {
    return null;
  }
}

export async function latestReviewSummary(root) {
  const candidates = [
    ...(await reviewCandidates(reviewSessionDirectory(root), 'session')),
    ...(await reviewCandidates(reviewDirectory(root), 'audit')),
  ].sort(compareCandidates);

  for (const candidate of candidates) {
    if (candidate.kind === 'session') {
      const summary = await parseSessionSummary(candidate.filePath);
      if (summary) {
        return summary;
      }
      continue;
    }

    const sessionId = await parseAuditReference(candidate.filePath);
    if (!sessionId) {
      continue;
    }

    const summary = await parseSessionSummary(reviewSessionFilePath(root, sessionId));
    if (summary) {
      return summary;
    }
  }

  return null;
}
