import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveCoreLimits } from './limits.mjs';

const JS_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const JS_ONLY_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx']);
const TS_ONLY_EXTENSIONS = Object.freeze(['.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

function ensureWithinRoot(rootPath, filePath) {
  const relativePath = path.relative(rootPath, filePath);

  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`Path is outside the configured root: ${filePath}`);
  }
}

function normalizeRelativePath(rootPath, filePath) {
  ensureWithinRoot(rootPath, filePath);

  const relativePath = path.relative(rootPath, filePath);
  if (!relativePath) {
    throw new Error(`Path must resolve to a file within the configured root: ${filePath}`);
  }

  return relativePath.split(path.sep).join('/');
}

function languageFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ['.ts', '.tsx'].includes(extension) ? 'typescript' : 'javascript';
}

function extensionsFor(languageMode = 'js-ts') {
  if (Array.isArray(languageMode)) {
    return new Set(languageMode.map((extension) => extension.toLowerCase()));
  }

  if (languageMode === 'javascript') {
    return new Set(JS_ONLY_EXTENSIONS);
  }

  if (languageMode === 'typescript') {
    return new Set(TS_ONLY_EXTENSIONS);
  }

  if (languageMode === 'js-ts') {
    return new Set(JS_EXTENSIONS);
  }

  throw new Error(`Unsupported language mode: ${languageMode}`);
}

async function discoverDirectoryFiles(rootPath, directoryPath, extensions) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await discoverDirectoryFiles(rootPath, fullPath, extensions)));
      continue;
    }

    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      paths.push(fullPath);
    }
  }

  return paths;
}

function sortByRelativePath(rootPath, paths) {
  return [...paths].sort((left, right) =>
    normalizeRelativePath(rootPath, left).localeCompare(normalizeRelativePath(rootPath, right)),
  );
}

async function toSourceFile(rootPath, filePath, limits) {
  const fileStat = await stat(filePath);
  const relativePath = normalizeRelativePath(rootPath, filePath);

  if (fileStat.size > limits.maxSourceFileBytes) {
    throw new Error(`Source file exceeds 1 MiB: ${relativePath}`);
  }

  return {
    path: relativePath,
    language: languageFor(filePath),
    content: await readFile(filePath, 'utf8'),
  };
}

export async function discoverSources({ root, paths = [], languageMode = 'js-ts', limits: limitOverrides } = {}) {
  const rootPath = path.resolve(String(root ?? '.'));
  const limits = resolveCoreLimits(limitOverrides);
  const extensions = extensionsFor(languageMode);
  const candidates = [];
  const unsupportedExplicitFiles = [];
  const queue = paths.length > 0 ? paths : ['.'];

  for (const entryPath of queue) {
    const absolutePath = path.resolve(rootPath, entryPath);
    ensureWithinRoot(rootPath, absolutePath);

    const entryStat = await stat(absolutePath);
    if (entryStat.isDirectory()) {
      candidates.push(...(await discoverDirectoryFiles(rootPath, absolutePath, extensions)));
      continue;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    if (entryStat.isFile() && extensions.has(extension)) {
      candidates.push(absolutePath);
      continue;
    }

    if (entryStat.isFile()) {
      unsupportedExplicitFiles.push(absolutePath);
    }
  }

  const uniqueCandidates = sortByRelativePath(rootPath, [...new Set(candidates)]);

  if (uniqueCandidates.length === 0 && unsupportedExplicitFiles.length > 0) {
    throw new Error(`Unsupported code file. Supported extensions: ${[...extensions].join(', ')}`);
  }

  if (uniqueCandidates.length === 0) {
    throw new Error('No supported source files were found');
  }

  if (uniqueCandidates.length > limits.maxSourceFiles) {
    throw new Error(
      `Source limit exceeded: ${uniqueCandidates.length} files; maximum is ${limits.maxSourceFiles}`,
    );
  }

  const sources = [];
  for (const filePath of uniqueCandidates) {
    sources.push(await toSourceFile(rootPath, filePath, limits));
  }

  return sources;
}
