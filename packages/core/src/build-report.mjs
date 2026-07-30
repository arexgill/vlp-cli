import { validateSubmittedDecisions } from './decisions.mjs';
import { normalizeSessionId } from './session.mjs';

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

function evidenceFor(session, question) {
  const ids = new Set(question.docUnitIds || []);
  return (session.docUnits || [])
    .filter((unit) => ids.has(unit.id))
    .map((unit) => `${clean(unit.file)}:${unit.lineStart || 1} — ${clean(unit.text)}`);
}

function formatSourceEvidence(sourceEvidence) {
  if (!sourceEvidence || typeof sourceEvidence !== 'object') return '';

  const file = clean(sourceEvidence.file);
  if (!file) return '';

  const lineStart = Number.isInteger(sourceEvidence.lineStart) ? sourceEvidence.lineStart : 1;
  const target = clean(sourceEvidence.target);
  return `${file}:${lineStart}${target ? ` (Target: ${target})` : ''}`;
}

function formatRuntimeEvidence(runtimeEvidence) {
  if (!runtimeEvidence || typeof runtimeEvidence !== 'object') return '';

  if (runtimeEvidence.type === 'diagnostic') {
    const message = clean(runtimeEvidence.message);
    return message ? `[Diagnostic] ${message}` : '[Diagnostic]';
  }

  const type = clean(runtimeEvidence.type);
  const parts = [];
  if (runtimeEvidence.path) parts.push(clean(runtimeEvidence.path));
  if (runtimeEvidence.expected) parts.push(`expected=${clean(runtimeEvidence.expected)}`);
  if (runtimeEvidence.actual) parts.push(`actual=${clean(runtimeEvidence.actual)}`);
  if (Array.isArray(runtimeEvidence.methods) && runtimeEvidence.methods.length > 0) {
    parts.push(runtimeEvidence.methods.map((method) => clean(method)).filter(Boolean).join(','));
  } else if (runtimeEvidence.method) {
    parts.push(clean(runtimeEvidence.method));
  }
  if (runtimeEvidence.status !== undefined && runtimeEvidence.status !== null) {
    parts.push(`status=${clean(runtimeEvidence.status)}`);
  }
  if (runtimeEvidence.responseModel) {
    parts.push(`responseModel=${clean(runtimeEvidence.responseModel)}`);
  }

  return `[${type}] ${parts.join(' ').trim()}`.trim();
}

function appendFastApiEvidence(lines, question) {
  const sourceEvidence = formatSourceEvidence(question.sourceEvidence);
  if (sourceEvidence) {
    lines.push(`- **Source evidence:** ${sourceEvidence}`);
  }

  const runtimeEvidence = formatRuntimeEvidence(question.runtimeEvidence);
  if (runtimeEvidence) {
    lines.push(`- **Runtime OpenAPI evidence:** ${runtimeEvidence}`);
  }
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
  appendFastApiEvidence(lines, question);

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
  const validatedDecisions = validateSubmittedDecisions(session, decisions);
  const decisionById = new Map(validatedDecisions.map((decision) => [decision.questionId, decision]));
  const questions = session.questions || [];
  const accepted = [];
  const corrected = [];
  const irrelevant = [];
  const unresolved = [];

  for (const question of questions) {
    const decision = decisionById.get(question.id);
    if (!decision) {
      const lines = [
        `### ${clean(question.title)} (${question.id})`,
        '',
        `- **Question:** ${clean(question.ask)}`,
        `- **Reason:** ${clean(question.reason)}`,
      ];
      appendFastApiEvidence(lines, question);
      unresolved.push(lines.join('\n'));
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

  const sessionId = normalizeSessionId(session?.sessionId);

  return [
    '# VLP Review Report',
    '',
    `Session: ${sessionId}`,
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
