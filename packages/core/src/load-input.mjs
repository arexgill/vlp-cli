import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_CONFIG } from './config.mjs';
import { resolveCoreLimits } from './limits.mjs';
import { createSourcePathMatcher } from './source-paths.mjs';

const JS_TS_PY_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
const JS_ONLY_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx']);
const TS_ONLY_EXTENSIONS = Object.freeze(['.ts', '.tsx']);
const PYTHON_ONLY_EXTENSIONS = Object.freeze(['.py']);

function isMissing(error) {
  return error?.code === 'ENOENT';
}

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
  if (extension === '.py') return 'python';
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

  if (languageMode === 'python') {
    return new Set(PYTHON_ONLY_EXTENSIONS);
  }

  if (languageMode === 'js-ts') {
    return new Set(JS_TS_PY_EXTENSIONS);
  }

  throw new Error(`Unsupported language mode: ${languageMode}`);
}

async function discoverDirectoryFiles(rootPath, directoryPath, extensions, matcher) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (!entries) {
    return [];
  }

  const paths = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const relativeDirectory = normalizeRelativePath(rootPath, fullPath);
      if (matcher.shouldPruneDirectory(relativeDirectory)) {
        continue;
      }

      paths.push(...(await discoverDirectoryFiles(rootPath, fullPath, extensions, matcher)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!extensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const relativePath = normalizeRelativePath(rootPath, fullPath);
    if (!matcher.matches(relativePath)) {
      continue;
    }

    paths.push({ path: relativePath, filePath: fullPath });
  }

  return paths;
}

function sortByRelativePath(candidates) {
  return [...candidates].sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveExplicitEntry(displayRoot, rootPath, entryPath) {
  const inputPath = String(entryPath);
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(displayRoot, inputPath);
  ensureWithinRoot(displayRoot, absolutePath);

  const entryStats = await lstat(absolutePath).catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (!entryStats) {
    return null;
  }

  const filePath = await realpath(absolutePath).catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (!filePath) {
    return null;
  }

  ensureWithinRoot(rootPath, filePath);

  const fileStats = await stat(filePath).catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (!fileStats) {
    return null;
  }

  return {
    displayPath: normalizeRelativePath(displayRoot, absolutePath),
    filePath,
    fileStats,
  };
}

async function collectExplicitCandidates(displayRoot, rootPath, entryPath, extensions, matcher, unsupportedExplicitFiles) {
  const resolved = await resolveExplicitEntry(displayRoot, rootPath, entryPath);
  if (!resolved) {
    return { candidates: [], resolved: 0 };
  }

  if (resolved.fileStats.isDirectory()) {
    return {
      candidates: await discoverDirectoryFiles(rootPath, resolved.filePath, extensions, matcher),
      resolved: 1,
    };
  }

  if (!resolved.fileStats.isFile()) {
    return { candidates: [], resolved: 1 };
  }

  const extension = path.extname(resolved.displayPath).toLowerCase();
  if (!extensions.has(extension)) {
    unsupportedExplicitFiles.push(resolved.displayPath);
    return { candidates: [], resolved: 1 };
  }

  if (!matcher.matches(resolved.displayPath)) {
    return { candidates: [], resolved: 1 };
  }

  return { candidates: [{ path: resolved.displayPath, filePath: resolved.filePath }], resolved: 1 };
}

function uniqueCandidates(candidates) {
  const deduped = new Map();

  for (const candidate of candidates) {
    if (!deduped.has(candidate.path)) {
      deduped.set(candidate.path, candidate);
    }
  }

  return sortByRelativePath([...deduped.values()]);
}

async function toSourceFile(candidate, limits) {
  const fileStat = await stat(candidate.filePath).catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (!fileStat) {
    return null;
  }

  if (fileStat.size > limits.maxSourceFileBytes) {
    throw new Error(`Source file exceeds 1 MiB: ${candidate.path}`);
  }

  const content = await readFile(candidate.filePath, 'utf8').catch((error) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });

  if (content === null) {
    return null;
  }

  return {
    path: candidate.path,
    language: languageFor(candidate.path),
    content,
  };
}

export async function discoverSources({
  root,
  paths,
  languageMode = 'js-ts',
  limits: limitOverrides,
  sourceConfig = DEFAULT_CONFIG.source,
} = {}) {
  const displayRoot = path.resolve(String(root ?? '.'));
  const rootPath = await realpath(displayRoot);
  const limits = resolveCoreLimits(limitOverrides);
  const extensions = extensionsFor(languageMode);
  const matcher = createSourcePathMatcher(sourceConfig);
  const candidates = [];
  const unsupportedExplicitFiles = [];
  let resolvedExplicitEntries = 0;
  const queue = paths === undefined ? ['.'] : paths;

  for (const entryPath of queue) {
    if (paths === undefined && entryPath === '.') {
      candidates.push(...(await discoverDirectoryFiles(rootPath, rootPath, extensions, matcher)));
      continue;
    }

    const collected = await collectExplicitCandidates(displayRoot, rootPath, entryPath, extensions, matcher, unsupportedExplicitFiles);
    resolvedExplicitEntries += collected.resolved;
    candidates.push(...collected.candidates);
  }

  const unique = uniqueCandidates(candidates);

  if (unique.length === 0 && queue.length === 1 && unsupportedExplicitFiles.length === 1 && resolvedExplicitEntries === 1) {
    throw new Error(`Unsupported code file. Supported extensions: ${[...extensions].join(', ')}`);
  }

  if (unique.length === 0) {
    throw new Error('No supported source files were found');
  }

  if (unique.length > limits.maxSourceFiles) {
    throw new Error(
      `Source limit exceeded: ${unique.length} files; maximum is ${limits.maxSourceFiles}`,
    );
  }

  const sources = [];
  for (const candidate of unique) {
    const source = await toSourceFile(candidate, limits);
    if (source) {
      sources.push(source);
    }
  }

  if (sources.length === 0) {
    throw new Error('No supported source files were found');
  }

  return sources;
}
