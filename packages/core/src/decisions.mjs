import { CORE_LIMITS } from './limits.mjs';

const DECISIONS = new Set(['accept', 'correct', 'irrelevant']);

function clean(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

function questionMap(session) {
  return new Map((session?.questions || []).map((question) => [question.id, question]));
}

export function validateSubmittedDecisions(session, submitted) {
  if (!Array.isArray(submitted)) throw new Error('Decisions must be an array');

  const questions = questionMap(session);
  const seen = new Set();

  return submitted.map((decision) => {
    const questionId = clean(decision?.questionId);
    const value = clean(decision?.decision);
    const answer = clean(decision?.answer);

    if (!questions.has(questionId)) throw new Error(`Unknown question: ${questionId}`);
    if (!DECISIONS.has(value)) throw new Error(`Invalid decision: ${value}`);
    if (seen.has(questionId)) throw new Error(`Duplicate response: ${questionId}`);
    if (value === 'correct' && !answer) throw new Error(`Correction text is required for ${questionId}`);
    if (answer.length > CORE_LIMITS.maxResponseCharacters) {
      throw new Error(`Answer for ${questionId} exceeds ${CORE_LIMITS.maxResponseCharacters} characters`);
    }

    seen.add(questionId);
    return { questionId, decision: value, answer };
  });
}

export function applyDecisions(session, submitted) {
  const decisions = validateSubmittedDecisions(session, submitted);

  return Object.freeze({
    ...session,
    decisions: Object.freeze(decisions),
  });
}
