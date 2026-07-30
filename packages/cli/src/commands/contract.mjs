import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildContractDocument,
  contractFilePath,
  loadConfig,
  normalizeContractSlug,
  readContractDocument,
} from '@arexgill/vlp-core';

import { resolveProjectRoot } from '../project.mjs';

function serializeError(error) {
  return Object.freeze({
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code,
  });
}

function contractPathFromRoot(root, slug) {
  return path.relative(path.resolve(String(root ?? '.')), contractFilePath(root, slug)).split(path.sep).join('/');
}

function createResult(record) {
  return Object.freeze({
    slug: record.slug,
    path: record.path,
    status: record.status,
    created: record.created,
    scope: record.scope,
    content: record.content,
  });
}

export async function createContract(root, name, { force = false, clock = () => new Date(), writeFileFn = writeFile } = {}) {
  const rootPath = await resolveProjectRoot(root);
  const slug = normalizeContractSlug(name);
  await loadConfig(rootPath);
  const filePath = contractFilePath(rootPath, slug);
  const relativePath = contractPathFromRoot(rootPath, slug);

  await mkdir(path.dirname(filePath), { recursive: true });

  const clockValue = clock();
  const created = clockValue instanceof Date ? clockValue.toISOString() : new Date(clockValue).toISOString();
  const content = buildContractDocument({ slug, created });

  try {
    await writeFileFn(filePath, content, force ? undefined : { flag: 'wx' });
  } catch (error) {
    if (!force && error?.code === 'EEXIST') {
      throw new Error(`Contract already exists: ${relativePath}`);
    }
    throw error;
  }

  return createResult({
    slug,
    path: relativePath,
    status: 'draft',
    created,
    scope: 'working-tree',
    content,
  });
}

export async function confirmContract(root, name) {
  const rootPath = await resolveProjectRoot(root);
  const slug = normalizeContractSlug(name);
  await loadConfig(rootPath);
  const record = await readContractDocument(rootPath, slug);

  if (record.status !== 'draft') {
    throw new Error(`Contract is not draft: ${record.path}`);
  }

  const filePath = contractFilePath(rootPath, slug);
  const content = buildContractDocument({
    slug: record.slug,
    created: record.created,
    scope: record.scope,
    status: 'confirmed',
    sections: record.sections,
  });

  await writeFile(filePath, content);

  return createResult({
    slug: record.slug,
    path: record.path,
    status: 'confirmed',
    created: record.created,
    scope: record.scope,
    content,
  });
}

export async function handleContractCreate(input = {}) {
  try {
    return Object.freeze({
      ok: true,
      result: await createContract(input.root, input.name, input),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: serializeError(error),
    });
  }
}

export async function handleContractConfirm(input = {}) {
  try {
    return Object.freeze({
      ok: true,
      result: await confirmContract(input.root, input.name),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: serializeError(error),
    });
  }
}
