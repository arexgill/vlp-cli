import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PYTHON_COMMAND = 'python3';
const PYTHON_HELPER_INPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const PYTHON_HELPER_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolvePythonHelperPath() {
  return path.resolve(__dirname, '../scripts/extract-python.py');
}

function safeAnalyzerError(error) {
  if (error?.code === 'ENOENT') {
    return new Error('python3 is required for Python analysis');
  }

  return new Error('Unable to start Python analysis');
}

function normalizeResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Python analyzer returned invalid JSON');
  }

  const units = Array.isArray(payload.units) ? payload.units : [];
  const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  const frameworkHints = payload.frameworkHints && typeof payload.frameworkHints === 'object' && !Array.isArray(payload.frameworkHints)
    ? payload.frameworkHints
    : {};

  return { units, diagnostics, frameworkHints };
}

export async function analyzePythonSources(files, options = {}) {
  const {
    spawnFn = spawn,
    pythonCommand = PYTHON_COMMAND,
    inputLimitBytes = PYTHON_HELPER_INPUT_LIMIT_BYTES,
    outputLimitBytes = PYTHON_HELPER_OUTPUT_LIMIT_BYTES,
  } = options;

  const normalizedFiles = (files || []).map((file) => ({
    path: String(file?.path ?? ''),
    source: String(file?.source ?? ''),
  }));
  const input = JSON.stringify({ files: normalizedFiles });

  if (Buffer.byteLength(input, 'utf8') > inputLimitBytes) {
    throw new Error('Python analyzer input exceeded limit');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawnFn(pythonCommand, [resolvePythonHelperPath()]);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.on('error', (error) => {
      finish(() => reject(safeAnalyzerError(error)));
    });

    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += buffer.length;
      if (stdoutBytes > outputLimitBytes) {
        child.kill?.();
        finish(() => reject(new Error('Python analyzer output exceeded limit')));
        return;
      }
      stdout += buffer.toString('utf8');
    });

    child.stderr?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stderrBytes += buffer.length;
      if (stderrBytes > outputLimitBytes) {
        child.kill?.();
        finish(() => reject(new Error('Python analyzer output exceeded limit')));
      }
    });

    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Python analyzer exited with code ${code}`));
          return;
        }

        let payload;
        try {
          payload = JSON.parse(stdout);
        } catch {
          reject(new Error('Python analyzer returned invalid JSON'));
          return;
        }

        try {
          resolve(normalizeResult(payload));
        } catch (error) {
          reject(error);
        }
      });
    });

    child.stdin?.write?.(input);
    child.stdin?.end?.();
  });
}
