# Final review correction 3

## Summary
- Added shared decision-envelope byte limit in core and wired CLI/web to the same value.
- Reworked `vlp resolve` input handling to stream stdin/files with a hard byte cap and stable JSON errors.
- Added latest-review status scanning from `.vlp/reviews/*.json` with safe symlink/malformed skipping and updated next-command guidance.
- Added resolve bound tests, status coverage, and shared limit coverage.

## Verification
- `node --test packages/cli/test/resolve-input.test.mjs packages/cli/test/status.test.mjs packages/cli/test/web-review.test.mjs`
- `npm test`
- `npm run check`
- `npm pack --workspaces --dry-run`
- `git diff --check`

## Concerns
- None.
