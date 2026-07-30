# Final review correction 4

## Summary
- Reworked `status` to derive latest review state from validated session files, scan both `.vlp/reviews/.sessions/*.json` and final audit JSON safely, ignore malformed/symlinked entries, and prioritize `vlp resolve --session <id> --input <file> --json` when the latest review is unresolved.
- Added real-flow status coverage for `review --json` -> `status` -> `resolve` -> `status`, plus audit/session tie coverage and a release tag/package version workflow contract test.
- Updated the README primary install command to use the versioned GitHub Release `install.sh` URL with `VLP_VERSION=0.1.0`.
- Removed the tracked scratch report `docs/superpowers/reports/2026-07-30-vlp-cli-final-review-correction-3.md`.

## Verification
- `node --test packages/cli/test/status.test.mjs packages/cli/test/cli.test.mjs test/workspace.test.mjs test/install.test.mjs`
- `npm test`
- `npm run check`
- Local offline install smoke: built release artifacts into a temp `dist/v0.1.0`, served them from `127.0.0.1`, ran `sh install/install.sh` with `VLP_RELEASE_BASE_URL`, `VLP_VERSION=0.1.0`, verified `vlp --version`, and ran `vlp init` in a temp git repo.
- `git diff --check`

## Concerns
- None.
