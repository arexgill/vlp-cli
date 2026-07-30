import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createSourcePathMatcher, validateSourceGlobArray } from './source-paths.mjs';

export const CONFIG_PATH = '.vlp/config.json';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  source: Object.freeze({
    include: Object.freeze(['**/*']),
    exclude: Object.freeze(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv']),
  }),
  runtime: null,
  agentReview: 'off',
});

const PYTHON_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const PYTHON_DOTTED_PATH = new RegExp(`^${PYTHON_IDENTIFIER}(?:\\.${PYTHON_IDENTIFIER})*$`);

function cleanText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n');
}

function ensurePlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertExactKeys(object, expectedKeys, subject) {
  const actualKeys = Object.keys(object);

  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) {
      throw new Error(`Unknown ${subject} key: ${key}`);
    }
  }

  for (const key of expectedKeys) {
    if (!(key in object)) {
      throw new Error(`Missing ${subject} key: ${key}`);
    }
  }
}

function freezeRuntime(runtime) {
  if (runtime === null) {
    return null;
  }

  return Object.freeze({
    type: runtime.type,
    app: runtime.app,
  });
}

function freezeConfig(config) {
  return Object.freeze({
    version: config.version,
    source: Object.freeze({
      include: Object.freeze([...config.source.include]),
      exclude: Object.freeze([...config.source.exclude]),
    }),
    runtime: freezeRuntime(config.runtime),
    agentReview: config.agentReview,
  });
}

function validateRuntime(runtime) {
  if (runtime === null) {
    return null;
  }

  ensurePlainObject(runtime, 'Config runtime must be null or a plain object');
  assertExactKeys(runtime, ['type', 'app'], 'runtime');

  if (runtime.type !== 'fastapi') {
    throw new Error(`Unsupported runtime type: ${runtime.type}`);
  }

  if (typeof runtime.app !== 'string' || runtime.app.length === 0 || runtime.app !== runtime.app.trim()) {
    throw new Error('Runtime app target must be a non-empty string');
  }

  const [modulePath, attributePath, extra] = runtime.app.split(':');
  if (!modulePath || !attributePath || extra !== undefined) {
    throw new Error('Runtime app target must use module.path:attribute syntax');
  }

  if (!PYTHON_DOTTED_PATH.test(modulePath) || !PYTHON_DOTTED_PATH.test(attributePath)) {
    throw new Error('Runtime app target must use conservative Python module/attribute syntax');
  }

  return {
    type: 'fastapi',
    app: runtime.app,
  };
}

function validateConfig(config) {
  ensurePlainObject(config, 'Config must be a plain object');
  assertExactKeys(config, ['version', 'source', 'runtime', 'agentReview'], 'top-level config');

  if (config.version !== DEFAULT_CONFIG.version) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  ensurePlainObject(config.source, 'Config source must be a plain object');
  assertExactKeys(config.source, ['include', 'exclude'], 'source');
  const include = validateSourceGlobArray(config.source.include, 'source.include');
  const exclude = validateSourceGlobArray(config.source.exclude, 'source.exclude');
  createSourcePathMatcher({ include, exclude });

  const runtime = validateRuntime(config.runtime);

  if (config.agentReview !== 'off') {
    throw new Error('Config agentReview must remain "off" in phase 1');
  }

  return freezeConfig({
    ...config,
    source: { include, exclude },
    runtime,
  });
}

export function formatConfig(config = DEFAULT_CONFIG) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function loadConfig(root) {
  const filePath = path.join(path.resolve(String(root ?? '.')), CONFIG_PATH);
  const rawConfig = JSON.parse(cleanText(await readFile(filePath, 'utf8')));
  return validateConfig(rawConfig);
}

export function validateConfigShape(config) {
  return validateConfig(config);
}
