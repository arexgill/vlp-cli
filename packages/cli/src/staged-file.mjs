import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function suppress(action) {
  try {
    await action();
  } catch {
    // Preserve the primary error.
  }
}

async function writeTempFile(tempPath, contents, { writeFileFn, rmFn }) {
  try {
    await writeFileFn(tempPath, contents, { mode: 0o600 });
  } catch (error) {
    await suppress(async () => {
      await rmFn(tempPath, { force: true });
    });
    throw error;
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

  await writeTempFile(tempPath, contents, { writeFileFn, rmFn });

  return {
    tempPath,
    finalPath,
    backupPath,
    async commit() {
      hasBackup = await moveExistingToBackup(finalPath, backupPath, renameFn);

      try {
        await renameFn(tempPath, finalPath);
        committed = true;
        return typeof result === 'function' ? result() : result;
      } catch (error) {
        if (hasBackup) {
          await suppress(async () => {
            await renameFn(backupPath, finalPath);
          });
          hasBackup = false;
        }
        throw error;
      }
    },
    async rollback() {
      if (!committed) return;

      if (hasBackup) {
        await rmFn(finalPath, { force: true });
        await renameFn(backupPath, finalPath);
        hasBackup = false;
      } else {
        await rmFn(finalPath, { force: true });
      }

      committed = false;
    },
    async cleanup() {
      await rmFn(tempPath, { force: true });
      await rmFn(backupPath, { force: true });
    },
  };
}
