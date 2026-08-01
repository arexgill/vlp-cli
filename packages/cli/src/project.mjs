import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_CONFIG, CONFIG_PATH, formatConfig, loadConfig } from '@monkeypaw/core';

const MONKEYPAW_DIR = '.monkeypaw';
const MONKEYPAW_CONTRACTS_DIR = path.posix.join(MONKEYPAW_DIR, 'contracts');
const MONKEYPAW_REVIEWS_DIR = path.posix.join(MONKEYPAW_DIR, 'reviews');
const MONKEYPAW_GITIGNORE_PATH = path.posix.join(MONKEYPAW_DIR, '.gitignore');
const HOST_GUIDANCE_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'COPILOT.md', 'CURSOR.md', 'WINDSURF.md'];

const MONKEYPAW_GITIGNORE_CONTENT = ['reviews/.sessions/', 'reviews/.cache/', 'reviews/*.tmp', ''].join('\n');

async function entryExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startPath) {
  let currentPath = path.resolve(String(startPath ?? '.'));

  for (;;) {
    if (await entryExists(path.join(currentPath, '.git'))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

export async function resolveProjectRoot(root) {
  const gitRoot = await findGitRoot(root);

  if (!gitRoot) {
    throw new Error('Project operations require a Git repository or worktree');
  }

  return gitRoot;
}

async function ensureDirectory(directoryPath, createdDirectories, rootPath) {
  if (await entryExists(directoryPath)) {
    return;
  }

  await mkdir(directoryPath, { recursive: true });
  createdDirectories.push(path.relative(rootPath, directoryPath).split(path.sep).join('/'));
}

async function discoverAdapters(rootPath) {
  const adapters = [];

  for (const fileName of HOST_GUIDANCE_FILES) {
    if (await entryExists(path.join(rootPath, fileName))) {
      adapters.push(fileName);
    }
  }

  return adapters;
}

export async function initializeProject(root) {
  const projectRoot = await resolveProjectRoot(root);

  const createdDirectories = [];
  const createdFiles = [];

  await ensureDirectory(path.join(projectRoot, MONKEYPAW_DIR), createdDirectories, projectRoot);
  await ensureDirectory(path.join(projectRoot, MONKEYPAW_CONTRACTS_DIR), createdDirectories, projectRoot);
  await ensureDirectory(path.join(projectRoot, MONKEYPAW_REVIEWS_DIR), createdDirectories, projectRoot);

  const configPath = path.join(projectRoot, CONFIG_PATH);
  if (await entryExists(configPath)) {
    await loadConfig(projectRoot);
  } else {
    await writeFile(configPath, formatConfig(DEFAULT_CONFIG));
    createdFiles.push(path.relative(projectRoot, configPath).split(path.sep).join('/'));
  }

  const gitignorePath = path.join(projectRoot, MONKEYPAW_GITIGNORE_PATH);
  if (!(await entryExists(gitignorePath))) {
    await writeFile(gitignorePath, MONKEYPAW_GITIGNORE_CONTENT);
    createdFiles.push(path.relative(projectRoot, gitignorePath).split(path.sep).join('/'));
  }

  return Object.freeze({
    root: projectRoot,
    gitRoot: projectRoot,
    created: Object.freeze({
      directories: Object.freeze(createdDirectories),
      files: Object.freeze(createdFiles),
    }),
    config: await loadConfig(projectRoot),
    adapters: Object.freeze(await discoverAdapters(projectRoot)),
  });
}
