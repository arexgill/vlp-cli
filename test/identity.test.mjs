import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryPlanningFiles = new Set([
  'specs/2026-08-01-monkeypaw-full-rename-design.md',
  'specs/2026-08-01-monkeypaw-full-rename-plan.md',
]);
const oldLower = String.fromCharCode(118, 108, 112);
const oldUpper = oldLower.toUpperCase();
const forbidden = [
  oldLower,
  oldUpper,
  `.${oldLower}`,
  `${oldLower}-cli`,
  `@arexgill/${oldLower}`,
];

test('tracked product tree contains only the Monkeypaw identity', async () => {
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  const files = stdout.toString('utf8').split('\0').filter(Boolean)
    .filter((file) => !temporaryPlanningFiles.has(file));
  const findings = [];

  for (const file of files) {
    const content = await readFile(path.join(root, file));
    const text = content.toString('utf8').toLowerCase();
    for (const token of forbidden) {
      if (text.includes(token.toLowerCase())) findings.push(`${file}: ${JSON.stringify(token)}`);
    }
  }

  assert.deepEqual(findings, []);
});
