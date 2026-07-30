import { initializeProject } from '../project.mjs';

function serializeError(error) {
  return Object.freeze({
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code,
  });
}

export async function handleInit(input = {}) {
  try {
    return Object.freeze({
      ok: true,
      result: await initializeProject(input.root),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: serializeError(error),
    });
  }
}
