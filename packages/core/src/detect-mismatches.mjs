import { createHash } from 'node:crypto';

import { keywordsFrom } from './analyze-source.mjs';
import { resolveCoreLimits } from './limits.mjs';

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const TYPE_PRIORITY = {
  'runtime-diagnostic': 10,
  'method-drift': 9,
  'schema-drift': 8,
  'api-use': 7,
  'wrong-flow': 6,
  'wrong-operation': 6,
  'missing-step': 5,
  'wrong-value': 4,
  'redundant-step': 2,
  underspecified: 1,
};
const ERROR_WORDS = /\b(error|errors|invalid|failure|exception)\b/i;
const VAGUE_WORDS = /\b(appropriate|relevant|relevance|reasonable|fast|friendly|secure|proper|clear|best)\b/i;

function contractText(contract) {
  if (typeof contract === 'string') return contract;

  for (const key of ['text', 'prompt', 'content', 'body', 'markdown']) {
    if (typeof contract?.[key] === 'string') {
      return contract[key];
    }
  }

  return '';
}

function splitContract(contract) {
  return (String(contractText(contract)).match(/[^.!?\n]+[.!?]?/g) || [])
    .map((statement) => statement.replace(/^\s*[-*#]+\s*/, '').trim())
    .filter(Boolean)
    .map((text) => ({ text, keywords: keywordsFrom(text) }))
    .filter((statement) => statement.keywords.length >= 3);
}

function intersectionSize(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return left.reduce((total, word) => total + Number(rightSet.has(word)), 0);
}

function makeId(question) {
  const trace = [question.type, question.promptEvidence, question.docUnitIds.join(','), question.ask].join('\0');
  return `q-${createHash('sha1').update(trace).digest('hex').slice(0, 12)}`;
}

function finalize(question) {
  return { id: makeId(question), ...question };
}

function bestEvidence(statement, docUnits) {
  return docUnits
    .map((unit) => ({ unit, overlap: intersectionSize(statement.keywords, unit.keywords || []) }))
    .sort((left, right) => right.overlap - left.overlap || left.unit.id.localeCompare(right.unit.id));
}

function missingStepQuestions(statements, docUnits) {
  const union = new Set(docUnits.flatMap((unit) => unit.keywords || []));
  const questions = [];

  for (const statement of statements) {
    const covered = intersectionSize(statement.keywords, union);
    const coverage = covered / statement.keywords.length;
    if (coverage >= 0.45) continue;

    const missing = statement.keywords.filter((word) => !union.has(word));
    const ranked = bestEvidence(statement, docUnits);
    const related = ranked.filter((item) => item.overlap > 0).slice(0, 3).map((item) => item.unit.id);
    const docUnitIds = related.length > 0 ? related : docUnits.slice(0, 2).map((unit) => unit.id);
    const topic = missing.join(', ');
    questions.push(
      finalize({
        type: 'missing-step',
        severity: /\b(must|required|never)\b/i.test(statement.text) ? 'high' : 'medium',
        title: `Validate missing behavior: ${missing.slice(0, 3).join(', ') || 'prompt obligation'}`,
        ask: `The contract mentions ${topic}, but the documentation does not strongly represent it. Should the implementation include it?`,
        reason: `The contract obligation is not strongly represented: only ${Math.round(coverage * 100)}% of its meaningful terms appear in the generated documentation.`,
        promptEvidence: statement.text,
        docUnitIds,
      }),
    );
  }

  return questions;
}

function literalValues(code) {
  const values = [];
  for (const match of String(code).matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) {
    if (!['0', '1', '-1'].includes(match[0])) values.push(match[0]);
  }
  for (const match of String(code).matchAll(/(['"`])([^'"`\n]{1,80})\1/g)) {
    values.push(match[2]);
  }
  return [...new Set(values)];
}

function wrongValueQuestions(contract, docUnits) {
  const questions = [];
  const text = contractText(contract).toLowerCase();

  for (const unit of docUnits.filter((item) => ['condition', 'call'].includes(item.kind))) {
    for (const value of literalValues(unit.code)) {
      if (text.includes(value.toLowerCase())) continue;
      questions.push(
        finalize({
          type: 'wrong-value',
          severity: 'medium',
          title: `Validate unstated value: ${value}`,
          ask: `Is the value “${value}” in ${unit.symbol} intended?`,
          reason: 'The generated behavior uses a concrete value that is not stated in the contract.',
          promptEvidence: '',
          docUnitIds: [unit.id],
        }),
      );
    }
  }

  return questions;
}

function errorHandlingQuestion(contract, docUnits) {
  const text = contractText(contract);
  if (!ERROR_WORDS.test(text) || docUnits.some((unit) => unit.kind === 'throw' || unit.kind === 'catch')) {
    return [];
  }

  const related = docUnits
    .filter((unit) => unit.kind === 'condition' || unit.kind === 'return')
    .slice(0, 3)
    .map((unit) => unit.id);
  const evidence = splitContract(contract).find((statement) => ERROR_WORDS.test(statement.text))?.text || '';

  return [
    finalize({
      type: 'api-use',
      severity: 'high',
      title: 'Validate invalid-input behavior',
      ask: 'The contract mentions invalid or error behavior, but no throw/catch behavior is documented. How should invalid input be surfaced?',
      reason: 'The documented implementation has no explicit exception path.',
      promptEvidence: evidence,
      docUnitIds: related,
    }),
  ];
}

function underspecifiedQuestions(statements, docUnits) {
  return statements
    .filter((statement) => VAGUE_WORDS.test(statement.text) && !/\b\d+(?:\.\d+)?\b/.test(statement.text))
    .slice(0, 2)
    .map((statement) =>
      finalize({
        type: 'underspecified',
        severity: 'low',
        title: 'Clarify a subjective requirement',
        ask: `What concrete behavior should “${statement.text.replace(/[.!?]$/, '')}” require?`,
        reason: 'This contract statement uses a subjective term without a measurable acceptance criterion.',
        promptEvidence: statement.text,
        docUnitIds: bestEvidence(statement, docUnits).slice(0, 2).map((item) => item.unit.id),
      }),
    );
}

function redundantStepQuestions(statements, docUnits) {
  const contractUnion = new Set(statements.flatMap((statement) => statement.keywords));
  return docUnits
    .filter((unit) => ['return', 'call'].includes(unit.kind))
    .filter((unit) => intersectionSize(unit.keywords || [], contractUnion) === 0)
    .slice(0, 3)
    .map((unit) =>
      finalize({
        type: 'redundant-step',
        severity: 'low',
        title: `Validate unrequested behavior in ${unit.symbol}`,
        ask: `The documentation says “${unit.text}” Is this behavior intended?`,
        reason: 'This documented operation has no meaningful term overlap with the contract.',
        promptEvidence: '',
        docUnitIds: [unit.id],
      }),
    );
}

function deduplicateQuestions(questions) {
  const selected = new Map();

  for (const question of questions) {
    const traceValue = typeof question.promptEvidence === 'string'
      ? question.promptEvidence
      : JSON.stringify(question.sourceEvidence || {});
    const normalizedTrace = traceValue.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = normalizedTrace && normalizedTrace !== '{}' ? `trace:${normalizedTrace}` : `id:${question.id}`;
    const existing = selected.get(key);

    if (!existing) {
      selected.set(key, question);
      continue;
    }

    const priorityDifference = (TYPE_PRIORITY[question.type] || 0) - (TYPE_PRIORITY[existing.type] || 0);
    const severityDifference = SEVERITY_WEIGHT[question.severity] - SEVERITY_WEIGHT[existing.severity];
    if (priorityDifference > 0 || (priorityDifference === 0 && severityDifference > 0)) {
      selected.set(key, question);
    }
  }

  return [...selected.values()];
}

function injectedQuestions(runtimeEvidence) {
  if (Array.isArray(runtimeEvidence)) {
    return runtimeEvidence;
  }

  if (Array.isArray(runtimeEvidence?.questions)) {
    return runtimeEvidence.questions;
  }

  return [];
}

export function detectQuestions({ contract, analysis, runtimeEvidence, limits: limitOverrides } = {}) {
  const limits = resolveCoreLimits(limitOverrides);
  const docUnits = analysis?.docUnits || [];
  const statements = splitContract(contract);
  const questions = [
    ...injectedQuestions(runtimeEvidence),
    ...missingStepQuestions(statements, docUnits),
    ...wrongValueQuestions(contract, docUnits),
    ...errorHandlingQuestion(contract, docUnits),
    ...underspecifiedQuestions(statements, docUnits),
    ...redundantStepQuestions(statements, docUnits),
  ];

  return deduplicateQuestions(questions)
    .sort(
      (left, right) =>
        SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]
        || left.type.localeCompare(right.type)
        || left.id.localeCompare(right.id),
    )
    .slice(0, limits.maxQuestions);
}
