import { CORE_LIMITS, DecisionEnvelopeValidationError, normalizeSessionId } from '@monkeypaw/core';
import { resolveUiAssetRoot } from '@monkeypaw/ui';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createJsonEnvelope, reviewContractPayload, reviewQuestionPayloads } from './json-output.mjs';
import { finalizeDecisionSubmission } from './review-artifacts.mjs';
import { loadSession } from './session-store.mjs';

const HOST = '127.0.0.1';
export const BODY_LIMIT_BYTES = CORE_LIMITS.decisionEnvelopeBytes;
const STATIC_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/web-app.mjs', ['web-app.mjs', 'text/javascript; charset=utf-8']],
]);
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function defaultPublicDirectory() {
  return resolveUiAssetRoot();
}

function send(response, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'content-type': contentType,
  });
  response.end(body);
}

function sendJson(response, status, value, extraHeaders) {
  send(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8', extraHeaders);
}

function cloneRecords(records) {
  return Array.isArray(records)
    ? records.map((record) => (record && typeof record === 'object' ? { ...record } : record))
    : [];
}

function createSessionPayload(session) {
  return {
    schemaVersion: 1,
    sessionId: normalizeSessionId(session?.sessionId),
    contract: {
      ...reviewContractPayload(session?.contract),
      content: typeof session?.contract?.content === 'string' ? session.contract.content : '',
    },
    sources: cloneRecords(session?.sources),
    docUnits: cloneRecords(session?.docUnits),
    diagnostics: cloneRecords(session?.diagnostics),
    questions: reviewQuestionPayloads(session),
    meta: session?.meta && typeof session.meta === 'object' ? { ...session.meta } : null,
  };
}

async function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (oversized) {
        reject(new HttpError(413, `Request body exceeds ${BODY_LIMIT_BYTES} bytes`));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
  });
}

async function serveStatic(response, publicDir, pathname, method) {
  const asset = STATIC_ASSETS.get(pathname);
  if (!asset) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
    return;
  }

  const [fileName, contentType] = asset;
  try {
    const contents = await readFile(path.join(publicDir, fileName));
    send(response, 200, method === 'HEAD' ? '' : contents, contentType);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    throw error;
  }
}

async function resolveSessionSubmission(root, sessionId, submitted, artifactIO) {
  const session = await loadSession(root, sessionId);
  return finalizeDecisionSubmission(root, 'resolve', session, submitted, artifactIO);
}

function createWebReviewServer({ root, sessionId, publicDir = defaultPublicDirectory(), onComplete, artifactIO } = {}) {
  const safeSessionId = normalizeSessionId(sessionId);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${HOST}`);

      if (url.pathname === '/api/session') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
          return;
        }

        const session = await loadSession(root, safeSessionId);
        sendJson(response, 200, createSessionPayload(session));
        return;
      }

      if (url.pathname === '/api/resolve') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
          return;
        }
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Content-Type must be application/json');
        }

        const payload = await readJson(request);
        let result;
        try {
          result = await resolveSessionSubmission(root, safeSessionId, payload, artifactIO);
        } catch (error) {
          if (error instanceof DecisionEnvelopeValidationError) {
            throw new HttpError(400, 'Invalid decision submission');
          }
          throw error;
        }
        if (result.exitCode !== 3 && typeof onComplete === 'function') {
          onComplete(result);
        }
        sendJson(response, 200, { envelope: result.envelope, markdown: result.markdown });
        return;
      }

      await serveStatic(response, publicDir, url.pathname, request.method || 'GET');
    } catch (error) {
      const status = error?.status || 500;
      const message = status === 500 ? 'Internal server error' : error.message;
      if (!response.headersSent) {
        sendJson(response, status, { error: message });
      } else {
        response.end();
      }
    }
  });
}

function listen(server, { host = HOST, port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startWebReviewServer({ root, sessionId, publicDir, artifactIO } = {}) {
  let completed = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  const server = createWebReviewServer({
    root,
    sessionId,
    publicDir,
    artifactIO,
    onComplete(result) {
      if (!completed) {
        completed = true;
        resolveCompletion(result);
      }
    },
  });

  const address = await listen(server, { host: HOST, port: 0 });

  return {
    ...address,
    async waitForCompletion() {
      return completion;
    },
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
