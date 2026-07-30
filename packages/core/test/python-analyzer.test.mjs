import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzePythonSources, resolvePythonHelperPath } from '../src/python-analyzer.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python');

function readFixture(name) {
  return readFileSync(path.join(fixtureRoot, name), 'utf8');
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('analyzePythonSources invokes only the resolved packaged helper with source via stdin', async () => {
  let spawnArgs = null;
  let stdinData = '';

  const fakeChild = makeFakeChild();
  fakeChild.stdin = {
    write(data) {
      stdinData += data;
    },
    end() {
      fakeChild.stdout.emit('data', JSON.stringify({ units: [], diagnostics: [], frameworkHints: {} }));
      fakeChild.emit('close', 0);
    },
  };

  const fakeSpawn = (command, args) => {
    spawnArgs = { command, args };
    return fakeChild;
  };

  const files = [{ path: 'pkg/example.py', source: 'def example(value: int = 1):\n    return value\n' }];
  await analyzePythonSources(files, { spawnFn: fakeSpawn });

  assert.equal(spawnArgs.command, 'python3');
  assert.deepEqual(spawnArgs.args, [resolvePythonHelperPath()]);
  assert.deepEqual(JSON.parse(stdinData), { files });
});

test('analyzePythonSources maps helper failures to safe errors', async () => {
  const files = [{ path: 'pkg/example.py', source: 'def example():\n    return 1\n' }];

  const missingPythonChild = makeFakeChild();
  missingPythonChild.stdin = { write() {}, end() {} };
  const missingPythonSpawn = () => {
    queueMicrotask(() => {
      missingPythonChild.emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }));
    });
    return missingPythonChild;
  };

  await assert.rejects(
    analyzePythonSources(files, { spawnFn: missingPythonSpawn }),
    /python3 is required for Python analysis/i,
  );

  const invalidJsonChild = makeFakeChild();
  invalidJsonChild.stdin = {
    write() {},
    end() {
      invalidJsonChild.stdout.emit('data', '{not json');
      invalidJsonChild.emit('close', 0);
    },
  };

  await assert.rejects(
    analyzePythonSources(files, { spawnFn: () => invalidJsonChild }),
    /returned invalid json/i,
  );
});

test('analyzePythonSources extracts general python units, preserves diagnostics, and never executes fixtures', async () => {
  const result = await analyzePythonSources([
    { path: 'analytics.py', source: readFixture('analytics.py') },
    { path: 'poison.py', source: readFixture('poison.py') },
    { path: 'broken.py', source: readFixture('broken.py') },
  ]);

  assert.deepEqual(result.frameworkHints, {});
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].file, 'broken.py');
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'module'), true);
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'import'), true);
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'class' && unit.symbol === 'Service'), true);
  assert.equal(
    result.units.some(
      (unit) => unit.file === 'analytics.py' && unit.kind === 'decorator' && unit.code === "@audited('reports')",
    ),
    true,
  );
  assert.equal(
    result.units.some(
      (unit) => unit.file === 'analytics.py' && unit.kind === 'signature' && unit.symbol === 'stream_items' && unit.code.startsWith('async def stream_items'),
    ),
    true,
  );
  assert.equal(
    result.units.some(
      (unit) => unit.file === 'analytics.py' && unit.kind === 'signature' && unit.symbol === 'summarize' && unit.code.includes('enabled: bool = True'),
    ),
    true,
  );
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'condition'), true);
  assert.equal(
    result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'call' && unit.code === 'helper(name)'),
    true,
  );
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'return'), true);
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'yield'), true);
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'raise'), true);
  assert.equal(result.units.some((unit) => unit.file === 'analytics.py' && unit.kind === 'catch'), true);
  assert.equal(result.units.some((unit) => unit.file === 'poison.py' && unit.kind === 'raise'), true);
  assert.equal(result.units.every((unit) => unit.lineStart >= 1 && unit.id.startsWith('doc-')), true);
});

test('extract-python.py adheres to strict static safety rules', () => {
  const helperPath = resolvePythonHelperPath();
  const source = readFileSync(helperPath, 'utf8');
  const astCheckCode = `
import ast
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    source = handle.read()

tree = ast.parse(source)
imports = []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append(f"import {alias.name}")
    elif isinstance(node, ast.ImportFrom):
        imports.append(f"from {node.module or ''}")

print(json.dumps(sorted(set(imports))))
`;

  const astResult = spawnSync('python3', ['-c', astCheckCode, helperPath], { encoding: 'utf8' });
  assert.equal(astResult.status, 0, astResult.stderr);
  assert.deepEqual(JSON.parse(astResult.stdout), ['import ast', 'import json', 'import sys']);

  const forbiddenPatterns = [
    /\b__import__\b/,
    /\bimportlib\b/,
    /\bexec\b/,
    /\beval\b/,
    /\bcompile\b/,
    /\bsubprocess\b/,
    /\bos\b/,
    /\bpathlib\b/,
    /\bshutil\b/,
    /\bsocket\b/,
    /\burllib\b/,
    /\bhttp\b/,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(source, pattern);
  }
});
