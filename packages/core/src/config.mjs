import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

function cleanText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n');
}

function freezeConfig(config) {
  return Object.freeze({
    version: config.version,
    source: Object.freeze({
      include: Object.freeze([...config.source.include]),
      exclude: Object.freeze([...config.source.exclude]),
    }),
    runtime: config.runtime,
    agentReview: config.agentReview,
  });
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
      throw new Error(`Unknown top-level config key: ${key}`);
    }
  }

  for (const key of expectedKeys) {
    if (!(key in object)) {
      throw new Error(`Missing ${subject} key: ${key}`);
    }
  }
}

function assertExactArray(value, expected, subject) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${subject}: expected an array`);
  }

  if (value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`Invalid ${subject}: expected ${JSON.stringify(expected)}`);
  }
}

function validateConfig(config) {
  ensurePlainObject(config, 'Config must be a plain object');
  assertExactKeys(config, ['version', 'source', 'runtime', 'agentReview'], 'config');

  if (config.version !== DEFAULT_CONFIG.version) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  ensurePlainObject(config.source, 'Config source must be a plain object');
  assertExactKeys(config.source, ['include', 'exclude'], 'source');
  assertExactArray(config.source.include, DEFAULT_CONFIG.source.include, 'source.include');
  assertExactArray(config.source.exclude, DEFAULT_CONFIG.source.exclude, 'source.exclude');

  if (config.runtime !== null) {
    throw new Error('Config runtime must be null in phase 1');
  }

  if (config.agentReview !== 'off') {
    throw new Error('Config agentReview must remain "off" in phase 1');
  }

  return freezeConfig(config);
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
