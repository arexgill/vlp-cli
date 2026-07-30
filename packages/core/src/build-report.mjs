import { CORE_LIMITS } from './limits.mjs';

const DECISIONS = new Set(['accept', 'correct', 'irrelevant']);

function clean(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
}

function contractText(contract) {
  if (typeof contract === 'string') return clean(contract);

  for (const key of ['text', 'prompt', 'content', 'body', 'markdown']) {
    if (typeof contract?.[key] === 'string') {
      return clean(contract[key]);
    }
  }

  return '';
}

function questionMap(session) {
  return new Map((session.questions || []).map((question) => [question.id, question]));
}

function validateDecisions(session, decisions) {
  if (!Array.isArray(decisions)) throw new Error('Decisions must be an array');

  const questions = questionMap(session);
  const seen = new Set();

  return decisions.map((decision) => {
    const questionId = clean(decision?.questionId);
    const value = clean(decision?.decision);
    const answer = clean(decision?.answer);

    if (!questions.has(questionId)) throw new Error(`Unknown question: ${questionId}`);
    if (!DECISIONS.has(value)) throw new Error(`Invalid decision: ${value}`);
    if (seen.has(questionId)) throw new Error(`Duplicate response: ${questionId}`);
    if (value === 'correct' && !answer) throw new Error(`Correction text is required for ${questionId}`);
    if (answer.length > CORE_LIMITS.maxResponseCharacters) {
      throw new Error(
        `Answer for ${questionId} exceeds ${CORE_LIMITS.maxResponseCharacters} characters`,
      );
    }

    seen.add(questionId);
    return { questionId, decision: value, answer };
  });
}

function evidenceFor(session, question) {
  const ids = new Set(question.docUnitIds || []);
  return (session.docUnits || [])
    .filter((unit) => ids.has(unit.id))
    .map((unit) => `${clean(unit.file)}:${unit.lineStart || 1} — ${clean(unit.text)}`);
}

function renderResolvedItem(session, question, decision) {
  const lines = [
    `### ${clean(question.title)} (${question.id})`,
    '',
    `- **Decision:** ${decision.decision}`,
    `- **Question:** ${clean(question.ask)}`,
  ];

  if (decision.answer) lines.push(`- **User feedback:** ${decision.answer}`);
  if (question.promptEvidence) lines.push(`- **Contract trace:** ${clean(question.promptEvidence)}`);

  const evidence = evidenceFor(session, question);
  lines.push(
    `- **Code/documentation trace:** ${evidence.length ? evidence.join('; ') : 'No direct source line was linked.'}`,
  );
  return lines.join('\n');
}

function renderSection(title, items) {
  return [`## ${title}`, '', items.length ? items.join('\n\n') : 'None'].join('\n');
}

export function buildReport({ contract, session, decisions = [] } = {}) {
  const validatedDecisions = validateDecisions(session, decisions);
  const decisionById = new Map(validatedDecisions.map((decision) => [decision.questionId, decision]));
  const questions = session.questions || [];
  const accepted = [];
  const corrected = [];
  const irrelevant = [];
  const unresolved = [];

  for (const question of questions) {
    const decision = decisionById.get(question.id);
    if (!decision) {
      unresolved.push(
        [
          `### ${clean(question.title)} (${question.id})`,
          '',
          `- **Question:** ${clean(question.ask)}`,
          `- **Reason:** ${clean(question.reason)}`,
        ].join('\n'),
      );
      continue;
    }

    const rendered = renderResolvedItem(session, question, decision);
    if (decision.decision === 'accept') accepted.push(rendered);
    if (decision.decision === 'correct') corrected.push(rendered);
    if (decision.decision === 'irrelevant') irrelevant.push(rendered);
  }

  const diagnostics = (session.diagnostics || []).map(
    (diagnostic) => `- ${clean(diagnostic.file)}:${diagnostic.line || 1} — ${clean(diagnostic.message)}`,
  );

  const repairItems = validatedDecisions
    .filter((decision) => decision.decision === 'correct')
    .map((decision, index) => {
      const question = questions.find((item) => item.id === decision.questionId);
      const evidence = question ? evidenceFor(session, question) : [];
      const trace = evidence.length ? ` Trace: ${evidence.join('; ')}.` : '';
      return `${index + 1}. Update the generated code to satisfy: ${decision.answer}.${trace}`;
    });

  const acceptedIds = validatedDecisions
    .filter((decision) => decision.decision === 'accept')
    .map((decision) => decision.questionId);

  const repairInstructions = [
    ...(repairItems.length ? repairItems : ['No code corrections were requested.']),
    '',
    acceptedIds.length
      ? `Preserve the behavior accepted in: ${acceptedIds.join(', ')}.`
      : 'No generated behaviors were explicitly accepted.',
    unresolved.length
      ? 'Do not infer answers for unresolved questions; ask the user before changing those behaviors.'
      : 'All targeted questions were reviewed.',
    'After editing, run the project tests and report any behavior that could not be implemented.',
  ].join('\n');

  return [
    '# VLP Review Report',
    '',
    `Session: ${clean(session.id)}`,
    '',
    '## Review Summary',
    '',
    `- Targeted questions: ${questions.length}`,
    `- Accepted behaviors: ${accepted.length}`,
    `- Corrected intents: ${corrected.length}`,
    `- Marked irrelevant: ${irrelevant.length}`,
    `- Unresolved: ${unresolved.length}`,
    '',
    '## Original Contract',
    '',
    contractText(contract) || 'No contract text was supplied.',
    '',
    renderSection('Corrected Intent', corrected),
    '',
    renderSection('Accepted Generated Behavior', accepted),
    '',
    renderSection('Marked Irrelevant', irrelevant),
    '',
    renderSection('Unresolved Questions', unresolved),
    '',
    '## Parse Diagnostics',
    '',
    diagnostics.length ? diagnostics.join('\n') : 'None',
    '',
    '## Repair Instructions for Coding Agent',
    '',
    repairInstructions,
    '',
  ].join('\n');
}
