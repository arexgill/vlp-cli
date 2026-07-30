import { fileURLToPath } from 'node:url';

export function resolveUiAssetRoot() {
  return fileURLToPath(new URL('../public/', import.meta.url));
}
