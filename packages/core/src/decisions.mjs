import { CORE_LIMITS } from './limits.mjs';
import { normalizeSessionId } from './session.mjs';

const DECISIONS = new Set(['accept', 'correct', 'irrelevant']);

export class DecisionEnvelopeValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecisionEnvelopeValidationError';
    this.code = code;
  }
}

function validationError(code, message) {
  return new DecisionEnvelopeValidationError(code, message);
}

function clean(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

function questionMap(session) {
  return new Map((session?.questions || []).map((question) => [question.id, question]));
}

function validateSubmittedDecisionEnvelope(session, submitted) {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    throw validationError('ERR_VLP_DECISION_ENVELOPE', 'Submitted decisions must be an object');
  }

  const loadedSessionId = normalizeSessionId(session?.sessionId);
  let submittedSessionId;
  try {
    submittedSessionId = normalizeSessionId(submitted.sessionId);
  } catch {
    throw validationError('ERR_VLP_DECISION_SESSION', 'Submitted session id is invalid');
  }

  if (submittedSessionId !== loadedSessionId) {
    throw validationError('ERR_VLP_DECISION_SESSION_MISMATCH', 'Submitted session id does not match loaded session');
  }

  return submitted.decisions;
}

export function validateSubmittedDecisions(session, submitted) {
  if (!Array.isArray(submitted)) {
    throw validationError('ERR_VLP_DECISION_ARRAY', 'Decisions must be an array');
  }

  const questions = questionMap(session);
  const seen = new Set();

  return submitted.map((decision) => {
    const questionId = clean(decision?.questionId);
    const value = clean(decision?.decision);
    const answer = clean(decision?.answer);

    if (!questions.has(questionId)) {
      throw validationError('ERR_VLP_DECISION_UNKNOWN_QUESTION', `Unknown question: ${questionId}`);
    }
    if (!DECISIONS.has(value)) {
      throw validationError('ERR_VLP_DECISION_INVALID', `Invalid decision: ${value}`);
    }
    if (seen.has(questionId)) {
      throw validationError('ERR_VLP_DECISION_DUPLICATE', `Duplicate response: ${questionId}`);
    }
    if (value === 'correct' && !answer) {
      throw validationError('ERR_VLP_DECISION_MISSING_ANSWER', `Correction text is required for ${questionId}`);
    }
    if (answer.length > CORE_LIMITS.maxResponseCharacters) {
      throw validationError(
        'ERR_VLP_DECISION_ANSWER_TOO_LONG',
        `Answer for ${questionId} exceeds ${CORE_LIMITS.maxResponseCharacters} characters`,
      );
    }

    seen.add(questionId);
    return { questionId, decision: value, answer };
  });
}

export function applyDecisions(session, submitted) {
  const decisions = validateSubmittedDecisions(session, validateSubmittedDecisionEnvelope(session, submitted));

  return Object.freeze({
    ...session,
    decisions: Object.freeze(decisions),
  });
}
