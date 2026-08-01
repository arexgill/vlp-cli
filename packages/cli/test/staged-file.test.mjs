import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageAtomicFile } from '../src/staged-file.mjs';

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'monkeypaw-staged-file-'));
}

function failOnce(when, message) {
  return { when, message, persistent: false, used: false };
}

function failAlways(when, message) {
  return { when, message, persistent: true, used: false };
}

function createRenamePlan(rules = []) {
  const calls = [];

  return {
    calls,
    async fn(from, to) {
      calls.push({ from, to });
      for (const rule of rules) {
        if (!rule.when({ from, to })) continue;
        if (!rule.persistent && rule.used) continue;
        rule.used = true;
        throw new Error(rule.message);
      }
      return rename(from, to);
    },
  };
}

function createRmPlan(rules = []) {
  const calls = [];

  return {
    calls,
    async fn(target, options) {
      calls.push({ target, options });
      for (const rule of rules) {
        if (!rule.when({ target, options })) continue;
        if (!rule.persistent && rule.used) continue;
        rule.used = true;
        throw new Error(rule.message);
      }
      return rm(target, options);
    },
  };
}

test('stageAtomicFile retains a recoverable backup and exposes the restore failure when commit cannot restore the original file', async () => {
  const root = await makeRoot();
  const finalPath = path.join(root, 'artifact.json');
  await writeFile(finalPath, '{"status":"previous"}\n');

  const renamePlan = createRenamePlan([
    failOnce(({ from, to }) => from.endsWith('.tmp') && to === finalPath, 'Injected commit failure'),
    failAlways(({ from, to }) => from.endsWith('.bak') && to === finalPath, 'Injected restore failure'),
  ]);

  const stage = await stageAtomicFile(finalPath, '{"status":"next"}\n', {
    renameFn: renamePlan.fn,
  });

  const error = await stage.commit().catch((caught) => caught);
  assert.equal(error?.message, 'Injected commit failure');
  assert.deepEqual(error?.secondaryErrors?.map((failure) => failure.message), ['Injected restore failure']);

  await stage.cleanup();

  const entries = (await readdir(root)).sort();
  const backupFile = entries.find((entry) => entry.endsWith('.bak'));

  assert.equal(entries.includes('artifact.json'), false);
  assert.equal(entries.some((entry) => entry.endsWith('.tmp')), false);
  assert.ok(backupFile);
  assert.equal(await readFile(path.join(root, backupFile), 'utf8'), '{"status":"previous"}\n');
});

test('stageAtomicFile cleanup attempts temp and backup removal before throwing aggregated cleanup failures', async () => {
  const root = await makeRoot();
  const finalPath = path.join(root, 'artifact.json');
  await writeFile(finalPath, '{"status":"previous"}\n');

  const rmPlan = createRmPlan([
    failOnce(({ target }) => target.endsWith('.tmp'), 'Injected temp cleanup failure'),
    failAlways(({ target }) => target.endsWith('.bak'), 'Injected backup cleanup failure'),
  ]);

  const stage = await stageAtomicFile(finalPath, '{"status":"next"}\n', {
    rmFn: rmPlan.fn,
  });

  await stage.commit();

  const error = await stage.cleanup().catch((caught) => caught);
  assert.equal(error?.message, 'Injected temp cleanup failure');
  assert.deepEqual(error?.secondaryErrors?.map((failure) => failure.message), ['Injected backup cleanup failure']);
  assert.equal(rmPlan.calls.some(({ target }) => target.endsWith('.tmp')), true);
  assert.equal(rmPlan.calls.some(({ target }) => target.endsWith('.bak')), true);
});
