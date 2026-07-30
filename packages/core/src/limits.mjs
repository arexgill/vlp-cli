export const CORE_LIMITS = Object.freeze({
  maxSourceFiles: 200,
  maxSourceFileBytes: 1024 * 1024,
  maxQuestions: 20,
  maxResponseCharacters: 4000,
});

export function resolveCoreLimits(overrides = {}) {
  return Object.freeze({
    ...CORE_LIMITS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  });
}
