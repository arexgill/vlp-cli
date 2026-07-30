import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listArtifacts(directory) {
  const entries = [];

  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.sha256') || entry.name === 'SHA256SUMS') continue;
    entries.push(entry.name);
  }

  return entries;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function main() {
  const directoryArg = process.argv[2];
  if (!directoryArg) {
    throw new Error('Usage: node scripts/generate-checksums.mjs <directory>');
  }

  const directory = path.resolve(repoRoot, directoryArg);
  const stats = await stat(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  const artifacts = await listArtifacts(directory);
  const checksumLines = [];

  for (const artifact of artifacts) {
    const digest = await sha256(path.join(directory, artifact));
    const line = `${digest}  ${artifact}`;
    checksumLines.push(line);
    await writeFile(path.join(directory, `${artifact}.sha256`), `${line}\n`);
  }

  await writeFile(path.join(directory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
  process.stdout.write(`${path.join(directory, 'SHA256SUMS')}\n`);
}

await main();
