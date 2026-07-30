# VLP CLI Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create public `arexgill/vlp-cli` and deliver a curl-installable, terminal-first VLP vertical slice for contract-driven JS/TS and Python review, with optional FastAPI runtime evidence.

**Architecture:** Bootstrap an npm-workspace product repository, migrate the pinned safe analysis engine from `vlp-review`, and separate pure core behavior from CLI, terminal, browser, and installer concerns. Review sessions persist server-owned evidence locally so terminal, JSON, resolve, and optional web modes share one trust boundary.

**Tech Stack:** Node.js 20+ ESM, npm workspaces, Babel parser, Python stdlib AST helper, Docker CLI for explicit FastAPI runtime, native Node test runner, GitHub Actions.

## Global Constraints

- New repository is public `arexgill/vlp-cli`, MIT licensed, and contains no copied private artifacts or old Git history.
- Migration source is pinned to `arexgill/vlp-review@2258da9f6919fa59fdba016e3fb96c934eedd34d`.
- Terminal review is default; browser opens only with `--web`; agents/CI use `--json` and `vlp resolve`.
- Exit codes are exact: `0` complete/no corrections, `1` operational failure, `2` corrections required, `3` unresolved human decisions.
- Local web mode binds only to `127.0.0.1`.
- VLP never edits reviewed source and reports only repository-relative paths.
- Python source is parsed through the packaged stdlib AST helper and is never imported/executed.
- Generic Python needs no Docker; FastAPI runtime is explicit and Docker-isolated.
- Phase 1 performs no Vertex calls and keeps `agentReview: "off"`.
- Installer never uses sudo, verifies SHA-256, and modifies only VLP-owned install paths.

---

## Bootstrap: Create the Product Repository

This bootstrap is performed once before Task 1 review tracking begins.

- [ ] Create public GitHub repository:

```bash
gh repo create arexgill/vlp-cli --public --description "Contract-driven validation for agent-built software" --clone
```

- [ ] Move the clone to `/Users/alexgill/TAVLIN/agency/vlp-cli` if `gh` cloned elsewhere.
- [ ] Copy the approved specs and this plan into:

```text
docs/superpowers/specs/2026-07-30-vlp-cli-product-design.md
docs/superpowers/specs/2026-07-30-vlp-cli-phase-1-design.md
docs/superpowers/plans/2026-07-30-vlp-cli-phase-1.md
```

- [ ] Commit the planning baseline before implementation:

```bash
git add docs/superpowers
git commit -m "docs: define VLP CLI product and phase one"
git push -u origin main
```

### Task 1: Repository and Workspace Foundation

**Files:**
- Create: `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `LICENSE`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`
- Create: `packages/core/package.json`, `packages/cli/package.json`, `packages/ui/package.json`
- Create: `.github/workflows/test.yml`
- Test: `test/workspace.test.mjs`

**Interfaces:**
- Root scripts: `npm test`, `npm run check`, `npm pack --workspaces --dry-run`.
- CLI package exposes executable `vlp` from `packages/cli/bin/vlp.mjs`.

- [ ] Write a failing workspace test that asserts package names, private root, Node `>=20`, MIT license, CLI bin mapping, and no undeclared workspace private imports.
- [ ] Run `node --test test/workspace.test.mjs`; expect missing package files.
- [ ] Create the minimal npm workspace:

```json
{
  "name": "vlp-cli-workspace",
  "private": true,
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node --test",
    "check": "npm test && npm pack --workspaces --dry-run"
  }
}
```

- [ ] Add macOS/Linux CI on Node 20 and 22, running `npm ci` and `npm run check`.
- [ ] Run `npm install`, focused test, and `npm run check`; expect success.
- [ ] Commit: `chore: bootstrap VLP CLI workspace`.

### Task 2: Migrate the Pure Analysis Core

**Files:**
- Create under `packages/core/src/`: `load-input.mjs`, `analyze-source.mjs`, `detect-mismatches.mjs`, `review-contract.mjs`, `build-report.mjs`, `limits.mjs`, `index.mjs`
- Create: `packages/core/test/*.test.mjs`, `packages/core/test/fixtures/*`
- Modify: `packages/core/package.json`, root lockfile

**Interfaces:**
- `discoverSources({ root, paths, languageMode, limits }) -> Promise<SourceFile[]>`.
- `analyzeSources(sources, options) -> Promise<AnalysisResult>`.
- `detectQuestions({ contract, analysis, runtimeEvidence }) -> Question[]`.
- `buildReport({ contract, session, decisions }) -> string`.

- [ ] Copy only relevant source/tests from pinned `vlp-review` commit into package-local paths, retaining attribution in commit notes.
- [ ] First run migrated tests and record failures caused by path/package assumptions.
- [ ] Remove HTTP/browser/absolute-path assumptions from core; centralize exact limits: 200 files, 1 MiB/file, 20 questions, 4,000-character response.
- [ ] Add explicit tests that report/session artifacts never contain fixture absolute paths and source files are never imported/evaluated.
- [ ] Run core tests plus root suite; expect pass.
- [ ] Commit: `feat(core): migrate bounded VLP analysis engine`.

### Task 3: Contracts, Project Configuration, and Initialization

**Files:**
- Create: `packages/core/src/contracts.mjs`, `packages/core/src/config.mjs`
- Create: `packages/cli/src/project.mjs`, `packages/cli/src/commands/init.mjs`, `packages/cli/src/commands/contract.mjs`
- Create tests under both packages.

**Interfaces:**
- `initializeProject(root) -> InitResult`.
- `createContract(root, name, { force, clock }) -> ContractRecord`.
- `confirmContract(root, name) -> ContractRecord`.
- `loadConfig(root) -> ConfigV1`.

- [ ] Add failing tests for non-Git rejection, idempotent init, exact `.vlp/` tree, safe slug/path traversal rejection, no overwrite without `--force`, and required-section confirmation.
- [ ] Implement config version 1 exactly as specified, rejecting unknown top-level values that alter trust boundaries.
- [ ] Create contract front matter and sections using deterministic newline/content formatting.
- [ ] Ensure `.vlp/.gitignore` ignores transient session/cache files but does not ignore confirmed contracts or final Markdown reports.
- [ ] Run focused and root tests; expect pass.
- [ ] Commit: `feat: add VLP project contracts and initialization`.

### Task 4: Git Scope and Persistent Review Sessions

**Files:**
- Create: `packages/cli/src/git-scope.mjs`, `packages/cli/src/session-store.mjs`
- Create: `packages/core/src/session.mjs`, `packages/core/src/decisions.mjs`
- Create fixture-Git tests.

**Interfaces:**
- `selectChangedFiles(root, { staged, base }) -> Promise<string[]>`.
- `createReviewSession(input) -> ReviewSession` with versioned `sessionId`.
- `saveSession(root, session)` / `loadSession(root, id)`.
- `applyDecisions(session, submitted) -> ResolvedSession`.

- [ ] Test working tree, staged, deleted/renamed, explicit base, invalid ref, path outside root, and deterministic ordering.
- [ ] Store sessions under `.vlp/reviews/.sessions/` with atomic write/rename and mode `0600` where supported.
- [ ] Validate submitted decisions: known session/question IDs, no duplicates, enum values, correction text required/capped, and caller cannot replace evidence/question text.
- [ ] Test repository-relative persisted evidence and malformed/corrupt session failure.
- [ ] Run focused and root suites; commit: `feat: add Git-scoped review sessions`.

### Task 5: Terminal, JSON, Resolve, and Exit-Code CLI

**Files:**
- Create: `packages/cli/bin/vlp.mjs`
- Create: `packages/cli/src/parse-args.mjs`, `packages/cli/src/run.mjs`, `packages/cli/src/terminal-review.mjs`, `packages/cli/src/json-output.mjs`
- Create CLI tests.

**Interfaces:**
- Commands: `init`, `contract new`, `contract confirm`, `review`, `resolve`, `status`, `doctor`, `--version`, `--help`.
- JSON envelope has `{ schemaVersion: 1, command, status, sessionId, contract, questions, reportPath, error }`.

- [ ] Add failing spawn tests for command parsing, TTY/default mode selection through injected streams, non-TTY safe failure, JSON schema, stdin/file resolve input, and exact exit codes.
- [ ] Implement terminal question loop with numbered evidence, single-key/line decisions, correction prompt, review summary, and abort without partial final report.
- [ ] Implement `review --json`: unresolved questions emit session envelope and exit `3`.
- [ ] Implement `resolve --session <id> --input <path|-> --json`, returning `0`, `2`, or `3` according to validated effective decisions.
- [ ] Implement `status` and redacted `doctor`; no environment values in output.
- [ ] Run CLI and root tests; commit: `feat(cli): add terminal-first contract review`.

### Task 6: First-Class General Python Analysis

**Files:**
- Create: `packages/core/scripts/extract-python.py`
- Create: `packages/core/src/python-analyzer.mjs`
- Create: `packages/core/test/python-analyzer.test.mjs`, Python fixtures

**Interfaces:**
- Helper stdin: `{ files: [{ path, source }] }`.
- Helper stdout: `{ units, diagnostics, frameworkHints }`.

- [ ] Write failing fixtures/tests for modules, imports, classes, sync/async functions, signatures/defaults/decorators/annotations, conditions, calls, returns/yields, raise, try/except, and one invalid file among valid files.
- [ ] Implement helper using only `ast`, `json`, and `sys`; never import target code.
- [ ] Node adapter invokes the exact resolved packaged helper, bounds stdin/stdout, maps safe errors, and confirms Python availability via `doctor` only when needed.
- [ ] Add source-level security test that parses helper imports and forbids `exec`, `eval`, `compile`, `importlib`, `__import__`, subprocess, filesystem/network modules, and target imports.
- [ ] Run Python/core/root tests; commit: `feat(core): add general Python static analysis`.

### Task 7: FastAPI Static and Optional Runtime Enrichment

**Files:**
- Create: `packages/core/src/fastapi-contracts.mjs`
- Create: `packages/cli/src/fastapi-runtime.mjs`, packaged `collect-openapi.py`
- Create FastAPI fixtures/tests.

**Interfaces:**
- Static Python `frameworkHints.fastapiRoutes` feeds normalized route contracts.
- `collectFastApiOpenApi({ root, appTarget, runDocker }) -> { openapi, diagnostic }`.

- [ ] Migrate and strengthen nested router-prefix, dependency, method/path/status/model, missing route, and cycle tests.
- [ ] Implement runtime sandbox: read-only source, no credentials/home/socket mounts, network-disabled run, CPU/memory/PID limits, bounded output.
- [ ] Use independent exact deadlines: build `600000`, runtime `30000`, cleanup `5000` ms.
- [ ] Build from requirements-only input with explicit networked dependency phase; never copy project source into build context.
- [ ] Generic Python continues when Docker/runtime fails; diagnostics are stable/redacted.
- [ ] Run fake-Docker and full tests only; commit: `feat: enrich Python review with FastAPI contracts`.

### Task 8: Optional Web Review

**Files:**
- Create: `packages/ui/public/*`
- Create: `packages/cli/src/web-server.mjs`, `packages/cli/src/commands/web-review.mjs`
- Create UI/server tests.

**Interfaces:**
- `vlp review --web` uses the same session/decision interfaces as terminal/JSON.
- Endpoints: sanitized `GET /api/session`, validated `POST /api/resolve`, allowlisted static assets.

- [ ] Migrate the existing UI and local server from the pinned research source.
- [ ] Add tests for `127.0.0.1`, CSP/no-store, static allowlist, request-size cap, source non-fetchability, decision trust boundary, and no default browser open.
- [ ] Make `--web` explicitly open browser unless `--no-open` accompanies `--web`; reject `--no-open` without `--web`.
- [ ] Ensure browser and terminal reports are byte-equivalent for identical decisions.
- [ ] Run tests and render-check responsive UI; commit: `feat(ui): add optional localhost review`.

### Task 9: Node Fallback Installer and End-to-End Release Candidate

**Files:**
- Create: `install/install.sh`, `install/uninstall.sh`
- Create: `scripts/build-node-bundle.mjs`, `scripts/generate-checksums.mjs`
- Create installer/E2E tests, update README and release workflow.

**Interfaces:**
- Release artifacts: `vlp-cli-node-v${VERSION}.tar.gz`, matching `.sha256`, installer/uninstaller, where `VERSION` is read from root `package.json`.

- [ ] Build deterministic Node fallback bundle containing workspace runtime packages, UI, Python helper, license, and executable shim.
- [ ] Test installer in temporary HOME against a local HTTP fixture: success, corrupted checksum, unsupported Node, interrupted download, custom version/install dir, reinstall/atomic switch, uninstall ownership.
- [ ] Add macOS/Linux CI smoke flow:

```bash
vlp --version
vlp init
vlp contract new sample
vlp contract confirm sample
vlp review --json > review.json || test $? -eq 3
SESSION_ID=$(node -p "JSON.parse(require('fs').readFileSync('review.json','utf8')).sessionId")
vlp resolve --session "$SESSION_ID" --input decisions.json --json
```

- [ ] Document terminal-first workflow, explicit web mode, general Python dependency, FastAPI Docker boundary, privacy, exit codes, uninstall, and Phase 1 limitations.
- [ ] Dogfood the installed bundle against a local JS/TS fixture and a Python fixture; retain safe reports as CI artifacts.
- [ ] Run `npm run check`, package/credential scan, shell syntax check, and `git diff --check`.
- [ ] Commit: `feat: ship curl-installable VLP CLI phase one`.

## Final Verification

Before the first release or merge:

```bash
npm ci
npm run check
bash -n install/install.sh install/uninstall.sh
git diff --check
```

Perform a clean temporary-home install from local release artifacts, run the acceptance flow, verify no browser opens by default, and confirm the optional web server binds only to `127.0.0.1`.
