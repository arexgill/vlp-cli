import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldLower = String.fromCharCode(118, 108, 112);
const oldUpper = oldLower.toUpperCase();
const oldScope = `@${oldLower}`;
const forbidden = [
  oldLower,
  oldUpper,
  `.${oldLower}`,
  `${oldLower}-cli`,
  `${oldLower}-node-v`,
  `${oldLower}_version`,
  `${oldLower}_install_dir`,
  `${oldLower}_release_base_url`,
  `${oldLower}_release_api_url`,
  `${oldScope}/cli`,
  `${oldScope}/core`,
  `${oldScope}/ui`,
  `bin/${oldLower}`,
  `share/${oldLower}`,
  `@arexgill/${oldLower}`,
];

test('tracked product tree contains only the Monkeypaw identity', async () => {
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  const files = stdout.toString('utf8').split('\0').filter(Boolean)

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
