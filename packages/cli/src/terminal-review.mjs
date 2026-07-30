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
