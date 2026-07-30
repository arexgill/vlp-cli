import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchSessionEnvelope, renderQuestionCard, submitDecisionEnvelope } from '../public/web-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedSessionId = 'session-v1-123e4567e89b12d3a456426614174000';

async function publicFiles() {
  const [html, css, app, web] = await Promise.all([
    readFile(path.join(root, 'public', 'index.html'), 'utf8'),
    readFile(path.join(root, 'public', 'styles.css'), 'utf8'),
    readFile(path.join(root, 'public', 'app.mjs'), 'utf8'),
    readFile(path.join(root, 'public', 'web-app.mjs'), 'utf8'),
  ]);
  return { html, css, app, web };
}

test('browser helpers use injected network dependencies and submit only decision envelopes', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return url.endsWith('/api/session')
          ? { sessionId: fixedSessionId, questions: [] }
          : { envelope: { status: 'completed' }, markdown: '# Report' };
      },
    };
  };

  await fetchSessionEnvelope({ fetchImpl, baseUrl: 'http://127.0.0.1:43210' });
  await submitDecisionEnvelope({
    fetchImpl,
    baseUrl: 'http://127.0.0.1:43210',
    sessionId: fixedSessionId,
    decisions: [{
      questionId: 'q-1',
      decision: 'accept',
      answer: '',
      ask: 'spoofed browser text',
      evidence: [{ file: 'evil.js', text: 'spoofed evidence' }],
    }],
  });

  assert.equal(calls[0].url, 'http://127.0.0.1:43210/api/session');
  assert.equal(calls[0].options.headers.accept, 'application/json');

  assert.equal(calls[1].url, 'http://127.0.0.1:43210/api/resolve');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  const payload = JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(payload).sort(), ['decisions', 'sessionId']);
  assert.deepEqual(payload.decisions, [{ questionId: 'q-1', decision: 'accept', answer: '' }]);
});

test('renderQuestionCard escapes untrusted text while preserving review controls', () => {
  const html = renderQuestionCard({
    question: {
      id: 'q-unsafe',
      severity: 'high',
      type: 'missing-behavior',
      title: '<script>alert(1)</script>',
      ask: '<img src=x onerror=alert(2)>',
      reason: '<b>Need a human review.</b>',
      promptEvidence: '<iframe src="evil"></iframe>',
      evidence: [{ file: 'src/search.js', line: 1, text: '<svg onload=alert(3)>' }],
    },
    response: { decision: 'correct', answer: 'Use description too.' },
  });

  assert.match(html, /Correct intent/);
  assert.match(html, /textarea/);
  assert.match(html, /q-unsafe/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(2\)>/);
});

test('public assets provide a responsive local-only review shell with safe module references', async () => {
  const { html, css, app, web } = await publicFiles();

  ['app-root', 'app-status', 'session-summary', 'question-list', 'question-detail', 'report-output'].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `Missing #${id}`);
  });

  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.mjs"/);
  assert.match(html, /Local only/i);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);

  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);

  assert.match(app, /mountWebReviewApp/);
  assert.match(web, /fetchSessionEnvelope/);
  assert.match(web, /submitDecisionEnvelope/);
  assert.doesNotMatch(web, /innerHTML\s*=/);
});
