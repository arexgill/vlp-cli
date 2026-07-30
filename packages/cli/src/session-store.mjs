import { lstat, mkdir, readFile, rename, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { normalizeReviewSession, normalizeSessionId } from '@arexgill/vlp-core';

const SESSION_DIR = ['.vlp', 'reviews', '.sessions'];

async function canonicalRoot(root) {
  return realpath(path.resolve(String(root ?? '.')));
}

async function ensureNotSymlink(entryPath) {
  try {
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link path: ${entryPath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function prepareSessionDirectory(root) {
  const canonical = await canonicalRoot(root);
  const directories = SESSION_DIR.map((segment, index) => path.join(canonical, ...SESSION_DIR.slice(0, index + 1)));

  for (const directory of directories) {
    await ensureNotSymlink(directory);
  }

  const sessionDir = directories[directories.length - 1];
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  return sessionDir;
}

function sessionFilePath(root, sessionId) {
  const safeSessionId = normalizeSessionId(sessionId);
  return path.join(root, ...SESSION_DIR, `${safeSessionId}.json`);
}

function assertSessionRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Malformed session file');
  }

  return normalizeReviewSession(record);
}

export async function saveSession(root, session) {
  const sessionDir = await prepareSessionDirectory(root);
  const canonical = await canonicalRoot(root);
  const normalized = assertSessionRecord(session);
  const filePath = sessionFilePath(canonical, normalized.sessionId);
  const tempPath = path.join(sessionDir, `.${normalized.sessionId}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;

  await writeFile(tempPath, payload, { mode: 0o600 });
  await rename(tempPath, filePath);

  return normalized;
}

export async function loadSession(root, id) {
  const sessionDir = await prepareSessionDirectory(root);
  const canonical = await canonicalRoot(root);
  const filePath = sessionFilePath(canonical, id);
  await ensureNotSymlink(filePath);

  try {
    const content = await readFile(filePath, 'utf8');
    return assertSessionRecord(JSON.parse(content));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new Error('Malformed session file');
    }
    throw error;
  }
}
