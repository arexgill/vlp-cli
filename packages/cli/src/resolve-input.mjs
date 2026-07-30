import { createReadStream } from 'node:fs';
import path from 'node:path';

import { CORE_LIMITS } from '@arexgill/vlp-core';

export const DECISION_ENVELOPE_LIMIT_BYTES = CORE_LIMITS.decisionEnvelopeBytes;

function oversizeError(limitBytes = DECISION_ENVELOPE_LIMIT_BYTES) {
  const error = new Error(`Decision envelope exceeds ${limitBytes} bytes`);
  error.code = 'ERR_VLP_DECISION_ENVELOPE_TOO_LARGE';
  return error;
}

function invalidJsonError() {
  const error = new Error('Decision envelope must be valid JSON');
  error.code = 'ERR_VLP_DECISION_ENVELOPE_JSON';
  return error;
}

async function readBoundedText(stream, limitBytes = DECISION_ENVELOPE_LIMIT_BYTES) {
  const chunks = [];
  let bytes = 0;
  let rejected = null;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > limitBytes) {
        rejected = oversizeError(limitBytes);
        if (typeof stream.destroy === 'function' && !stream.destroyed) {
          stream.destroy(rejected);
        }
        break;
      }
      chunks.push(buffer);
    }
  } finally {
    if (typeof stream.destroy === 'function' && !stream.destroyed) {
      stream.destroy();
    }
  }

  if (rejected) {
    throw rejected;
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readBoundedFile(filePath, limitBytes = DECISION_ENVELOPE_LIMIT_BYTES) {
  const stream = createReadStream(filePath);
  return readBoundedText(stream, limitBytes);
}

export async function readDecisionEnvelopeInput(cwd, inputPath, stdin, { limitBytes = DECISION_ENVELOPE_LIMIT_BYTES } = {}) {
  const content = inputPath === '-'
    ? await readBoundedText(stdin, limitBytes)
    : await readBoundedFile(path.join(cwd, inputPath), limitBytes);

  try {
    return JSON.parse(content);
  } catch {
    throw invalidJsonError();
  }
}
