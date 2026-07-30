import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FASTAPI_BUILD_TIMEOUT_MS = 600000;
export const FASTAPI_RUNTIME_TIMEOUT_MS = 30000;
export const FASTAPI_CLEANUP_TIMEOUT_MS = 5000;
const MAX_DOCKER_OUTPUT_BYTES = 8 * 1024 * 1024;
const PYTHON_IMAGE = 'python:3.11-slim';

function createAbortError(message = 'The operation was aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function redactedDiagnostic(type, message) {
  return { type, message };
}

function resolveCollectOpenApiScriptPath() {
  return path.resolve(__dirname, '../scripts/collect-openapi.py');
}

function defaultRunDocker(args, { signal, input } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const child = spawn('docker', args, { signal });

    const finish = (callback) => {
      if (overflow) return;
      callback();
    };

    const onData = (chunk, isStdout) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (isStdout) {
        stdoutBytes += buffer.length;
        if (stdoutBytes > MAX_DOCKER_OUTPUT_BYTES) {
          overflow = true;
          child.kill('SIGKILL');
          resolve({ stdout: '', stderr: '', exitCode: 1, overflow: true });
          return;
        }
        stdout += buffer.toString('utf8');
      } else {
        stderrBytes += buffer.length;
        if (stderrBytes > MAX_DOCKER_OUTPUT_BYTES) {
          overflow = true;
          child.kill('SIGKILL');
          resolve({ stdout: '', stderr: '', exitCode: 1, overflow: true });
          return;
        }
        stderr += buffer.toString('utf8');
      }
    };

    child.stdout.on('data', (chunk) => onData(chunk, true));
    child.stderr.on('data', (chunk) => onData(chunk, false));

    child.on('close', (code) => {
      finish(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
    child.on('error', (error) => reject(error));

    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function withTimeout(runDocker, args, { input, timeoutMs }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const timeoutPromise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
    });
    const runPromise = Promise.resolve().then(() => runDocker(args, { signal: controller.signal, input }));
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildDockerfile(requirements) {
  const encodedRequirements = Buffer.from(requirements, 'utf8').toString('base64');
  return [
    `FROM ${PYTHON_IMAGE}`,
    'WORKDIR /deps',
    `RUN echo "${encodedRequirements}" | base64 -d > requirements.txt`,
    'RUN pip install --no-cache-dir -r requirements.txt -t /deps',
    '',
  ].join('\n');
}

function sanitizeOpenApi(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.paths || typeof parsed.paths !== 'object') return null;

  const sanitized = { paths: {} };
  for (const [routePath, pathObject] of Object.entries(parsed.paths)) {
    if (!pathObject || typeof pathObject !== 'object') continue;
    sanitized.paths[routePath] = {};

    for (const [method, operation] of Object.entries(pathObject)) {
      if (!operation || typeof operation !== 'object') continue;
      const sanitizedOperation = { responses: {} };
      const responses = operation.responses;
      if (responses && typeof responses === 'object') {
        for (const [status, response] of Object.entries(responses)) {
          let schemaRef = '';
          const content = response && typeof response === 'object' ? response.content : null;
          const jsonContent = content && typeof content === 'object' ? content['application/json'] : null;
          const schema = jsonContent && typeof jsonContent === 'object' ? jsonContent.schema : null;
          if (response && typeof response === 'object' && typeof response.schemaRef === 'string') {
            schemaRef = response.schemaRef;
          } else if (schema && typeof schema === 'object') {
            if (typeof schema.$ref === 'string') {
              schemaRef = schema.$ref;
            } else if (schema.items && typeof schema.items === 'object' && typeof schema.items.$ref === 'string') {
              schemaRef = schema.items.$ref;
            }
          }

          sanitizedOperation.responses[status] = schemaRef ? { schemaRef } : {};
        }
      }

      sanitized.paths[routePath][method] = sanitizedOperation;
    }
  }

  return sanitized;
}

function parseOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { openapi: null, error: 'invalid_json' };
  }

  const openapi = sanitizeOpenApi(parsed);
  if (!openapi) {
    return { openapi: null, error: 'invalid_openapi' };
  }

  return { openapi, error: null };
}

async function cleanupImage(runDocker, imageId) {
  if (!imageId) return;
  try {
    await withTimeout(runDocker, ['rmi', '-f', imageId], { timeoutMs: FASTAPI_CLEANUP_TIMEOUT_MS });
  } catch {
    // Ignore cleanup errors.
  }
}

export async function collectFastApiOpenApi({ root, appTarget, runDocker = defaultRunDocker } = {}) {
  const rootPath = path.resolve(String(root ?? '.'));
  const requirementsPath = path.join(rootPath, 'requirements.txt');

  if (typeof appTarget !== 'string' || !appTarget.trim()) {
    return { openapi: null, diagnostic: redactedDiagnostic('missing_app_target', 'Missing FastAPI app target') };
  }

  let requirements;
  try {
    requirements = await readFile(requirementsPath, 'utf8');
  } catch {
    return { openapi: null, diagnostic: redactedDiagnostic('missing_manifest', 'No requirements.txt found') };
  }

  const buildResult = await withTimeout(runDocker, ['build', '-q', '-'], {
    input: buildDockerfile(requirements),
    timeoutMs: FASTAPI_BUILD_TIMEOUT_MS,
  }).catch((error) => {
    if (error.name === 'AbortError') {
      return { stdout: '', stderr: '', exitCode: 1, timeout: true };
    }
    if (error.code === 'ENOENT') {
      return { stdout: '', stderr: '', exitCode: 1, missingDocker: true };
    }
    return { stdout: '', stderr: '', exitCode: 1, error };
  });

  if (buildResult.timeout) {
    return { openapi: null, diagnostic: redactedDiagnostic('timeout', 'Docker build timed out') };
  }
  if (buildResult.missingDocker) {
    return { openapi: null, diagnostic: redactedDiagnostic('docker_absence', 'Docker is not installed or not in PATH') };
  }
  if (buildResult.overflow) {
    return { openapi: null, diagnostic: redactedDiagnostic('oversized_output', 'Build output exceeded size limit') };
  }
  if (!buildResult || buildResult.exitCode !== 0) {
    return { openapi: null, diagnostic: redactedDiagnostic('build_error', 'Sandbox build rejected dependencies') };
  }

  const imageId = String(buildResult.stdout ?? '').trim();
  if (!imageId) {
    return { openapi: null, diagnostic: redactedDiagnostic('build_error', 'Sandbox build rejected dependencies') };
  }

  const scriptPath = resolveCollectOpenApiScriptPath();
  const runArgs = [
    'run',
    '--network=none',
    '--read-only',
    '--tmpfs=/tmp',
    '--cpus=1',
    '--memory=512m',
    '--pids-limit=50',
    '--rm',
    '-v', `${rootPath}:/app:ro`,
    '-v', `${scriptPath}:/scripts/collect-openapi.py:ro`,
    '-w', '/app',
    '-e', 'PYTHONPATH=/deps',
    imageId,
    'python', '/scripts/collect-openapi.py', appTarget,
  ];

  let runResult;
  try {
    runResult = await withTimeout(runDocker, runArgs, { timeoutMs: FASTAPI_RUNTIME_TIMEOUT_MS });
  } catch (error) {
    await cleanupImage(runDocker, imageId);
    if (error.name === 'AbortError') {
      return { openapi: null, diagnostic: redactedDiagnostic('timeout', 'Docker runtime timed out') };
    }
    if (error.code === 'ENOENT') {
      return { openapi: null, diagnostic: redactedDiagnostic('docker_absence', 'Docker is not installed or not in PATH') };
    }
    return { openapi: null, diagnostic: redactedDiagnostic('docker_error', 'Docker subprocess failed') };
  }

  await cleanupImage(runDocker, imageId);

  if (runResult && runResult.overflow) {
    return { openapi: null, diagnostic: redactedDiagnostic('oversized_output', 'Output exceeded size limit') };
  }
  if (!runResult || runResult.exitCode !== 0) {
    const exitCode = runResult && Number.isInteger(runResult.exitCode) ? runResult.exitCode : 1;
    return { openapi: null, diagnostic: redactedDiagnostic('docker_error', `Docker process exited with code ${exitCode}`) };
  }

  const parsed = parseOutput(String(runResult.stdout ?? ''));
  if (parsed.error === 'invalid_json') {
    return { openapi: null, diagnostic: redactedDiagnostic('invalid_json', 'Invalid JSON returned from container') };
  }
  if (parsed.error === 'invalid_openapi') {
    return { openapi: null, diagnostic: redactedDiagnostic('invalid_openapi', 'Missing paths object in OpenAPI') };
  }

  return { openapi: parsed.openapi, diagnostic: null };
}
