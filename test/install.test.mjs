import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildContractDocument } from '@arexgill/vlp-core';
import { initializeProject } from '@arexgill/vlp-cli';
import { startWebReviewServer } from '@arexgill/vlp-cli/web-server';
import { createReviewSession } from '@arexgill/vlp-core';
import { saveSession } from '@arexgill/vlp-cli/session-store';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commandBuffer = 20 * 1024 * 1024;
const version = '0.1.0';

async function run(command, args, { cwd = repoRoot, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

async function git(cwd, ...args) {
  const { code, stderr } = await run('git', args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

  assert.equal(code, 0, stderr);
}

async function createVersionAlias(distDir, fromVersion, toVersion, { binScript } = {}) {
  const aliasRoot = await mkdtemp(path.join(tmpdir(), 'vlp-release-alias-'));
  const extractRoot = path.join(aliasRoot, 'extract');
  const fromName = `vlp-cli-node-v${fromVersion}`;
  const toName = `vlp-cli-node-v${toVersion}`;
  const sourceTarball = path.join(distDir, `${fromName}.tar.gz`);
  const aliasTarball = path.join(distDir, `${toName}.tar.gz`);

  await mkdir(extractRoot, { recursive: true });
  await exec('tar', ['-xzf', sourceTarball, '-C', extractRoot], { maxBuffer: commandBuffer });
  await rm(path.join(extractRoot, toName), { recursive: true, force: true });
  await exec('mv', [path.join(extractRoot, fromName), path.join(extractRoot, toName)], { maxBuffer: commandBuffer });
  if (binScript) {
    await writeFile(path.join(extractRoot, toName, 'bin', 'vlp'), binScript, { mode: 0o755 });
  }
  await exec('tar', ['-czf', aliasTarball, '-C', extractRoot, toName], { maxBuffer: commandBuffer });
  await rm(aliasRoot, { recursive: true, force: true });
}

async function buildReleaseArtifacts() {
  const distRoot = await mkdtemp(path.join(tmpdir(), 'vlp-release-dist-'));
  const releaseDir = path.join(distRoot, `v${version}`);
  const releaseDir011 = path.join(distRoot, 'v0.1.1');
  const releaseDir012 = path.join(distRoot, 'v0.1.2');
  await mkdir(releaseDir, { recursive: true });
  await mkdir(releaseDir011, { recursive: true });
  await mkdir(releaseDir012, { recursive: true });

  const build = await run(process.execPath, ['scripts/build-node-bundle.mjs', '--output-dir', releaseDir]);
  assert.equal(build.code, 0, build.stderr);
  await createVersionAlias(releaseDir, version, '0.1.1');
  await createVersionAlias(releaseDir, version, '0.1.2', {
    binScript: `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' 'v0.1.2'
  exit 42
fi
printf '%s\n' 'v0.1.2'
exit 42
`,
  });
  await cp(path.join(releaseDir, 'vlp-cli-node-v0.1.1.tar.gz'), path.join(releaseDir011, 'vlp-cli-node-v0.1.1.tar.gz'));
  await cp(path.join(releaseDir, 'vlp-cli-node-v0.1.2.tar.gz'), path.join(releaseDir012, 'vlp-cli-node-v0.1.2.tar.gz'));

  for (const versionedReleaseDir of [releaseDir, releaseDir011, releaseDir012]) {
    await cp(path.join(repoRoot, 'install', 'install.sh'), path.join(versionedReleaseDir, 'install.sh'));
    await cp(path.join(repoRoot, 'install', 'uninstall.sh'), path.join(versionedReleaseDir, 'uninstall.sh'));
    const checksums = await run(process.execPath, ['scripts/generate-checksums.mjs', versionedReleaseDir]);
    assert.equal(checksums.code, 0, checksums.stderr);
  }

  return {
    distDir: distRoot,
    releaseDir,
    tarballPath: path.join(releaseDir, `vlp-cli-node-v${version}.tar.gz`),
    checksumPath: path.join(releaseDir, `vlp-cli-node-v${version}.tar.gz.sha256`),
  };
}

async function listTarEntries(tarballPath) {
  const { stdout } = await exec('tar', ['-tf', tarballPath], { maxBuffer: commandBuffer });
  return stdout.split('\n').filter(Boolean);
}

function contentTypeForDownload(filePath) {
  if (filePath.endsWith('.tar.gz')) {
    return 'application/gzip';
  }
  if (filePath.endsWith('.sha256') || filePath.endsWith('.sh') || filePath.endsWith('SHA256SUMS')) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

async function makeReleaseServer({ distDir, latestVersion = version, corruptChecksum = false, interruptVersion = null } = {}) {
  const resolvedDistDir = path.resolve(distDir);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/api/latest') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify({ tag_name: `v${latestVersion}` })}\n`);
      return;
    }

    if (url.pathname.startsWith('/download/')) {
      const relativePath = url.pathname.slice('/download/'.length);
      const filePath = path.resolve(resolvedDistDir, relativePath);
      const rootPrefix = `${resolvedDistDir}${path.sep}`;
      if (filePath !== resolvedDistDir && !filePath.startsWith(rootPrefix)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
        return;
      }

      const fileName = path.basename(filePath);
      if (corruptChecksum && fileName === `vlp-cli-node-v${version}.tar.gz.sha256`) {
        let body = await readFile(filePath, 'utf8');
        body = body.replace(/^[0-9a-f]+/i, '0'.repeat(64));
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(body);
        return;
      }

      if (interruptVersion && fileName === `vlp-cli-node-v${interruptVersion}.tar.gz`) {
        const body = await readFile(filePath);
        response.writeHead(200, { 'content-type': 'application/gzip' });
        response.write(body.subarray(0, Math.max(1, Math.floor(body.length / 4))));
        response.destroy();
        return;
      }

      try {
        const body = await readFile(filePath);
        response.writeHead(200, { 'content-type': contentTypeForDownload(filePath) });
        response.end(body);
        return;
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
        return;
      }
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found\n');
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function makeInstalledHome() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-install-home-'));
  const homeDir = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  const dataHome = path.join(root, 'data-home');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  return { root, homeDir, binDir, dataHome };
}

async function makeJavaScriptFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-installed-js-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'search.js'), 'export function searchProducts(products, query) {\n  return products;\n}\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(root, 'src', 'search.js'), 'export function searchProducts(products, query) {\n  if (!query) return products;\n  return products.filter((product) => product.name.toLowerCase().includes(query.toLowerCase()));\n}\n');
  await initializeProject(root);
  await writeFile(path.join(root, '.vlp', 'contracts', 'sample.md'), buildContractDocument({
    slug: 'sample',
    created: '2026-07-30T12:34:56.000Z',
    status: 'confirmed',
    sections: {
      Intent: ['Build searchProducts(products, query).'],
      'Acceptance Criteria': [
        '- Search relevance must consider product name, description, category, and tags.',
        '- Matching must be case-insensitive.',
      ],
      Exclusions: ['- None.'],
      Context: ['- Review only the changed JS source.'],
    },
  }));
  return root;
}

async function makePythonFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-installed-py-'));
  await git(root, 'init');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'search.py'), 'def search_products(products, query):\n    return products\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(root, 'src', 'search.py'), 'def search_products(products, query):\n    if not query:\n        return products\n    lowered = query.lower()\n    return [product for product in products if lowered in product["name"].lower()]\n');
  await initializeProject(root);
  await writeFile(path.join(root, '.vlp', 'contracts', 'sample.md'), buildContractDocument({
    slug: 'sample',
    created: '2026-07-30T12:34:56.000Z',
    status: 'confirmed',
    sections: {
      Intent: ['Build search_products(products, query).'],
      'Acceptance Criteria': [
        '- Search relevance must consider product name, description, category, and tags.',
        '- Matching must be case-insensitive.',
      ],
      Exclusions: ['- None.'],
      Context: ['- Review only the changed Python source.'],
    },
  }));
  return root;
}

async function runInstalledVlp(binDir, args, { cwd, env, input } = {}) {
  return run(path.join(binDir, 'vlp'), args, { cwd, env, input });
}

async function fakeNodeBin(root, fileName, { versionText, delegate } = {}) {
  const scriptPath = path.join(root, fileName);
  const body = delegate
    ? `#!/bin/sh\nexec \"${delegate}\" \"$@\"\n`
    : `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' '${versionText}'\n  exit 0\nfi\nprintf '%s\\n' '${versionText}'\nexit 0\n`;
  await writeFile(scriptPath, body, { mode: 0o755 });
}

async function fakePythonWrapper(root, logPath) {
  const realPython = (await exec('python3', ['-c', 'import sys; print(sys.executable)'], { maxBuffer: commandBuffer })).stdout.trim();
  const wrapperPath = path.join(root, 'python3');
  await writeFile(wrapperPath, `#!/bin/sh\nprintf '%s\n' \"$1\" >> \"${logPath}\"\nexec \"${realPython}\" \"$@\"\n`, { mode: 0o755 });
}

async function fakeBrowserOpeners(root, logPath) {
  for (const command of ['open', 'xdg-open']) {
    await writeFile(path.join(root, command), `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${logPath}\"\nexit 0\n`, { mode: 0o755 });
  }
}

async function fakeGuardedRm(root, dataHome) {
  const currentLink = path.join(dataHome, 'vlp-cli', 'current');
  await writeFile(path.join(root, 'rm'), `#!/bin/sh
set -eu
active_target=$(readlink "${currentLink}" 2>/dev/null || true)
if [ -n "$active_target" ]; then
  for arg in "$@"; do
    case "$arg" in
      -*)
        continue
        ;;
    esac
    if [ "$arg" = "$active_target" ]; then
      printf '%s\n' "attempted to delete active generation: $arg" >&2
      exit 99
    fi
  done
fi
exec /bin/rm "$@"
`, { mode: 0o755 });
}

async function fakeMvRejectingH(root) {
  await writeFile(path.join(root, 'mv'), `#!/bin/sh
set -eu
for arg in "$@"; do
  case "$arg" in
    -h|-hf|-fh)
      printf '%s\n' "mv -h is forbidden in atomic symlink replacement" >&2
      exit 88
      ;;
  esac
done
exec /bin/mv "$@"
`, { mode: 0o755 });
}

test('build-node-bundle produces a deterministic fallback tarball with the packaged helper, UI assets, lockfile metadata, and shim', async () => {
  const { tarballPath, checksumPath } = await buildReleaseArtifacts();
  const entries = await listTarEntries(tarballPath);

  assert(entries.includes(`vlp-cli-node-v${version}/LICENSE`));
  assert(entries.includes(`vlp-cli-node-v${version}/package-lock.json`));
  assert(entries.includes(`vlp-cli-node-v${version}/bin/vlp`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@arexgill/vlp-cli/bin/vlp.mjs`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@arexgill/vlp-cli/scripts/collect-openapi.py`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@arexgill/vlp-core/scripts/extract-python.py`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@arexgill/vlp-ui/public/index.html`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@arexgill/vlp-ui/public/styles.css`));
  assert(entries.includes(`vlp-cli-node-v${version}/node_modules/@babel/parser/package.json`));

  const checksum = await readFile(checksumPath, 'utf8');
  assert.match(checksum, /^[0-9a-f]{64}  vlp-cli-node-v0\.1\.0\.tar\.gz\n$/);
});

test('installed fallback layout exposes collect-openapi.py and resolves FastAPI OpenAPI through the packaged helper', async () => {
  const { tarballPath } = await buildReleaseArtifacts();
  const extractRoot = await mkdtemp(path.join(tmpdir(), 'vlp-install-layout-'));

  try {
    await exec('tar', ['-xzf', tarballPath, '-C', extractRoot], { maxBuffer: commandBuffer });

    const bundleRoot = path.join(extractRoot, `vlp-cli-node-v${version}`);
    const cliPackageRoot = path.join(bundleRoot, 'node_modules', '@arexgill', 'vlp-cli');
    const scriptPath = path.join(cliPackageRoot, 'scripts', 'collect-openapi.py');
    await access(scriptPath);
    const resolvedScriptPath = await realpath(scriptPath);

    const { collectFastApiOpenApi } = await import(pathToFileURL(path.join(cliPackageRoot, 'src', 'fastapi-runtime.mjs')).href);
    const appRoot = path.join(extractRoot, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(appRoot, 'requirements.txt'), 'fastapi\nuvicorn\n');

    const dockerCalls = [];
    const result = await collectFastApiOpenApi({
      root: appRoot,
      appTarget: 'service.api:app',
      runDocker: async (args, options = {}) => {
        dockerCalls.push({ args, options });

        if (args[0] === 'build') {
          return { stdout: 'image-123\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'run') {
          return {
            stdout: JSON.stringify({
              paths: {
                '/health': {
                  get: {
                    responses: {
                      '200': {
                        content: {
                          'application/json': {
                            schema: { $ref: '#/components/schemas/Health' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[0] === 'rmi') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(`Unexpected docker call: ${args.join(' ')}`);
      },
    });

    assert.equal(result.diagnostic, null);
    assert.deepEqual(result.openapi, {
      paths: {
        '/health': {
          get: {
            responses: {
              '200': {
                schemaRef: '#/components/schemas/Health',
              },
            },
          },
        },
      },
    });
    assert.equal(dockerCalls[1].args.includes(`${resolvedScriptPath}:/scripts/collect-openapi.py:ro`), true);
    assert.equal(dockerCalls[1].args.slice(-3).join(' '), 'python /scripts/collect-openapi.py service.api:app');
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
});

test('installer atomically replaces a preexisting bin symlink without mv -h even when it points at a directory', async () => {
  const artifacts = await buildReleaseArtifacts();
  const server = await makeReleaseServer({ distDir: artifacts.distDir });
  const installHome = await makeInstalledHome();
  const fakeBin = path.join(installHome.root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  await fakeMvRejectingH(fakeBin);
  const directoryTarget = path.join(installHome.root, 'existing-vlp-directory');
  await mkdir(directoryTarget, { recursive: true });
  await symlink(directoryTarget, path.join(installHome.binDir, 'vlp'));

  try {
    const install = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_VERSION: version,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });

    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /Installed vlp/);

    const binTarget = await realpath(path.join(installHome.binDir, 'vlp'));
    assert.match(binTarget, /\/0\.1\.0(?:\.generation\.[^/]+)?\/bin\/vlp$/);

    const versionResult = await runInstalledVlp(installHome.binDir, ['--version'], {
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(versionResult.code, 0, versionResult.stderr);
    assert.equal(versionResult.stdout.trim(), version);
  } finally {
    await server.close();
  }
});

test('installer resolves the latest release, installs into a temporary HOME, smoke-tests JS/Python flows, and generic Python uses host python3', async () => {
  const artifacts = await buildReleaseArtifacts();
  const server = await makeReleaseServer({ distDir: artifacts.distDir });
  const installHome = await makeInstalledHome();
  const pythonLog = path.join(installHome.root, 'python.log');
  const browserLog = path.join(installHome.root, 'browser.log');
  const fakeBin = path.join(installHome.root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  await fakePythonWrapper(fakeBin, pythonLog);
  await fakeBrowserOpeners(fakeBin, browserLog);

  try {
    const install = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_RELEASE_API_URL: `${server.baseUrl}/api/latest`,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });

    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /Installed vlp/);

    const versionResult = await runInstalledVlp(installHome.binDir, ['--version'], { env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(versionResult.code, 0, versionResult.stderr);
    assert.equal(versionResult.stdout.trim(), version);

    const jsRoot = await makeJavaScriptFixture();
    const jsReview = await runInstalledVlp(installHome.binDir, ['review', '--json'], {
      cwd: jsRoot,
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(jsReview.code, 3, jsReview.stdout + jsReview.stderr);
    const jsEnvelope = JSON.parse(jsReview.stdout);
    await writeFile(path.join(jsRoot, 'decisions.json'), `${JSON.stringify({
      sessionId: jsEnvelope.sessionId,
      decisions: jsEnvelope.questions.map((question) => ({ questionId: question.id, decision: 'accept', answer: '' })),
    }, null, 2)}\n`);
    const jsResolve = await runInstalledVlp(installHome.binDir, ['resolve', '--session', jsEnvelope.sessionId, '--input', 'decisions.json', '--json'], {
      cwd: jsRoot,
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(jsResolve.code, 0, jsResolve.stdout + jsResolve.stderr);

    const pyRoot = await makePythonFixture();
    const pyReview = await runInstalledVlp(installHome.binDir, ['review', '--json'], {
      cwd: pyRoot,
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(pyReview.code, 3, pyReview.stdout + pyReview.stderr);
    assert.match(await readFile(pythonLog, 'utf8'), /extract-python\.py/);
    await assert.rejects(() => readFile(browserLog, 'utf8'));
  } finally {
    await server.close();
  }
});

test('installer keeps the active generation usable until the atomic switch and leaves orphan generations alone on same-version reinstall', async () => {
  const artifacts = await buildReleaseArtifacts();
  const server = await makeReleaseServer({ distDir: artifacts.distDir });
  const installHome = await makeInstalledHome();
  const fakeBin = path.join(installHome.root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  await fakeGuardedRm(fakeBin, installHome.dataHome);

  try {
    const firstInstall = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_VERSION: version,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(firstInstall.code, 0, firstInstall.stderr);

    const firstTarget = await realpath(path.join(installHome.binDir, 'vlp'));
    const orphanDir = path.join(installHome.dataHome, 'vlp-cli', 'orphan-generation');
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, 'marker.txt'), 'orphan\n');

    const secondInstall = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_VERSION: version,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(secondInstall.code, 0, secondInstall.stderr);

    const secondTarget = await realpath(path.join(installHome.binDir, 'vlp'));
    assert.notEqual(secondTarget, firstTarget);
    assert.equal((await readFile(path.join(orphanDir, 'marker.txt'), 'utf8')).trim(), 'orphan');
    await assert.rejects(() => realpath(firstTarget));

    const versionResult = await runInstalledVlp(installHome.binDir, ['--version'], {
      env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(versionResult.code, 0, versionResult.stderr);
    assert.equal(versionResult.stdout.trim(), version);
  } finally {
    await server.close();
  }
});

test('installer rolls back to the previous generation when the atomic smoke test fails', async () => {
  const artifacts = await buildReleaseArtifacts();
  const server = await makeReleaseServer({ distDir: artifacts.distDir });
  const installHome = await makeInstalledHome();

  try {
    const firstInstall = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_VERSION: version,
      },
    });
    assert.equal(firstInstall.code, 0, firstInstall.stderr);

    const firstTarget = await realpath(path.join(installHome.binDir, 'vlp'));
    const orphanDir = path.join(installHome.dataHome, 'vlp-cli', 'orphan-generation');
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, 'marker.txt'), 'orphan\n');

    const failedInstall = await run('sh', ['install/install.sh'], {
      cwd: repoRoot,
      env: {
        HOME: installHome.homeDir,
        XDG_DATA_HOME: installHome.dataHome,
        VLP_INSTALL_DIR: installHome.binDir,
        VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
        VLP_VERSION: '0.1.2',
      },
    });
    assert.notEqual(failedInstall.code, 0);

    const currentTarget = await realpath(path.join(installHome.binDir, 'vlp'));
    assert.equal(currentTarget, firstTarget);

    const versionResult = await runInstalledVlp(installHome.binDir, ['--version']);
    assert.equal(versionResult.code, 0, versionResult.stderr);
    assert.equal(versionResult.stdout.trim(), version);

    const generations = await readdir(path.join(installHome.dataHome, 'vlp-cli'));
    assert(!generations.some((entry) => entry.startsWith('0.1.2.generation.')));
    assert.equal((await readFile(path.join(orphanDir, 'marker.txt'), 'utf8')).trim(), 'orphan');
  } finally {
    await server.close();
  }
});

test('installer verifies checksums, rejects unsupported Node, cleans up interrupted downloads, supports custom versions with atomic relinks, and uninstall removes only VLP-owned paths', async () => {
  const artifacts = await buildReleaseArtifacts();

  {
    const server = await makeReleaseServer({ distDir: artifacts.distDir, corruptChecksum: true });
    const installHome = await makeInstalledHome();
    try {
      const result = await run('sh', ['install/install.sh'], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
          VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
          VLP_VERSION: version,
        },
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /checksum/i);
    } finally {
      await server.close();
    }
  }

  {
    const server = await makeReleaseServer({ distDir: artifacts.distDir });
    const installHome = await makeInstalledHome();
    const fakeBin = path.join(installHome.root, 'fake-node-bin');
    await mkdir(fakeBin, { recursive: true });
    await fakeNodeBin(fakeBin, 'node', { versionText: 'v18.19.0' });
    await fakeNodeBin(fakeBin, 'node20', { versionText: 'v18.19.0' });
    await fakeNodeBin(fakeBin, 'nodejs', { versionText: 'v18.19.0' });
    try {
      const result = await run('sh', ['install/install.sh'], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
          VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
          VLP_VERSION: version,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Node 20\+/i);
    } finally {
      await server.close();
    }
  }

  {
    const server = await makeReleaseServer({ distDir: artifacts.distDir, interruptVersion: version });
    const installHome = await makeInstalledHome();
    try {
      const orphanDir = path.join(installHome.dataHome, 'vlp-cli', 'orphan-generation');
      await mkdir(orphanDir, { recursive: true });
      await writeFile(path.join(orphanDir, 'marker.txt'), 'orphan\n');

      const result = await run('sh', ['install/install.sh'], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
          VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
          VLP_VERSION: version,
        },
      });
      assert.equal(result.code, 1);
      await assert.rejects(() => realpath(path.join(installHome.binDir, 'vlp')));
      await assert.rejects(() => realpath(path.join(installHome.dataHome, 'vlp-cli', `${version}.generation`)));
      const entries = await readdir(path.join(installHome.dataHome, 'vlp-cli'));
      assert(!entries.some((entry) => entry.startsWith(`${version}.generation.`)));
      assert.equal((await readFile(path.join(orphanDir, 'marker.txt'), 'utf8')).trim(), 'orphan');
    } finally {
      await server.close();
    }
  }

  {
    const server = await makeReleaseServer({ distDir: artifacts.distDir });
    const installHome = await makeInstalledHome();
    const fakeBin = path.join(installHome.root, 'fallback-node-bin');
    await mkdir(fakeBin, { recursive: true });
    await fakeNodeBin(fakeBin, 'node', { versionText: 'v18.19.0' });
    await fakeNodeBin(fakeBin, 'node20', { delegate: process.execPath });

    try {
      const firstInstall = await run('sh', ['install/install.sh'], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
          VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
          VLP_VERSION: version,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
      });
      assert.equal(firstInstall.code, 0, firstInstall.stderr);
      const firstTarget = await realpath(path.join(installHome.binDir, 'vlp'));
      assert.match(firstTarget, /\/0\.1\.0(?:\.generation\.[^/]+)?\//);

      const secondInstall = await run('sh', ['install/install.sh'], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
          VLP_RELEASE_BASE_URL: `${server.baseUrl}/download`,
          VLP_VERSION: '0.1.1',
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
      });
      assert.equal(secondInstall.code, 0, secondInstall.stderr);
      const secondTarget = await realpath(path.join(installHome.binDir, 'vlp'));
      assert.match(secondTarget, /\/0\.1\.1(?:\.generation\.[^/]+)?\//);
      assert.notEqual(secondTarget, firstTarget);

      const externalTarget = path.join(installHome.root, 'external-vlp');
      await writeFile(externalTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await rm(path.join(installHome.binDir, 'vlp'));
      await symlink(externalTarget, path.join(installHome.binDir, 'vlp'));

      const installedUninstall = path.join(installHome.dataHome, 'vlp-cli', 'uninstall.sh');
      const uninstall = await run('sh', [installedUninstall], {
        cwd: repoRoot,
        env: {
          HOME: installHome.homeDir,
          XDG_DATA_HOME: installHome.dataHome,
          VLP_INSTALL_DIR: installHome.binDir,
        },
      });
      assert.equal(uninstall.code, 0, uninstall.stderr);
      assert.equal(await readFile(path.join(installHome.binDir, 'vlp'), 'utf8'), '#!/bin/sh\nexit 0\n');
      await assert.rejects(() => realpath(path.join(installHome.dataHome, 'vlp-cli', 'current')));
    } finally {
      await server.close();
    }
  }
});

test('installed/public web review assets still bind only to 127.0.0.1', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vlp-installed-web-'));
  await mkdir(path.join(root, '.git'));
  const session = createReviewSession({
    contract: {
      id: 'sample',
      slug: 'sample',
      status: 'confirmed',
      path: '.vlp/contracts/sample.md',
      content: '# Sample',
    },
    questions: [],
  }, { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
  await saveSession(root, session);
  const server = await startWebReviewServer({ root, sessionId: session.sessionId });

  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await server.close();
  }
});

test('release docs/workflow cover the phase-1 installer, privacy, limitations, and macOS/Linux x64-arm64 smoke matrix', async () => {
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const installer = await readFile(path.join(repoRoot, 'install', 'install.sh'), 'utf8');

  assert.match(readme, /terminal-first/i);
  assert.match(readme, /--web/);
  assert.match(readme, /python3/i);
  assert.match(readme, /FastAPI/i);
  assert.match(readme, /Docker/i);
  assert.match(readme, /privacy/i);
  assert.match(readme, /exit code/i);
  assert.match(readme, /uninstall/i);
  assert.match(readme, /sh "\$\{XDG_DATA_HOME:-\$HOME\/\.local\/share\}\/vlp-cli\/uninstall\.sh"/);
  assert.match(readme, /Phase 1/i);

  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /macos-13/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /build-node-bundle/);
  assert.match(workflow, /cp install\/install\.sh install\/uninstall\.sh "dist\/v\$VERSION\//);
  assert.match(workflow, /generate-checksums/);
  assert.match(workflow, /vlp review --json/);
  assert.match(workflow, /vlp resolve --session/);
  assert.doesNotMatch(installer, /\bsudo\b/);

  await assert.rejects(readFile(path.join(repoRoot, 'docs', 'reports', 'task-8-transaction-reliability.md')));
});
