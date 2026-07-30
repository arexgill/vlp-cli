import { createHash } from 'node:crypto';
import path from 'node:path';

import { analyzeSources } from './analyze-source.mjs';
import { compareFastApiContracts, normalizeFastApiContracts } from './fastapi-contracts.mjs';
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

function mergeRuntimeEvidence(runtimeEvidence, injectedQuestions) {
  if (!Array.isArray(injectedQuestions) || injectedQuestions.length === 0) {
    return runtimeEvidence;
  }

  if (Array.isArray(runtimeEvidence)) {
    return [...injectedQuestions, ...runtimeEvidence];
  }

  if (runtimeEvidence && typeof runtimeEvidence === 'object') {
    const questions = Array.isArray(runtimeEvidence.questions) ? runtimeEvidence.questions : [];
    return {
      ...runtimeEvidence,
      questions: [...injectedQuestions, ...questions],
    };
  }

  return { questions: injectedQuestions };
}

export async function reviewContract({ contract, sources, runtimeEvidence, analysisOptions, analysis } = {}) {
  const normalizedSources = Object.freeze((sources || []).map((source) => normalizeSource(source)));
  const resolvedAnalysis = analysis || await analyzeSources(normalizedSources, analysisOptions);
  const fastApiRoutes = normalizeFastApiContracts(resolvedAnalysis.frameworkHints?.fastapiRoutes);

  let mergedRuntimeEvidence = runtimeEvidence;
  if (fastApiRoutes.length > 0) {
    const runtimeDiagnostics = runtimeEvidence && typeof runtimeEvidence === 'object' && !Array.isArray(runtimeEvidence)
      ? runtimeEvidence
      : null;
    const fastApiQuestions = compareFastApiContracts({
      staticContracts: fastApiRoutes,
      openapi: runtimeDiagnostics?.openapi ?? null,
      diagnostic: runtimeDiagnostics?.diagnostic ?? null,
    });
    mergedRuntimeEvidence = mergeRuntimeEvidence(runtimeEvidence, fastApiQuestions);
  }

  const questions = detectQuestions({ contract, analysis: resolvedAnalysis, runtimeEvidence: mergedRuntimeEvidence });

  const fingerprint = createHash('sha256')
    .update(contractText(contract))
    .update('\0')
    .update(normalizedSources.map((source) => `${source.path}\0${source.content}`).join('\0'))
    .digest('hex')
    .slice(0, 16);

  return Object.freeze({
    fingerprint,
    sources: normalizedSources,
    docUnits: resolvedAnalysis.docUnits,
    diagnostics: resolvedAnalysis.diagnostics,
    questions,
    meta: {
      sourceCount: normalizedSources.length,
      docUnitCount: resolvedAnalysis.docUnits.length,
      questionCount: questions.length,
      engine: 'heuristic-local-poc',
    },
  });
}
