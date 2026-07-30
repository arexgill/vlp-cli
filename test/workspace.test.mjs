import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspacePackagePaths = {
  'packages/core': '@arexgill/vlp-core',
  'packages/cli': '@arexgill/vlp-cli',
  'packages/ui': '@arexgill/vlp-ui',
};

const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const commandBuffer = 10 * 1024 * 1024;

async function readTarJson(tarballPath, entryPath) {
  const { stdout } = await exec('tar', ['-xOf', tarballPath, entryPath], { maxBuffer: commandBuffer });
  return JSON.parse(stdout);
}

async function listTarEntries(tarballPath) {
  const { stdout } = await exec('tar', ['-tf', tarballPath], { maxBuffer: commandBuffer });
  return stdout.split('\n').filter(Boolean);
}

async function extractTarball(tarballPath, destination) {
  await mkdir(destination, { recursive: true });
  await exec('tar', ['-xf', tarballPath, '-C', destination, '--strip-components=1', 'package'], { maxBuffer: commandBuffer });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function walkFiles(startDir) {
  const entries = [];
  for (const entry of readdirSync(startDir, { withFileTypes: true })) {
    const fullPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries;
}

function findWorkspaceImports(sourceText) {
  const imports = new Set();
  const importFromPattern = /(?:import|export)\s+[^'"`]*?from\s+['"]([^'"]+)['"]/g;
  const bareImportPattern = /import\s+['"]([^'"]+)['"]/g;
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const pattern of [importFromPattern, bareImportPattern, requirePattern]) {
    for (let match = pattern.exec(sourceText); match; match = pattern.exec(sourceText)) {
      imports.add(match[1]);
    }
  }

  return [...imports].filter((specifier) => specifier.startsWith('@arexgill/vlp-'));
}

test('workspace foundation metadata is correct', () => {
  const rootPackage = readJson(path.join(repoRoot, 'package.json'));

  assert.equal(rootPackage.name, 'vlp-cli-workspace');
  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.version, '0.1.0');
  assert.equal(rootPackage.license, 'MIT');
  assert.equal(rootPackage.type, 'module');
  assert.deepEqual(rootPackage.engines, { node: '>=20' });
  assert.deepEqual(rootPackage.workspaces, ['packages/*']);
  assert.deepEqual(rootPackage.scripts, {
    test: 'node --test',
    check: 'npm test && npm pack --workspaces --dry-run',
  });
  assert.equal(readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim(), '20');

  for (const [workspacePath, expectedName] of Object.entries(workspacePackagePaths)) {
    const manifest = readJson(path.join(repoRoot, workspacePath, 'package.json'));

    assert.equal(manifest.name, expectedName);
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.license, 'MIT');
    assert.deepEqual(manifest.engines, { node: '>=20' });
  }

  const cliPackage = readJson(path.join(repoRoot, 'packages/cli/package.json'));
  assert.deepEqual(cliPackage.bin, { vlp: 'bin/vlp.mjs' });
  assert.equal(readFileSync(path.join(repoRoot, 'packages/cli/bin/vlp.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n'), true);
  assert.deepEqual(cliPackage.files, ['bin', 'scripts', 'src']);
  assert.deepEqual(cliPackage.exports, {
    '.': './src/index.mjs',
    './session-store': './src/session-store.mjs',
    './web-server': './src/web-server.mjs',
    './package.json': './package.json',
  });
});

test('workspace packages do not contain undeclared internal imports', () => {
  const packageManifests = new Map(
    Object.entries(workspacePackagePaths).map(([workspacePath, packageName]) => [
      packageName,
      readJson(path.join(repoRoot, workspacePath, 'package.json')),
    ]),
  );

  const declaredInternalDependencies = new Map(
    [...packageManifests.entries()].map(([packageName, manifest]) => {
      const dependencySections = [
        manifest.dependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
      ].filter(Boolean);

      return [
        packageName,
        new Set(
          dependencySections.flatMap((section) => Object.keys(section)).filter((depName) =>
            packageManifests.has(depName),
          ),
        ),
      ];
    }),
  );

  for (const [workspacePath, packageName] of Object.entries(workspacePackagePaths)) {
    const packageRoot = path.join(repoRoot, workspacePath);
    const files = walkFiles(packageRoot).filter((filePath) => {
      if (path.basename(filePath) === 'package.json') {
        return false;
      }

      const relativePath = path.relative(packageRoot, filePath);
      const [topLevelDir] = relativePath.split(path.sep);
      if (!topLevelDir || !['bin', 'src'].includes(topLevelDir)) {
        return false;
      }

      return sourceExtensions.has(path.extname(filePath));
    });

    for (const filePath of files) {
      const sourceText = readFileSync(filePath, 'utf8');
      const imports = findWorkspaceImports(sourceText);

      for (const specifier of imports) {
        assert(
          declaredInternalDependencies.get(packageName)?.has(specifier),
          `${path.relative(repoRoot, filePath)} imports ${specifier} without declaring it`,
        );
      }
    }
  }
});

test('workspace fixtures do not contain runnable Node helper files that the test runner can auto-discover', () => {
  const fixtureFiles = walkFiles(path.join(repoRoot, 'packages')).filter((filePath) => {
    const relative = path.relative(repoRoot, filePath).split(path.sep).join('/');
    return relative.includes('/test/fixtures/') && ['.js', '.mjs', '.cjs'].includes(path.extname(filePath));
  });

  assert.deepEqual(fixtureFiles, []);
});

test('CI workflows pin the workspace floor, enforce the release tag/version contract, and cover the release smoke matrix', () => {
  const testWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8');
  assert.match(testWorkflow, /node-version:\s*\[20, 22\]/);
  assert.match(testWorkflow, /macos-latest/);
  assert.match(testWorkflow, /ubuntu-latest/);

  const releaseWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.match(releaseWorkflow, /ubuntu-latest/);
  assert.match(releaseWorkflow, /ubuntu-24\.04-arm/);
  assert.match(releaseWorkflow, /macos-13/);
  assert.match(releaseWorkflow, /macos-latest/);
  assert.match(releaseWorkflow, /Verify tag matches package version/);
  assert.match(releaseWorkflow, /GITHUB_REF_NAME/);
  assert.match(releaseWorkflow, /does not match package\.json version/);
  assert.match(releaseWorkflow, /build-node-bundle/);
  assert.match(releaseWorkflow, /generate-checksums/);
  assert.match(releaseWorkflow, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(releaseWorkflow, /needs:\s*\[build, smoke\]/);
  assert.match(releaseWorkflow, /if:\s*github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release@v2/);
  assert.match(releaseWorkflow, /tag_name:\s*v\$\{\{ steps\.version\.outputs\.version \}\}/);
  assert.match(releaseWorkflow, /files:\s*dist\/v\$\{\{ steps\.version\.outputs\.version \}\}\/\*/);
  assert.doesNotMatch(releaseWorkflow, /secrets\./);
  assert.doesNotMatch(releaseWorkflow, /pull_request:/);
});

for (const workspacePath of Object.keys(workspacePackagePaths)) {
  test(`workspace manifest exists: ${workspacePath}`, () => {
    const manifestPath = path.join(repoRoot, workspacePath, 'package.json');
    assert.equal(statSync(manifestPath).isFile(), true);
  });
}

test('packed workspace installs the UI asset-root API and lets the CLI web server serve installed assets', async () => {
  const packDir = await mkdtemp(path.join(tmpdir(), 'vlp-pack-'));
  await exec('npm', ['pack', '--workspaces', '--pack-destination', packDir], {
    cwd: repoRoot,
    maxBuffer: commandBuffer,
  });

  const cliTarball = path.join(packDir, 'arexgill-vlp-cli-0.1.0.tgz');
  const coreTarball = path.join(packDir, 'arexgill-vlp-core-0.1.0.tgz');
  const uiTarball = path.join(packDir, 'arexgill-vlp-ui-0.1.0.tgz');

  const cliManifest = await readTarJson(cliTarball, 'package/package.json');
  assert.deepEqual(cliManifest.dependencies, {
    '@arexgill/vlp-core': '0.1.0',
    '@arexgill/vlp-ui': '0.1.0',
  });
  assert.deepEqual(cliManifest.files, ['bin', 'scripts', 'src']);
  assert.deepEqual(cliManifest.exports, {
    '.': './src/index.mjs',
    './session-store': './src/session-store.mjs',
    './web-server': './src/web-server.mjs',
    './package.json': './package.json',
  });

  const coreManifest = await readTarJson(coreTarball, 'package/package.json');
  assert.deepEqual(coreManifest.dependencies, {
    '@babel/parser': '^7.28.5',
    picomatch: '^4.0.3',
  });

  const coreEntries = await listTarEntries(coreTarball);
  assert(coreEntries.includes('package/scripts/extract-python.py'), 'Missing packaged Python helper');

  const uiManifest = await readTarJson(uiTarball, 'package/package.json');
  assert.equal(uiManifest.main, './src/index.mjs');
  assert.deepEqual(uiManifest.exports, { '.': './src/index.mjs' });
  assert.deepEqual(uiManifest.files, ['src', 'public']);

  const uiEntries = await listTarEntries(uiTarball);
  [
    'package/src/index.mjs',
    'package/public/index.html',
    'package/public/styles.css',
    'package/public/app.mjs',
    'package/public/web-app.mjs',
  ].forEach((entry) => {
    assert(uiEntries.includes(entry), `Missing ${entry} in packed UI tarball`);
  });

  const installRoot = await mkdtemp(path.join(tmpdir(), 'vlp-install-layout-'));
  const nodeModulesRoot = path.join(installRoot, 'node_modules');
  const scopeRoot = path.join(nodeModulesRoot, '@arexgill');
  await extractTarball(coreTarball, path.join(scopeRoot, 'vlp-core'));
  await extractTarball(uiTarball, path.join(scopeRoot, 'vlp-ui'));
  await extractTarball(cliTarball, path.join(scopeRoot, 'vlp-cli'));
  await cp(path.join(repoRoot, 'node_modules', '@babel'), path.join(nodeModulesRoot, '@babel'), { recursive: true });
  await cp(path.join(repoRoot, 'node_modules', 'picomatch'), path.join(nodeModulesRoot, 'picomatch'), { recursive: true });

  const checkPath = path.join(installRoot, 'check-install-layout.mjs');
  await writeFile(checkPath, `
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createReviewSession } from '@arexgill/vlp-core';
import { resolveUiAssetRoot } from '@arexgill/vlp-ui';
import { saveSession } from '@arexgill/vlp-cli/session-store';
import { startWebReviewServer } from '@arexgill/vlp-cli/web-server';

const assetRoot = resolveUiAssetRoot();
await access(path.join(assetRoot, 'index.html'));
await access(path.join(assetRoot, 'styles.css'));
await access(path.join(assetRoot, 'app.mjs'));
await access(path.join(assetRoot, 'web-app.mjs'));

await assert.rejects(import('@arexgill/vlp-cli/src/run.mjs'), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|Package subpath/);
await assert.rejects(import('@arexgill/vlp-core/src/index.mjs'), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|Package subpath/);
await assert.rejects(import('@arexgill/vlp-ui/public/app.mjs'), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|Package subpath/);

const root = await mkdtemp(path.join(tmpdir(), 'vlp-installed-web-'));
await mkdir(path.join(root, '.git'));
const session = createReviewSession({
  contract: {
    id: 'search-scope',
    slug: 'search-scope',
    status: 'confirmed',
    path: '.vlp/contracts/search-scope.md',
    content: '# Search Scope',
  },
  questions: [],
}, { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
await saveSession(root, session);
const server = await startWebReviewServer({ root, sessionId: session.sessionId });
try {
  const response = await fetch(server.url + '/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Local only/i);
} finally {
  await server.close();
}
console.log('ok');
`, 'utf8');

  const { stdout } = await exec(process.execPath, [checkPath], {
    cwd: installRoot,
    maxBuffer: commandBuffer,
  });
  assert.match(stdout, /ok/);
});
