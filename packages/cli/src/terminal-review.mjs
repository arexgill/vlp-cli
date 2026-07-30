import { createInterface } from 'node:readline';

function clean(value) {
  return String(value ?? '').trim();
}

function evidenceFor(session, question) {
  const ids = new Set(question.docUnitIds || []);
  return (session.docUnits || [])
    .filter((unit) => ids.has(unit.id))
    .map((unit) => `${unit.file}:${unit.lineStart || 1} — ${unit.text}`);
}

function formatSourceEvidence(sourceEvidence) {
  if (!sourceEvidence || typeof sourceEvidence !== 'object' || !sourceEvidence.file) return '';
  const lineStart = Number.isInteger(sourceEvidence.lineStart) ? sourceEvidence.lineStart : 1;
  const target = clean(sourceEvidence.target);
  return `${clean(sourceEvidence.file)}:${lineStart}${target ? ` (Target: ${target})` : ''}`;
}

function formatRuntimeEvidence(runtimeEvidence) {
  if (!runtimeEvidence || typeof runtimeEvidence !== 'object') return '';
  if (runtimeEvidence.type === 'diagnostic') {
    const message = clean(runtimeEvidence.message);
    return message ? `[Diagnostic] ${message}` : '[Diagnostic]';
  }

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

  return `[${clean(runtimeEvidence.type)}] ${parts.join(' ').trim()}`.trim();
}

async function prompt(iterator, stdout, message) {
  stdout.write(message);
  const { value, done } = await iterator.next();
  return done ? null : value;
}

export async function runTerminalReview({ session, stdin, stdout, stderr }) {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  const iterator = rl[Symbol.asyncIterator]();
  const decisions = [];

  try {
    for (let index = 0; index < (session.questions || []).length; index += 1) {
      const question = session.questions[index];
      const evidence = evidenceFor(session, question);
      stdout.write(`Question ${index + 1}/${session.questions.length}: ${question.title} (${question.id})\n`);
      stdout.write(`Question: ${question.ask}\n`);
      stdout.write(`Reason: ${question.reason}\n`);
      if (question.promptEvidence) {
        stdout.write(`Contract: ${question.promptEvidence}\n`);
      }
      const sourceEvidence = formatSourceEvidence(question.sourceEvidence);
      if (sourceEvidence) {
        stdout.write(`Source evidence: ${sourceEvidence}\n`);
      }
      const runtimeEvidence = formatRuntimeEvidence(question.runtimeEvidence);
      if (runtimeEvidence) {
        stdout.write(`Runtime OpenAPI evidence: ${runtimeEvidence}\n`);
      }
      if (evidence.length > 0) {
        stdout.write('Evidence:\n');
        evidence.forEach((line, evidenceIndex) => {
          stdout.write(`${evidenceIndex + 1}. ${line}\n`);
        });
      }

      let decision = null;
      while (!decision) {
        const rawAnswer = await prompt(iterator, stdout, '[a]ccept [c]orrect [i]rrelevant [q]uit: ');
        if (rawAnswer === null) {
          stderr.write('Review aborted.\n');
          return { status: 'aborted', decisions: [] };
        }

        const answer = clean(rawAnswer);
        if (!answer) {
          stderr.write('Enter a, c, i, or q.\n');
          continue;
        }

        const normalized = answer.toLowerCase();
        if (['q', 'quit'].includes(normalized)) {
          stderr.write('Review aborted.\n');
          return { status: 'aborted', decisions: [] };
        }
        if (['a', 'accept'].includes(normalized)) {
          decision = { questionId: question.id, decision: 'accept', answer: '' };
          break;
        }
        if (['i', 'irrelevant'].includes(normalized)) {
          decision = { questionId: question.id, decision: 'irrelevant', answer: '' };
          break;
        }
        if (['c', 'correct'].includes(normalized)) {
          for (;;) {
            const rawCorrection = await prompt(iterator, stdout, 'Correction: ');
            if (rawCorrection === null) {
              stderr.write('Review aborted.\n');
              return { status: 'aborted', decisions: [] };
            }
            const correction = clean(rawCorrection);
            if (!correction) {
              stderr.write('Correction text is required.\n');
              continue;
            }
            decision = { questionId: question.id, decision: 'correct', answer: correction };
            break;
          }
          break;
        }

        stderr.write('Enter a, c, i, or q.\n');
      }

      decisions.push(decision);
      stdout.write('\n');
    }

    const accepted = decisions.filter((item) => item.decision === 'accept').length;
    const corrected = decisions.filter((item) => item.decision === 'correct').length;
    const irrelevant = decisions.filter((item) => item.decision === 'irrelevant').length;

    stdout.write('Review summary\n');
    stdout.write(`Accepted: ${accepted}\n`);
    stdout.write(`Corrected: ${corrected}\n`);
    stdout.write(`Irrelevant: ${irrelevant}\n`);

    return { status: 'completed', decisions };
  } finally {
    rl.close();
  }
}
