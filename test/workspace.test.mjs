import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspacePackagePaths = {
  'packages/core': '@arexgill/vlp-core',
  'packages/cli': '@arexgill/vlp-cli',
  'packages/ui': '@arexgill/vlp-ui',
};

const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

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

for (const workspacePath of Object.keys(workspacePackagePaths)) {
  test(`workspace manifest exists: ${workspacePath}`, () => {
    const manifestPath = path.join(repoRoot, workspacePath, 'package.json');
    assert.equal(statSync(manifestPath).isFile(), true);
  });
}
