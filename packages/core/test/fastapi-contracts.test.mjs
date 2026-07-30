import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareFastApiContracts } from '../src/fastapi-contracts.mjs';
import { reviewContract } from '../src/review-contract.mjs';
import { analyzePythonSources } from '../src/python-analyzer.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python');

async function readFixture(name) {
  return readFile(path.join(fixtureRoot, name), 'utf8');
}

test('analyzePythonSources extracts normalized fastapi route contracts and survives router cycles', async () => {
  const result = await analyzePythonSources([
    { path: 'api.py', source: await readFixture('fastapi_app.py') },
  ]);

  assert.deepEqual(result.diagnostics, []);
  assert.equal(Array.isArray(result.frameworkHints.fastapiRoutes), true);
  assert.equal(result.frameworkHints.fastapiRoutes.length, 1);

  const route = result.frameworkHints.fastapiRoutes[0];
  assert.equal(route.file, 'api.py');
  assert.equal(route.path, '/root/a/to_b/b/items/{item_id}');
  assert.deepEqual(route.methods, ['GET', 'POST']);
  assert.deepEqual(route.dependencies, ['load_user']);
  assert.equal(route.requestModel, 'Item');
  assert.equal(route.responseModel, 'Item');
  assert.equal(route.statusCode, 201);
  assert.equal(route.lineStart >= 1, true);
});

test('compareFastApiContracts reports method, path, schema, missing-route, and runtime-diagnostic drift', () => {
  const staticContracts = [
    {
      file: 'main.py',
      lineStart: 10,
      path: '/items/{item_id}',
      methods: ['GET'],
      statusCode: 200,
      responseModel: 'Item',
    },
  ];

  const methodDrift = compareFastApiContracts({
    staticContracts,
    openapi: {
      paths: {
        '/items/{item_id}': {
          post: { responses: {} },
        },
      },
    },
  });
  assert.equal(methodDrift.length, 1);
  assert.equal(methodDrift[0].type, 'method-drift');
  assert.deepEqual(methodDrift[0].sourceEvidence, { file: 'main.py', lineStart: 10, target: '/items/{item_id}' });
  assert.equal(methodDrift[0].runtimeEvidence.type, 'openapi-drift');

  const pathDrift = compareFastApiContracts({
    staticContracts,
    openapi: {
      paths: {
        '/items/{id}': {
          get: { responses: {} },
        },
      },
    },
  });
  assert.equal(pathDrift.length, 1);
  assert.equal(pathDrift[0].type, 'path-drift');
  assert.equal(pathDrift[0].runtimeEvidence.actual, '/items/{id}');

  const schemaDrift = compareFastApiContracts({
    staticContracts,
    openapi: {
      paths: {
        '/items/{item_id}': {
          get: {
            responses: {
              '201': { schemaRef: '#/components/schemas/Other' },
            },
          },
        },
      },
    },
  });
  assert.equal(schemaDrift.length, 1);
  assert.equal(schemaDrift[0].type, 'schema-drift');

  const missingRoute = compareFastApiContracts({
    staticContracts: [
      {
        file: 'main.py',
        lineStart: 20,
        path: '/users',
        methods: ['GET'],
      },
    ],
    openapi: {
      paths: {
        '/items': { get: { responses: {} } },
      },
    },
  });
  assert.equal(missingRoute.length, 1);
  assert.equal(missingRoute[0].type, 'missing-route');

  const runtimeDiagnostic = compareFastApiContracts({
    staticContracts: [],
    diagnostic: { type: 'timeout', message: 'Sandbox runtime timed out safely' },
  });
  assert.equal(runtimeDiagnostic.length, 1);
  assert.equal(runtimeDiagnostic[0].type, 'runtime-diagnostic');
  assert.equal(runtimeDiagnostic[0].runtimeEvidence.message, 'Sandbox runtime timed out safely');
});

test('reviewContract injects fastapi runtime diagnostics without losing generic Python analysis', async () => {
  const result = await reviewContract({
    contract: { text: 'Review the API.' },
    sources: [{ path: 'api.py', language: 'python', content: await readFixture('fastapi_app.py') }],
    runtimeEvidence: { diagnostic: { type: 'docker_error', message: 'Sandbox runtime failed safely' } },
  });

  assert.equal(result.docUnits.some((unit) => unit.file === 'api.py'), true);
  assert.equal(result.questions.some((question) => question.type === 'runtime-diagnostic'), true);
});
