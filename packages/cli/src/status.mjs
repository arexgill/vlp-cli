import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeSessionId } from '@arexgill/vlp-core';

function reviewDirectory(root) {
  return path.join(root, '.vlp', 'reviews');
}

export function nextStatusCommand(contracts = []) {
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

async function reviewAuditCandidates(root) {
  const directory = reviewDirectory(root);
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
      name: entry.name,
      filePath,
      mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0,
    });
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
}

async function parseAuditSummary(filePath) {
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

  if (typeof payload.status !== 'string' || !payload.status) {
    return null;
  }

  try {
    return {
      status: payload.status,
      sessionId: normalizeSessionId(payload.sessionId),
    };
  } catch {
    return null;
  }
}

export async function latestReviewSummary(root) {
  for (const candidate of await reviewAuditCandidates(root)) {
    const summary = await parseAuditSummary(candidate.filePath);
    if (summary) {
      return summary;
    }
  }

  return null;
}
