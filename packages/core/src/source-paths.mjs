import path from 'node:path';

import picomatch from 'picomatch';

const GLOB_META_RE = /[*?\[\]{}()!+@]/;
const DEFAULT_SOURCE_CONFIG = Object.freeze({
  include: Object.freeze(['**/*']),
  exclude: Object.freeze(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv']),
});

export const SOURCE_GLOB_LIMITS = Object.freeze({
  maxPatterns: 64,
  maxPatternLength: 256,
});

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function validateSourceGlob(pattern, subject) {
  if (typeof pattern !== 'string') {
    throw new Error(`Invalid ${subject}: expected a string`);
  }

  const normalized = toPosix(pattern);
  if (normalized.length === 0 || normalized.trim() !== normalized) {
    throw new Error(`Invalid ${subject}: expected a non-empty relative glob string`);
  }

  if (normalized.length > SOURCE_GLOB_LIMITS.maxPatternLength) {
    throw new Error(
      `Invalid ${subject}: glob length ${normalized.length} exceeds ${SOURCE_GLOB_LIMITS.maxPatternLength}`,
    );
  }

  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(pattern)) {
    throw new Error(`Invalid ${subject}: expected a relative glob string`);
  }

  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Invalid ${subject}: expected a relative glob string`);
  }

  return pattern;
}

export function validateSourceGlobArray(value, subject) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${subject}: expected an array`);
  }

  if (value.length > SOURCE_GLOB_LIMITS.maxPatterns) {
    throw new Error(
      `Invalid ${subject}: expected at most ${SOURCE_GLOB_LIMITS.maxPatterns} patterns`,
    );
  }

  return Object.freeze(value.map((pattern, index) => validateSourceGlob(pattern, `${subject}[${index}]`)));
}

function normalizeRelativePath(relativePath) {
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid repository-relative path: ${relativePath}`);
  }
  return normalized;
}

function isBareDirectoryPattern(pattern) {
  return !pattern.includes('/') && !GLOB_META_RE.test(pattern);
}

function compilePattern(pattern, { bareDirectory = false } = {}) {
  const normalized = toPosix(pattern);

  if (bareDirectory && isBareDirectoryPattern(normalized)) {
    return {
      matchesPath(relativePath) {
        const directorySegments = normalizeRelativePath(relativePath).split('/').slice(0, -1);
        return directorySegments.includes(normalized);
      },
      matchesDirectory(relativePath) {
        return normalizeRelativePath(relativePath).split('/').includes(normalized);
      },
    };
  }

  const matcher = picomatch(normalized, { dot: true });
  return {
    matchesPath(relativePath) {
      return matcher(normalizeRelativePath(relativePath));
    },
    matchesDirectory(relativePath) {
      const normalizedDirectory = normalizeRelativePath(relativePath);
      return matcher(normalizedDirectory) || matcher(`${normalizedDirectory}/__monkeypaw_probe__`);
    },
  };
}

export function createSourcePathMatcher(sourceConfig = DEFAULT_SOURCE_CONFIG) {
  const include = validateSourceGlobArray(sourceConfig?.include ?? DEFAULT_SOURCE_CONFIG.include, 'source.include')
    .map((pattern) => compilePattern(pattern));
  const exclude = validateSourceGlobArray(sourceConfig?.exclude ?? DEFAULT_SOURCE_CONFIG.exclude, 'source.exclude')
    .map((pattern) => compilePattern(pattern, { bareDirectory: true }));

  return Object.freeze({
    matches(relativePath) {
      const normalized = normalizeRelativePath(relativePath);
      return include.some((pattern) => pattern.matchesPath(normalized))
        && !exclude.some((pattern) => pattern.matchesPath(normalized));
    },
    shouldPruneDirectory(relativePath) {
      const normalized = normalizeRelativePath(relativePath);
      return exclude.some((pattern) => pattern.matchesDirectory(normalized));
    },
  });
}
