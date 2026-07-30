import { createHash } from 'node:crypto';

function cleanText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

function normalizePath(value) {
  const source = cleanText(value).replaceAll('\\', '/');
  if (!source) return '';
  const normalized = `/${source.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '') || '/';
}

function normalizeMethods(methods) {
  if (!Array.isArray(methods)) return [];
  return [...new Set(methods.map((method) => cleanText(method).toUpperCase()).filter(Boolean))].sort();
}

function normalizeStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))].sort();
}

function normalizeStatusCode(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function normalizeModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeFastApiContracts(routes = []) {
  const normalized = [];
  const seen = new Set();

  for (const route of routes || []) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;

    const path = normalizePath(route.path);
    const methods = normalizeMethods(route.methods);
    if (!path || methods.length === 0) continue;

    const file = cleanText(route.file);
    const lineStart = Number.isInteger(route.lineStart) && route.lineStart > 0 ? route.lineStart : 1;
    const key = [file, lineStart, path, methods.join(','), cleanText(route.requestModel), cleanText(route.responseModel), normalizeStatusCode(route.statusCode) ?? ''].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      file,
      lineStart,
      path,
      methods,
      dependencies: normalizeStrings(route.dependencies),
      requestModel: normalizeModel(route.requestModel),
      responseModel: normalizeModel(route.responseModel),
      statusCode: normalizeStatusCode(route.statusCode),
    });
  }

  normalized.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.lineStart - right.lineStart
    || left.path.localeCompare(right.path)
    || left.methods.join(',').localeCompare(right.methods.join(','))
  );

  return normalized;
}

function strippedPath(pathValue) {
  return normalizePath(pathValue).replace(/\{[^/}]+\}/g, '{}');
}

function makeId(question) {
  const trace = [
    question.type,
    question.promptEvidence || JSON.stringify(question.sourceEvidence || {}),
    (question.docUnitIds || []).join(','),
    JSON.stringify(question.runtimeEvidence || {}),
    question.ask,
  ].join('\0');
  return `q-${createHash('sha1').update(trace).digest('hex').slice(0, 12)}`;
}

function finalize(question) {
  return { id: makeId(question), ...question };
}

function diagnosticMessage(diagnostic) {
  if (!diagnostic) return '';
  if (typeof diagnostic === 'string') return cleanText(diagnostic);
  if (typeof diagnostic.message === 'string' && diagnostic.message.trim()) return cleanText(diagnostic.message);
  if (typeof diagnostic.error === 'string' && diagnostic.error.trim()) return cleanText(diagnostic.error);
  return 'FastAPI runtime unavailable';
}

function responseSchemaRef(response) {
  if (!response || typeof response !== 'object') return '';
  if (typeof response.schemaRef === 'string' && response.schemaRef.trim()) return response.schemaRef.trim();

  const content = response.content;
  const jsonContent = content && typeof content === 'object' ? content['application/json'] : null;
  const schema = jsonContent && typeof jsonContent === 'object' ? jsonContent.schema : null;
  if (!schema || typeof schema !== 'object') return '';

  if (typeof schema.$ref === 'string' && schema.$ref.trim()) return schema.$ref.trim();
  if (schema.items && typeof schema.items === 'object' && typeof schema.items.$ref === 'string' && schema.items.$ref.trim()) {
    return schema.items.$ref.trim();
  }
  return '';
}

const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

function responseForStatus(operation, status) {
  const responses = operation && typeof operation === 'object' ? operation.responses : null;
  if (!responses || typeof responses !== 'object') return null;
  return responses[String(status)] || null;
}

function methodCandidates(routeMethods) {
  return routeMethods.map((method) => method.toLowerCase());
}

function openApiMethods(operation) {
  return Object.keys(operation || {}).filter((key) => OPENAPI_METHODS.has(key)).sort();
}

function exactOrDriftPath(openapiPaths, targetPath) {
  const normalizedTarget = normalizePath(targetPath);
  if (openapiPaths[normalizedTarget] && typeof openapiPaths[normalizedTarget] === 'object') {
    return { kind: 'exact', path: normalizedTarget, operation: openapiPaths[normalizedTarget] };
  }

  const targetShape = strippedPath(normalizedTarget);
  for (const candidatePath of Object.keys(openapiPaths).sort()) {
    if (strippedPath(candidatePath) === targetShape) {
      return { kind: 'path-drift', path: candidatePath, operation: openapiPaths[candidatePath] };
    }
  }

  return null;
}

function compareRoute(route, openapiPaths) {
  const match = exactOrDriftPath(openapiPaths, route.path);
  if (!match) {
    return [finalize({
      type: 'missing-route',
      severity: 'high',
      title: `Missing route: ${route.path}`,
      ask: `Static analysis found ${route.path}, but the runtime schema does not expose it. Is the route failing to register?`,
      reason: 'The static FastAPI route is absent from the runtime OpenAPI schema.',
      promptEvidence: route.path,
      sourceEvidence: { file: route.file, lineStart: route.lineStart, target: route.path },
      runtimeEvidence: { type: 'openapi-missing', path: route.path, methods: route.methods },
      docUnitIds: [],
    })];
  }

  if (match.kind === 'path-drift') {
    return [finalize({
      type: 'path-drift',
      severity: 'high',
      title: `Path drift: ${route.path}`,
      ask: `Static analysis found ${route.path}, but the runtime schema exposes ${match.path}. Which path is correct?`,
      reason: 'The runtime OpenAPI path differs only by path-variable naming or router composition.',
      promptEvidence: route.path,
      sourceEvidence: { file: route.file, lineStart: route.lineStart, target: route.path },
      runtimeEvidence: { type: 'openapi-drift', expected: route.path, actual: match.path },
      docUnitIds: [],
    })];
  }

  const questions = [];
  const operation = match.operation || {};

  for (const method of methodCandidates(route.methods)) {
    const operationEntry = operation[method];
    if (!operationEntry || typeof operationEntry !== 'object') {
      questions.push(finalize({
        type: 'method-drift',
        severity: 'high',
        title: `Method drift: ${route.path}`,
        ask: `Static analysis found ${method.toUpperCase()} ${route.path}, but the runtime schema exposes different methods. Which method is correct?`,
        reason: 'The runtime OpenAPI methods do not match the static FastAPI decorator.',
        promptEvidence: `${route.path}:${method}`,
        sourceEvidence: { file: route.file, lineStart: route.lineStart, target: route.path },
        runtimeEvidence: { type: 'openapi-drift', path: route.path, methods: openApiMethods(operation) },
        docUnitIds: [],
      }));
      continue;
    }

    const expectedStatus = route.statusCode ?? 200;
    const response = responseForStatus(operationEntry, expectedStatus);
    if (!response) {
      questions.push(finalize({
        type: 'schema-drift',
        severity: 'medium',
        title: `Schema drift: ${route.path}`,
        ask: `The runtime schema for ${method.toUpperCase()} ${route.path} does not expose status ${expectedStatus}. Which response is correct?`,
        reason: 'The runtime OpenAPI response status differs from the static FastAPI decorator.',
        promptEvidence: `${route.path}:${method}:${expectedStatus}`,
        sourceEvidence: { file: route.file, lineStart: route.lineStart, target: route.path },
        runtimeEvidence: { type: 'openapi-drift', path: route.path, method, status: expectedStatus },
        docUnitIds: [],
      }));
      continue;
    }

    if (route.responseModel) {
      const schemaRef = responseSchemaRef(response);
      if (!schemaRef || !schemaRef.endsWith(`/${route.responseModel}`)) {
        questions.push(finalize({
          type: 'schema-drift',
          severity: 'medium',
          title: `Schema drift: ${route.path}`,
          ask: `The runtime schema for ${method.toUpperCase()} ${route.path} does not match response model ${route.responseModel}. Which model is correct?`,
          reason: 'The runtime OpenAPI response model differs from the static FastAPI decorator.',
          promptEvidence: `${route.path}:${method}:${route.responseModel}`,
          sourceEvidence: { file: route.file, lineStart: route.lineStart, target: route.path },
          runtimeEvidence: { type: 'openapi-drift', path: route.path, method, responseModel: route.responseModel },
          docUnitIds: [],
        }));
      }
    }
  }

  return questions;
}

export function compareFastApiContracts({ prompt, staticContracts = [], openapi = null, diagnostic = null } = {}) {
  const contracts = normalizeFastApiContracts(staticContracts);
  const questions = [];
  const paths = openapi && openapi.paths && typeof openapi.paths === 'object' ? openapi.paths : null;

  if (diagnostic) {
    const message = diagnosticMessage(diagnostic);
    questions.push(finalize({
      type: 'runtime-diagnostic',
      severity: 'high',
      title: 'FastAPI runtime verification failed',
      ask: 'The FastAPI runtime could not be collected safely. Should the implementation fix the runtime issue before review?',
      reason: message || 'The runtime sandbox failed before producing OpenAPI.',
      promptEvidence: message,
      sourceEvidence: { file: 'fastapi runtime', lineStart: 0 },
      runtimeEvidence: { type: 'diagnostic', message },
      docUnitIds: [],
    }));
  }

  if (paths) {
    for (const route of contracts) {
      questions.push(...compareRoute(route, paths));
    }
  }

  return questions;
}
