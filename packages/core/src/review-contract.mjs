import { createHash } from 'node:crypto';
import path from 'node:path';

import { analyzeSources } from './analyze-source.mjs';
import { detectQuestions } from './detect-mismatches.mjs';

function cleanText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n');
}

function normalizeSourcePath(filePath) {
  const sourcePath = cleanText(filePath).replaceAll('\\', '/');
  if (!sourcePath) throw new Error('Source path is required');
  if (path.posix.isAbsolute(sourcePath) || /^[A-Za-z]:\//.test(sourcePath)) {
    throw new Error('Source paths must be repository-relative');
  }

  const normalized = path.posix.normalize(sourcePath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Source paths must stay within the repository root');
  }

  return normalized;
}

function normalizeSource(source) {
  return Object.freeze({
    path: normalizeSourcePath(source?.path),
    language: cleanText(source?.language),
    content: cleanText(source?.content),
  });
}

function contractText(contract) {
  if (typeof contract === 'string') return contract;

  for (const key of ['text', 'prompt', 'content', 'body', 'markdown']) {
    if (typeof contract?.[key] === 'string') {
      return cleanText(contract[key]).trim();
    }
  }

  return '';
}

export async function reviewContract({ contract, sources, runtimeEvidence, analysisOptions } = {}) {
  const normalizedSources = Object.freeze((sources || []).map((source) => normalizeSource(source)));
  const analysis = await analyzeSources(normalizedSources, analysisOptions);
  const questions = detectQuestions({ contract, analysis, runtimeEvidence });

  const fingerprint = createHash('sha256')
    .update(contractText(contract))
    .update('\0')
    .update(normalizedSources.map((source) => `${source.path}\0${source.content}`).join('\0'))
    .digest('hex')
    .slice(0, 16);

  return Object.freeze({
    id: `session-${fingerprint}`,
    sources: normalizedSources,
    docUnits: analysis.docUnits,
    diagnostics: analysis.diagnostics,
    questions,
    meta: {
      sourceCount: normalizedSources.length,
      docUnitCount: analysis.docUnits.length,
      questionCount: questions.length,
      engine: 'heuristic-local-poc',
    },
  });
}
