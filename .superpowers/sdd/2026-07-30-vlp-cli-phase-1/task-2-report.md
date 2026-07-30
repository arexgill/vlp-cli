# Task 2 Report — Migrate the Pure Analysis Core

## Summary

Implemented Task 2 only in `packages/core`:

- migrated the JS/TS-only analysis core from pinned `vlp-review-poc@2258da9f6919fa59fdba016e3fb96c934eedd34d`
- added package exports and Babel parser dependency for `@arexgill/vlp-core`
- created bounded core modules:
  - `packages/core/src/load-input.mjs`
  - `packages/core/src/analyze-source.mjs`
  - `packages/core/src/detect-mismatches.mjs`
  - `packages/core/src/review-contract.mjs`
  - `packages/core/src/build-report.mjs`
  - `packages/core/src/limits.mjs`
  - `packages/core/src/index.mjs`
- migrated package-local tests under `packages/core/test`
- added regressions for:
  - package import/export boundaries
  - absolute-path sanitization in session/report artifacts
  - source nonexecution during discovery
  - central limits: 200 files, 1 MiB/file, 20 questions, 4,000-character responses

Excluded from this task as required:

- Python/FastAPI runtime behavior
- CLI commands
- server/browser behavior
- UI assets

## Requirements checked

- Task brief: `.superpowers/sdd/2026-07-30-vlp-cli-phase-1/task-2-brief.md`
- Migration source: `/Users/alexgill/TAVLIN/agency/vlp-review-poc`
- Source commit inspected only through `git show 2258da9f6919fa59fdba016e3fb96c934eedd34d:<path>`

## Source files inspected from pinned commit

- `src/load-input.mjs`
- `src/analyze-source.mjs`
- `src/detect-mismatches.mjs`
- `src/build-report.mjs`
- `src/create-session.mjs`
- `test/load-input.test.mjs`
- `test/analyze-source.test.mjs`
- `test/detect-mismatches.test.mjs`
- `test/build-report.test.mjs`
- `test/create-session.test.mjs`

## TDD evidence

### 1) First migrated tests exposed package/path assumptions

After adding migrated package-local tests that imported `@arexgill/vlp-core`, I ran:

```bash
node --test packages/core/test/*.test.mjs
```

Initial failure:

- `ERR_MODULE_NOT_FOUND`
- Node tried to resolve `/Users/alexgill/TAVLIN/agency/vlp-cli/.worktrees/phase-1/node_modules/@arexgill/vlp-core/index.js`
- this confirmed the package export boundary was missing before implementation

### 2) Added package boundary and minimal core implementation

Implemented:

- package `main`/`exports` for `@arexgill/vlp-core`
- `index.mjs` public interface
- JS/TS source discovery and bounded limits
- Babel-based JS/TS analyzer
- heuristic question detection
- report builder
- review-session builder

Also added `@babel/parser` and updated `package-lock.json`.

### 3) Second red step exposed root/path handling bug

Re-ran:

```bash
node --test packages/core/test/*.test.mjs
```

New failures showed a migrated path assumption:

- `Error: Path is outside the configured root: .../packages/core/test/fixtures/source-tree/src`
- the initial discovery implementation incorrectly rejected an absolute root directory when `root` itself was scanned

Fix applied:

- separated `ensureWithinRoot()` from file-relative path normalization
- defaulted empty discovery paths to `'.'`
- allowed scanning the configured root while still rejecting paths outside it

### 4) Focused core suite passed after the boundary fix

Re-ran:

```bash
node --test packages/core/test/*.test.mjs
```

Result:

- 14/14 tests passed

### 5) Full root suite exposed fixture execution risk

First full-root run:

```bash
npm test
```

Failure:

- Node `--test` executed JS/TS fixture source files under `packages/core/test/fixtures/...`
- `packages/core/test/fixtures/source-tree/src/poison.js` threw `fixture code must never execute`

Fix applied:

- converted runnable fixture sources to inert `*.txt` fixture data files
- materialized temporary `.js`/`.ts` files during tests
- preserved the nonexecution regression while keeping the root `node --test` sweep clean

### 6) Final focused suite

```bash
node --test packages/core/test/*.test.mjs
```

Result:

- 14/14 tests passed

### 7) Final root suite

```bash
npm test
```

Result:

- 19/19 tests passed
- workspace foundation tests still passed alongside new core tests

### 8) Final workspace check

```bash
npm run check
```

Result:

- `npm test` passed
- `npm pack --workspaces --dry-run` passed
- dry-run package contents for `@arexgill/vlp-core` contained only package metadata plus `src/*`

## Regression coverage added

### Absolute-path regressions

- `packages/core/test/discover-sources.test.mjs`
  - explicit file discovery returns repository-relative paths only
- `packages/core/test/review-contract.test.mjs`
  - serialized session artifacts do not contain the temporary absolute source root
- `packages/core/test/build-report.test.mjs`
  - rendered markdown report does not contain the temporary absolute source root or `/Users/`

### Nonexecution regressions

- `packages/core/test/discover-sources.test.mjs`
  - discovery reads `poison.js` as text
  - `globalThis.__vlpCoreFixtureImported` remains `undefined`
  - fixture code is never imported/evaluated
- root `npm test` now also verifies fixture files are not accidentally runnable test inputs

### Central limits regressions

- `maxSourceFiles = 200`
- `maxSourceFileBytes = 1 MiB`
- `maxQuestions = 20`
- `maxResponseCharacters = 4000`

Covered in:

- `packages/core/test/discover-sources.test.mjs`
- `packages/core/test/detect-questions.test.mjs`
- `packages/core/test/build-report.test.mjs`

## Files added/updated

### Added

- `packages/core/src/analyze-source.mjs`
- `packages/core/src/build-report.mjs`
- `packages/core/src/detect-mismatches.mjs`
- `packages/core/src/index.mjs`
- `packages/core/src/limits.mjs`
- `packages/core/src/load-input.mjs`
- `packages/core/src/review-contract.mjs`
- `packages/core/test/analyze-sources.test.mjs`
- `packages/core/test/build-report.test.mjs`
- `packages/core/test/detect-questions.test.mjs`
- `packages/core/test/discover-sources.test.mjs`
- `packages/core/test/review-contract.test.mjs`
- `packages/core/test/fixtures/source-tree/a.js.txt`
- `packages/core/test/fixtures/source-tree/b.ts.txt`
- `packages/core/test/fixtures/source-tree/ignored.js.txt`
- `packages/core/test/fixtures/source-tree/note.txt`
- `packages/core/test/fixtures/source-tree/poison.js.txt`

### Updated

- `packages/core/package.json`
- `package-lock.json`

## Verification commands run

```bash
node --test packages/core/test/*.test.mjs
npm test
npm run check
```

## Concerns

- No blocking concerns for Task 2.
- The new `reviewContract()` interface intentionally stays JS/TS-core-only and leaves Python/FastAPI/session-persistence expansion to later tasks.
