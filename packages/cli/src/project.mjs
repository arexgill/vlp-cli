import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_CONFIG, CONFIG_PATH, formatConfig, loadConfig } from '@arexgill/vlp-core';

const VLP_DIR = '.vlp';
const VLP_CONTRACTS_DIR = path.posix.join(VLP_DIR, 'contracts');
const VLP_REVIEWS_DIR = path.posix.join(VLP_DIR, 'reviews');
const VLP_GITIGNORE_PATH = path.posix.join(VLP_DIR, '.gitignore');
const HOST_GUIDANCE_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'COPILOT.md', 'CURSOR.md', 'WINDSURF.md'];

const VLP_GITIGNORE_CONTENT = ['reviews/.sessions/', 'reviews/.cache/', 'reviews/*.tmp', ''].join('\n');

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
  const rootPath = path.resolve(String(root ?? '.'));
  const gitRoot = await findGitRoot(rootPath);

  if (!gitRoot) {
    throw new Error('Initialization requires a Git repository or worktree');
  }

  const createdDirectories = [];
  const createdFiles = [];

  await ensureDirectory(path.join(rootPath, VLP_DIR), createdDirectories, rootPath);
  await ensureDirectory(path.join(rootPath, VLP_CONTRACTS_DIR), createdDirectories, rootPath);
  await ensureDirectory(path.join(rootPath, VLP_REVIEWS_DIR), createdDirectories, rootPath);

  const configPath = path.join(rootPath, CONFIG_PATH);
  if (await entryExists(configPath)) {
    await loadConfig(rootPath);
  } else {
    await writeFile(configPath, formatConfig(DEFAULT_CONFIG));
    createdFiles.push(path.relative(rootPath, configPath).split(path.sep).join('/'));
  }

  const gitignorePath = path.join(rootPath, VLP_GITIGNORE_PATH);
  if (!(await entryExists(gitignorePath))) {
    await writeFile(gitignorePath, VLP_GITIGNORE_CONTENT);
    createdFiles.push(path.relative(rootPath, gitignorePath).split(path.sep).join('/'));
  }

  return Object.freeze({
    root: rootPath,
    gitRoot,
    created: Object.freeze({
      directories: Object.freeze(createdDirectories),
      files: Object.freeze(createdFiles),
    }),
    config: await loadConfig(rootPath),
    adapters: Object.freeze(await discoverAdapters(rootPath)),
  });
}
