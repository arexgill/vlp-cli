function redactAbsolutePaths(text) {
  return String(text)
    .replace(/(^|[\s([{"'])((?:[A-Za-z]:\\[^\s"']+)|(?:\/(?:[^\s"']+)+))/g, (_, prefix) => `${prefix}[redacted-path]`);
}

function redactCredentialValues(text) {
  return redactAbsolutePaths(text).replace(/\b(?:token|secret|password|api[_-]?key|credential)\b\s*[=:]\s*[^\s,;]+/gi, (match) => {
    const [key] = match.split(/\s*[=:]\s*/);
    return `${key}=[redacted]`;
  });
}

function sanitize(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactCredentialValues(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
}

export function serializeJsonError(error) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'ERR_VLP';
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error);
  return sanitize({ code, message });
}

function evidenceFor(session, question) {
  const ids = new Set(question.docUnitIds || []);
  return (session.docUnits || [])
    .filter((unit) => ids.has(unit.id))
    .map((unit) => ({ file: unit.file, line: unit.lineStart || 1, text: unit.text }));
}

export function reviewContractPayload(contract) {
  if (!contract) return null;
  return sanitize({ id: contract.id || contract.slug || null, status: contract.status, path: contract.path });
}

export function reviewQuestionPayloads(session) {
  return sanitize(
    (session.questions || []).map((question) => ({
      id: question.id,
      type: question.type,
      severity: question.severity,
      title: question.title,
      ask: question.ask,
      reason: question.reason,
      promptEvidence: question.promptEvidence || '',
      sourceEvidence: question.sourceEvidence || null,
      runtimeEvidence: question.runtimeEvidence || null,
      evidence: evidenceFor(session, question),
    })),
  );
}

export function createJsonEnvelope({ command, status, sessionId = null, contract = null, questions = null, reportPath = null, error = null }) {
  return {
    schemaVersion: 1,
    command,
    status,
    sessionId: sessionId || null,
    contract: sanitize(contract),
    questions: sanitize(questions),
    reportPath: sanitize(reportPath),
    error: sanitize(error),
  };
}

export function writeJson(stdout, envelope) {
  stdout.write(`${JSON.stringify(envelope)}\n`);
}
