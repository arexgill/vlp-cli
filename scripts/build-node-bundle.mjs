import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedTimestamp = new Date('2026-01-01T00:00:00.000Z');
const commandBuffer = 20 * 1024 * 1024;

function parseArgs(argv) {
  let outputDir = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') {
      outputDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!outputDir) {
    throw new Error('Usage: node scripts/build-node-bundle.mjs --output-dir <directory>');
  }

  return { outputDir: path.resolve(repoRoot, outputDir) };
}

async function readVersion() {
  return JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

async function packWorkspaces(packDir) {
  const { stdout } = await exec('npm', ['pack', '--workspaces', '--json', '--pack-destination', packDir], {
    cwd: repoRoot,
    maxBuffer: commandBuffer,
  });
  return JSON.parse(stdout);
}

function packageInstallPath(packageName) {
  const [, shortName] = packageName.split('/');
  return path.join('@arexgill', shortName);
}

async function extractWorkspaceTarballs(packResults, packDir, bundleRoot) {
  const nodeModulesRoot = path.join(bundleRoot, 'node_modules');
  await mkdir(nodeModulesRoot, { recursive: true });

  for (const packResult of packResults) {
    const tarballPath = path.join(packDir, packResult.filename);
    const installPath = path.join(nodeModulesRoot, packageInstallPath(packResult.name));
    await mkdir(installPath, { recursive: true });
    await exec('tar', ['-xf', tarballPath, '-C', installPath, '--strip-components=1', 'package'], {
      maxBuffer: commandBuffer,
    });
  }
}

async function copyRuntimeDependencies(bundleRoot) {
  await cp(path.join(repoRoot, 'node_modules', '@babel'), path.join(bundleRoot, 'node_modules', '@babel'), { recursive: true });
}

async function writeShim(bundleRoot) {
  const shimPath = path.join(bundleRoot, 'bin', 'vlp');
  await mkdir(path.dirname(shimPath), { recursive: true });
  await writeFile(
    shimPath,
    `#!/bin/sh
set -eu

SCRIPT_PATH=$0
while [ -L "$SCRIPT_PATH" ]; do
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case "$LINK_TARGET" in
    /*)
      SCRIPT_PATH="$LINK_TARGET"
      ;;
    *)
      SCRIPT_PATH=$(dirname -- "$SCRIPT_PATH")/$LINK_TARGET
      ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)
CLI_ENTRY="$SCRIPT_DIR/../node_modules/@arexgill/vlp-cli/bin/vlp.mjs"

resolve_node() {
  for candidate in node node20 nodejs; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    version=$($candidate --version 2>/dev/null | sed 's/^v//')
    major=\${version%%.*}
    case "$major" in
      ''|*[!0-9]*)
        continue
        ;;
    esac
    if [ "$major" -ge 20 ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN=$(resolve_node || true)
if [ -z "$NODE_BIN" ]; then
  printf '%s\n' 'VLP requires Node 20+ via node, node20, or nodejs.' >&2
  exit 1
fi

exec "$NODE_BIN" "$CLI_ENTRY" "$@"
`,
    { mode: 0o755 },
  );
}

async function copyBundleMetadata(bundleRoot) {
  await cp(path.join(repoRoot, 'LICENSE'), path.join(bundleRoot, 'LICENSE'));
  await cp(path.join(repoRoot, 'package-lock.json'), path.join(bundleRoot, 'package-lock.json'));
}

async function touchTree(entryPath) {
  const entry = await stat(entryPath);
  if (entry.isDirectory()) {
    for (const child of (await readdir(entryPath)).sort()) {
      await touchTree(path.join(entryPath, child));
    }
  }
  await utimes(entryPath, fixedTimestamp, fixedTimestamp);
}

async function listTarPaths(rootPath, relativePath = '') {
  const absolutePath = path.join(rootPath, relativePath);
  const entry = await stat(absolutePath);
  const normalized = relativePath.split(path.sep).join('/');
  const entries = normalized ? [normalized] : [];

  if (!entry.isDirectory()) {
    return entries;
  }

  for (const child of (await readdir(absolutePath)).sort()) {
    entries.push(...(await listTarPaths(rootPath, path.join(relativePath, child))));
  }

  return entries;
}

async function createDeterministicTarGz(stagingRoot, bundleName, outputPath) {
  const tarPath = path.join(stagingRoot, `${bundleName}.tar`);
  const manifestPath = path.join(stagingRoot, `${bundleName}.manifest`);
  const tarEntries = [
    bundleName,
    ...(await listTarPaths(path.join(stagingRoot, bundleName))).map((entry) => path.posix.join(bundleName, entry)),
  ].join('\n');
  await writeFile(manifestPath, `${tarEntries}\n`);
  await exec('tar', ['-cf', tarPath, '--format', 'ustar', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', '-C', stagingRoot, '-T', manifestPath], {
    maxBuffer: commandBuffer,
  });
  await pipeline(createReadStream(tarPath), createGzip({ level: 9, mtime: 0 }), createWriteStream(outputPath));
}

async function build() {
  const { outputDir } = parseArgs(process.argv.slice(2));
  const version = await readVersion();
  const bundleName = `vlp-cli-node-v${version}`;
  const tarballPath = path.join(outputDir, `${bundleName}.tar.gz`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'vlp-node-bundle-'));
  const packDir = path.join(tempRoot, 'packs');
  const stagingRoot = path.join(tempRoot, 'staging');
  const bundleRoot = path.join(stagingRoot, bundleName);

  await mkdir(outputDir, { recursive: true });
  await mkdir(packDir, { recursive: true });
  await mkdir(bundleRoot, { recursive: true });

  try {
    const packResults = await packWorkspaces(packDir);
    await extractWorkspaceTarballs(packResults, packDir, bundleRoot);
    await copyRuntimeDependencies(bundleRoot);
    await copyBundleMetadata(bundleRoot);
    await writeShim(bundleRoot);
    await touchTree(bundleRoot);
    await createDeterministicTarGz(stagingRoot, bundleName, tarballPath);
    process.stdout.write(`${tarballPath}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await build();
