import { randomUUID as nodeRandomUUID } from 'node:crypto';

export const REVIEW_SESSION_VERSION = 1;
export const SESSION_ID_PATTERN = /^session-v1-[0-9a-f]{32}$/;

function clean(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

function cloneRecord(record) {
  if (record === null || record === undefined) {
    return record ?? null;
  }

  if (typeof record !== 'object') {
    return record;
  }

  return { ...record };
}

function cloneRecords(records) {
  return Array.isArray(records) ? records.map((record) => cloneRecord(record)) : [];
}

export function normalizeSessionId(value) {
  const sessionId = clean(value);

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid review session id');
  }

  return sessionId;
}

export function normalizeReviewSession(session = {}) {
  const version = session?.version;
  if (version !== REVIEW_SESSION_VERSION) {
    throw new Error(`Unsupported review session version: ${version}`);
  }

  return Object.freeze({
    version,
    sessionId: normalizeSessionId(session?.sessionId),
    contract: cloneRecord(session.contract),
    sources: cloneRecords(session.sources),
    docUnits: cloneRecords(session.docUnits),
    diagnostics: cloneRecords(session.diagnostics),
    questions: cloneRecords(session.questions),
    decisions: cloneRecords(session.decisions),
    meta: session.meta && typeof session.meta === 'object' ? { ...session.meta } : null,
  });
}

export function createReviewSession(input = {}, { randomUUID = nodeRandomUUID } = {}) {
  const uuid = typeof randomUUID === 'function' ? randomUUID() : nodeRandomUUID();
  const sessionId = normalizeSessionId(`session-v1-${String(uuid ?? '').replaceAll('-', '')}`);

  return normalizeReviewSession({
    version: REVIEW_SESSION_VERSION,
    sessionId,
    contract: input.contract,
    sources: input.sources,
    docUnits: input.docUnits,
    diagnostics: input.diagnostics,
    questions: input.questions,
    decisions: input.decisions ?? [],
    meta: input.meta,
  });
}
