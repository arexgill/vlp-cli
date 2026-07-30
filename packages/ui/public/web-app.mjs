function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function apiUrl(baseUrl, pathname) {
  if (!baseUrl) return pathname;
  return new URL(pathname, baseUrl).toString();
}

function normalizedDecision(decision = {}) {
  return {
    questionId: String(decision.questionId ?? '').trim(),
    decision: String(decision.decision ?? '').trim(),
    answer: String(decision.answer ?? '').trim(),
  };
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok) {
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function fetchSessionEnvelope({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '' } = {}) {
  const response = await fetchImpl(apiUrl(baseUrl, '/api/session'), {
    headers: { accept: 'application/json' },
  });
  return readJson(response);
}

export async function submitDecisionEnvelope({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = '', sessionId, decisions = [] } = {}) {
  const response = await fetchImpl(apiUrl(baseUrl, '/api/resolve'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId,
      decisions: decisions.map((decision) => normalizedDecision(decision)),
    }),
  });
  return readJson(response);
}

function decisionCopy(value) {
  if (value === 'accept') return 'Accept behavior';
  if (value === 'correct') return 'Correct intent';
  if (value === 'irrelevant') return 'Not relevant';
  return 'Unreviewed';
}

function evidenceMarkup(question = {}) {
  const evidence = Array.isArray(question.evidence) ? question.evidence : [];
  if (evidence.length === 0) {
    return '<li><span>No linked source evidence.</span></li>';
  }

  return evidence
    .map((item) => `<li><strong>${escapeHtml(item.file)}:${escapeHtml(item.line)}</strong><span>${escapeHtml(item.text)}</span></li>`)
    .join('');
}

export function renderQuestionCard({ question = {}, response = {} } = {}) {
  const selected = normalizedDecision(response);
  return [
    `<section data-question-id="${escapeHtml(question.id)}">`,
    `<p class="detail-meta">${escapeHtml(question.type)} · ${escapeHtml(question.severity)}</p>`,
    `<h3>${escapeHtml(question.title)}</h3>`,
    `<p>${escapeHtml(question.ask)}</p>`,
    `<p>${escapeHtml(question.reason)}</p>`,
    '<div class="trace-block">',
    '<h4>Prompt trace</h4>',
    `<pre class="trace-code">${escapeHtml(question.promptEvidence)}</pre>`,
    '</div>',
    '<div class="trace-block">',
    '<h4>Evidence</h4>',
    `<ol class="trace-list">${evidenceMarkup(question)}</ol>`,
    '</div>',
    '<div class="response-block">',
    `<p>${escapeHtml(decisionCopy(selected.decision))}</p>`,
    '<textarea aria-label="Correction text"></textarea>',
    '<div class="decision-buttons">',
    '<button type="button">Accept behavior</button>',
    '<button type="button">Correct intent</button>',
    '<button type="button">Not relevant</button>',
    '</div>',
    '</div>',
    '</section>',
  ].join('');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectedQuestion(state) {
  return state.session?.questions?.[state.questionIndex] ?? null;
}

function selectedResponse(state) {
  const question = selectedQuestion(state);
  return question ? state.responses.get(question.id) || null : null;
}

function updateStatus(elements, message, tone = 'neutral') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function renderSummary(elements, state) {
  const items = [
    [state.session?.questions?.length ?? 0, 'Questions'],
    [state.session?.sources?.length ?? 0, 'Source files'],
    [state.responses.size, 'Answered'],
    [state.session?.contract?.id ?? 'none', 'Contract'],
  ];

  elements.summary.replaceChildren(...items.map(([value, label]) => {
    const card = element('div', 'summary-item');
    card.append(element('strong', '', String(value)), element('span', '', label));
    return card;
  }));
}

function renderQuestionList(elements, state) {
  const questions = state.session?.questions ?? [];
  if (questions.length === 0) {
    elements.questionList.replaceChildren(element('p', 'empty-state', 'No review questions were generated.'));
    return;
  }

  elements.questionList.replaceChildren(...questions.map((question, index) => {
    const button = element('button', 'question-link');
    button.type = 'button';
    if (index === state.questionIndex) button.classList.add('active');
    const response = state.responses.get(question.id);
    button.append(
      element('strong', '', `${index + 1}. ${question.title}`),
      element('small', '', `${question.severity} · ${decisionCopy(response?.decision)}`),
    );
    button.addEventListener('click', () => {
      state.questionIndex = index;
      renderAll(elements, state);
    });
    return button;
  }));
}

function sourceForQuestion(state, question) {
  const evidence = Array.isArray(question?.evidence) ? question.evidence : [];
  const file = evidence.find((item) => item?.file)?.file;
  if (!file) return state.session?.sources?.[0] ?? null;
  return state.session?.sources?.find((source) => source.path === file) ?? state.session?.sources?.[0] ?? null;
}

function renderSourceBlock(state, question) {
  const wrapper = element('div', 'source-block');
  wrapper.append(element('h4', '', 'Source context'));

  const sources = state.session?.sources ?? [];
  if (sources.length === 0) {
    wrapper.append(element('p', 'empty-state', 'No source files were captured for this review.'));
    return wrapper;
  }

  const source = sourceForQuestion(state, question);
  const select = element('select', 'source-select');
  sources.forEach((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = item.path;
    option.selected = item.path === source?.path;
    select.append(option);
  });
  select.addEventListener('change', (event) => {
    const next = sources[Number(event.target.value)] ?? sources[0];
    state.manualSourcePath = next?.path ?? null;
    renderAll(elementsCache, state);
  });

  const manualSource = sources.find((item) => item.path === state.manualSourcePath);
  const chosen = manualSource ?? source ?? sources[0];
  wrapper.append(select);
  wrapper.append(element('p', 'source-meta', chosen?.path || 'No source selected'));
  wrapper.append(element('pre', 'source-view', chosen?.content || ''));
  return wrapper;
}

let elementsCache = null;

function renderQuestionDetail(elements, state) {
  const question = selectedQuestion(state);
  const response = selectedResponse(state);
  const detail = elements.detail;
  detail.replaceChildren();

  if (!question) {
    detail.append(
      element('p', 'detail-meta', 'No heuristic flags'),
      element('h3', '', 'No targeted questions'),
      element('p', '', 'Generate the report to persist an all-clear review result.'),
    );
    return;
  }

  const head = element('div', 'detail-head');
  const copy = element('div', 'detail-copy');
  copy.append(
    element('p', 'detail-meta', question.type),
    element('h3', '', question.title),
    element('p', '', question.ask),
    element('p', 'muted', question.reason),
  );
  head.append(copy, element('span', 'severity', question.severity));
  detail.append(head);

  const contract = element('div', 'contract-block');
  contract.append(element('h4', '', 'Contract trace'));
  contract.append(element('pre', 'contract-text', state.session?.contract?.content || ''));
  detail.append(contract);

  const promptBlock = element('div', 'trace-block');
  promptBlock.append(element('h4', '', 'Prompt evidence'));
  promptBlock.append(element('pre', 'trace-code', question.promptEvidence || 'No prompt evidence was linked.'));
  detail.append(promptBlock);

  const evidenceBlock = element('div', 'trace-block');
  evidenceBlock.append(element('h4', '', 'Code evidence'));
  const evidenceList = element('ol', 'trace-list');
  const evidence = Array.isArray(question.evidence) ? question.evidence : [];
  if (evidence.length === 0) {
    evidenceList.append(element('li', 'empty-state', 'No linked source evidence.'));
  } else {
    evidence.forEach((item) => {
      const entry = document.createElement('li');
      entry.append(element('strong', '', `${item.file}:${item.line}`), element('span', '', item.text));
      evidenceList.append(entry);
    });
  }
  evidenceBlock.append(evidenceList);
  detail.append(evidenceBlock);

  detail.append(renderSourceBlock(state, question));

  const responseBlock = element('div', 'response-block');
  responseBlock.append(element('h4', '', 'Your review'));
  const textarea = document.createElement('textarea');
  textarea.value = response?.answer || '';
  textarea.placeholder = 'Describe the intended behavior when correcting intent.';
  textarea.addEventListener('input', () => {
    const existing = state.responses.get(question.id) || { questionId: question.id, decision: response?.decision || '', answer: '' };
    existing.answer = textarea.value;
    state.responses.set(question.id, existing);
  });
  responseBlock.append(textarea);

  const error = element('p', 'form-error', '');
  const buttonRow = element('div', 'decision-buttons');
  ['accept', 'correct', 'irrelevant'].forEach((decision) => {
    const button = element('button', 'decision-button', decisionCopy(decision));
    button.type = 'button';
    if (response?.decision === decision) button.classList.add('selected');
    button.addEventListener('click', () => {
      const next = state.responses.get(question.id) || { questionId: question.id, decision: '', answer: '' };
      next.questionId = question.id;
      next.decision = decision;
      next.answer = textarea.value;
      if (decision === 'correct' && !String(next.answer || '').trim()) {
        error.textContent = 'Correction text is required before marking this question as corrected.';
        textarea.focus();
        return;
      }
      error.textContent = '';
      state.responses.set(question.id, next);
      renderAll(elements, state);
    });
    buttonRow.append(button);
  });
  responseBlock.append(buttonRow, error);
  detail.append(responseBlock);
}

function renderReport(elements, state) {
  elements.report.textContent = state.report || 'No report yet.';
}

function renderAll(elements, state) {
  renderSummary(elements, state);
  renderQuestionList(elements, state);
  renderQuestionDetail(elements, state);
  renderReport(elements, state);
}

function completeDecisions(state) {
  const questions = state.session?.questions ?? [];
  return questions.map((question) => {
    const response = state.responses.get(question.id);
    return response ? normalizedDecision(response) : null;
  });
}

export function mountWebReviewApp({
  document: doc = globalThis.document,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  location = globalThis.location,
} = {}) {
  if (!doc) return;

  const state = {
    session: null,
    responses: new Map(),
    questionIndex: 0,
    report: '',
    manualSourcePath: null,
  };

  const elements = {
    status: doc.getElementById('app-status'),
    summary: doc.getElementById('session-summary'),
    questionList: doc.getElementById('question-list'),
    detail: doc.getElementById('question-detail'),
    report: doc.getElementById('report-output'),
    submit: doc.getElementById('submit-review'),
  };
  elementsCache = elements;

  const submit = async () => {
    try {
      const decisions = completeDecisions(state);
      if (decisions.includes(null)) {
        updateStatus(elements, 'Review every question before generating the report.', 'error');
        return;
      }
      updateStatus(elements, 'Generating report…');
      const result = await submitDecisionEnvelope({
        fetchImpl,
        baseUrl: location?.origin || '',
        sessionId: state.session.sessionId,
        decisions,
      });
      state.report = result.markdown || 'No report was returned.';
      renderReport(elements, state);
      updateStatus(elements, 'Report ready', 'success');
    } catch (error) {
      updateStatus(elements, error.message, 'error');
    }
  };

  elements.submit?.addEventListener('click', submit);

  fetchSessionEnvelope({ fetchImpl, baseUrl: location?.origin || '' })
    .then((session) => {
      state.session = session;
      renderAll(elements, state);
      updateStatus(elements, 'Review session ready', 'success');
    })
    .catch((error) => {
      updateStatus(elements, error.message, 'error');
      elements.detail.replaceChildren(
        element('h3', '', 'Unable to load the review session'),
        element('p', '', 'Return to the terminal for server diagnostics, then restart web review.'),
      );
    });
}
