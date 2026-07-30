import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { attachSecondaryErrors, collapseErrors } from './error-utils.mjs';

async function collectErrors(actions) {
  const failures = [];

  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }

  return failures;
}

async function writeTempFile(tempPath, contents, { writeFileFn, rmFn }) {
  try {
    await writeFileFn(tempPath, contents, { mode: 0o600 });
  } catch (error) {
    const cleanupErrors = await collectErrors([
      () => rmFn(tempPath, { force: true }),
    ]);
    throw attachSecondaryErrors(error, cleanupErrors, 'Failed to clean up a partial temp file');
  }
}

async function moveExistingToBackup(finalPath, backupPath, renameFn) {
  try {
    await renameFn(finalPath, backupPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function stageAtomicFile(finalPath, contents, {
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  result = finalPath,
} = {}) {
  const directory = path.dirname(finalPath);
  const fileName = path.basename(finalPath);
  const tempPath = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
  const backupPath = path.join(directory, `.${fileName}.${randomUUID()}.bak`);
  let committed = false;
  let hasBackup = false;
  let preserveBackup = false;

  await writeTempFile(tempPath, contents, { writeFileFn, rmFn });

  return {
    tempPath,
    finalPath,
    backupPath,
    async commit() {
      hasBackup = await moveExistingToBackup(finalPath, backupPath, renameFn);
      preserveBackup = false;

      try {
        await renameFn(tempPath, finalPath);
        committed = true;
        return typeof result === 'function' ? result() : result;
      } catch (error) {
        const restoreErrors = [];

        if (hasBackup) {
          try {
            await renameFn(backupPath, finalPath);
            hasBackup = false;
          } catch (restoreError) {
            preserveBackup = true;
            restoreErrors.push(restoreError);
          }
        }

        throw attachSecondaryErrors(error, restoreErrors, 'Failed to restore the backup file');
      }
    },
    async rollback() {
      if (!committed) return;

      const failures = hasBackup
        ? await collectErrors([
          () => rmFn(finalPath, { force: true }),
          async () => {
            await renameFn(backupPath, finalPath);
            hasBackup = false;
            preserveBackup = false;
          },
        ])
        : await collectErrors([
          () => rmFn(finalPath, { force: true }),
        ]);

      if (hasBackup && failures.length > 0) {
        preserveBackup = true;
      }

      committed = false;
      const rollbackError = collapseErrors(failures, 'Failed to roll back a staged file');
      if (rollbackError) {
        throw rollbackError;
      }
    },
    async cleanup() {
      const cleanupError = collapseErrors(await collectErrors([
        () => rmFn(tempPath, { force: true }),
        ...(preserveBackup ? [] : [() => rmFn(backupPath, { force: true })]),
      ]), 'Failed to clean up a staged file');

      if (cleanupError) {
        throw cleanupError;
      }
    },
  };
}
