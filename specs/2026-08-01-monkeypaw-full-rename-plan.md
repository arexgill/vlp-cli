# Monkeypaw Full Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every active VLP identity with Monkeypaw, rename the live repository to `arexgill/monkeypaw`, and preserve all existing behavior and safety boundaries.

**Architecture:** Treat the rename as one atomic package/runtime/distribution boundary change, followed by an independent hard-break audit, one explicitly authorized GitHub repository mutation, and final removal of temporary planning artifacts. A tracked identity contract prevents partial renames in source, packages, bundles, installers, and user-facing output.

**Tech Stack:** Node.js 20+ ESM, npm workspaces, `node:test`, shell installers, Python stdlib AST helper, Docker-command fakes, Git, GitHub CLI.

## Global Constraints

- Product name is `Monkeypaw`; repository is `arexgill/monkeypaw`.
- CLI executable is only `monkeypaw`; no compatibility alias.
- Packages are exactly `@monkeypaw/cli`, `@monkeypaw/core`, and `@monkeypaw/ui`.
- Root workspace package is `monkeypaw-workspace`.
- Project state is only `.monkeypaw/`; no legacy discovery, migration, warning, or automatic conversion.
- Environment variables use only the `MONKEYPAW_` prefix.
- Default install data is `~/.local/share/monkeypaw`.
- Release bundle is `monkeypaw-node-v0.1.0.tar.gz`; version remains `0.1.0`.
- Existing review behavior, security limits, nonexecution guarantees, Docker isolation, and exit codes `0`, `1`, `2`, and `3` remain unchanged.
- Do not publish npm packages or create a GitHub Release.
- Do not rewrite Git history.
- The GitHub repository rename is an explicitly authorized live mutation and must not be automatically retried.
- The temporary spec and plan are removed before final integration so the current tracked tree contains no legacy identity.

---

### Task 1: Atomically Rename the Product, Packages, Runtime State, and Distribution

**Files:**
- Create: `test/identity.test.mjs`
- Rename: `packages/cli/bin/vlp.mjs` → `packages/cli/bin/monkeypaw.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/ui/package.json`
- Modify: `packages/cli/src/commands/contract.mjs`
- Modify: `packages/cli/src/json-output.mjs`
- Modify: `packages/cli/src/parse-args.mjs`
- Modify: `packages/cli/src/project.mjs`
- Modify: `packages/cli/src/resolve-input.mjs`
- Modify: `packages/cli/src/review-artifacts.mjs`
- Modify: `packages/cli/src/run.mjs`
- Modify: `packages/cli/src/session-store.mjs`
- Modify: `packages/cli/src/status.mjs`
- Modify: `packages/cli/src/web-server.mjs`
- Modify: `packages/core/src/build-report.mjs`
- Modify: `packages/core/src/config.mjs`
- Modify: `packages/core/src/contracts.mjs`
- Modify: `packages/core/src/decisions.mjs`
- Modify: `packages/core/src/python-analyzer.mjs`
- Modify: `packages/core/src/source-paths.mjs`
- Modify: `packages/ui/public/index.html`
- Modify: `scripts/build-node-bundle.mjs`
- Modify: `install/install.sh`
- Modify: `install/uninstall.sh`
- Modify: `README.md`
- Modify: all test files under `packages/cli/test/`, `packages/core/test/`, `packages/ui/test/`, and `test/` that assert package, command, state, installer, bundle, path, fixture, or branding identity
- Modify: `packages/cli/test-support/run-cli.mjs`
- Modify: `packages/core/test/fixtures/source-tree/poison.js.txt`

**Interfaces:**
- Consumes: existing CLI commands, session schemas, analysis APIs, installer behavior, and version `0.1.0`.
- Produces: `monkeypaw` executable; `@monkeypaw/*` package graph; `.monkeypaw/` state; `MONKEYPAW_*` installer contract; `monkeypaw-node-v0.1.0.tar.gz`.

- [ ] **Step 1: Write the failing tracked-tree identity contract**

Create `test/identity.test.mjs`. Construct forbidden values without embedding them contiguously so the test can scan itself. Temporarily exclude the two approved planning files because they define the transition:

```js
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryPlanningFiles = new Set([
  'specs/2026-08-01-monkeypaw-full-rename-design.md',
  'specs/2026-08-01-monkeypaw-full-rename-plan.md',
]);
const oldLower = String.fromCharCode(118, 108, 112);
const oldUpper = oldLower.toUpperCase();
const forbidden = [
  oldLower,
  oldUpper,
  `.${oldLower}`,
  `${oldLower}-cli`,
  `@arexgill/${oldLower}`,
];

test('tracked product tree contains only the Monkeypaw identity', async () => {
  const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  const files = stdout.toString('utf8').split('\0').filter(Boolean)
    .filter((file) => !temporaryPlanningFiles.has(file));
  const findings = [];

  for (const file of files) {
    const content = await readFile(path.join(root, file));
    const text = content.toString('utf8');
    for (const token of forbidden) {
      if (text.includes(token)) findings.push(`${file}: ${JSON.stringify(token)}`);
    }
  }

  assert.deepEqual(findings, []);
});
```

- [ ] **Step 2: Run the identity test to verify it fails for existing active identifiers**

Run:

```bash
node --test test/identity.test.mjs
```

Expected: FAIL with findings in manifests, source, installers, README, and tests.

- [ ] **Step 3: Rename the package graph and executable**

Use `git mv packages/cli/bin/vlp.mjs packages/cli/bin/monkeypaw.mjs`. Update manifests to these exact identities:

```json
// package.json
{
  "name": "monkeypaw-workspace",
  "version": "0.1.0"
}
```

```json
// packages/cli/package.json identity fields
{
  "name": "@monkeypaw/cli",
  "dependencies": {
    "@monkeypaw/core": "0.1.0",
    "@monkeypaw/ui": "0.1.0"
  },
  "bin": {
    "monkeypaw": "bin/monkeypaw.mjs"
  }
}
```

Set core and UI package names to `@monkeypaw/core` and `@monkeypaw/ui`. Replace every internal source and test import with those package names. Update packed-tarball expectations to `monkeypaw-cli-0.1.0.tgz`, `monkeypaw-core-0.1.0.tgz`, and `monkeypaw-ui-0.1.0.tgz` as emitted for the selected scope.

Regenerate the lockfile:

```bash
npm install --package-lock-only
```

- [ ] **Step 4: Rename runtime state and user-facing identity**

Change exact constants and rendered paths:

```js
export const CONFIG_PATH = '.monkeypaw/config.json';
export const CONTRACTS_DIR = '.monkeypaw/contracts';
const MONKEYPAW_DIR = '.monkeypaw';
const SESSION_DIR = ['.monkeypaw', 'reviews', '.sessions'];
```

Update review/report/audit paths to `.monkeypaw/reviews/`. Update initialized-project messages, help text, status next commands, report heading, browser title/heading, diagnostics, temporary test directories, fixture poison globals, and command examples to Monkeypaw. The first line of `helpText()` must identify the executable as `monkeypaw`.

Do not change session IDs, decision-envelope schemas, confidence behavior, analysis heuristics, bounds, or exit codes.

- [ ] **Step 5: Rename installer, bundle, and repository references**

Use these exact shell identities:

```sh
REPO_NAME=monkeypaw
INSTALL_DIR=${MONKEYPAW_INSTALL_DIR:-$HOME/.local/bin}
DATA_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/monkeypaw
ASSET_NAME=monkeypaw-node-v${VERSION}.tar.gz
BIN_LINK=${INSTALL_DIR}/monkeypaw
```

Rename all release environment variables to `MONKEYPAW_*`, all temporary prefixes to `monkeypaw-*`, all extracted and generation paths to Monkeypaw, and installer/uninstaller output to Monkeypaw. Keep checksum, atomic symlink switch, rollback, smoke, no-sudo, and ownership checks unchanged.

Update `scripts/build-node-bundle.mjs` so:

```js
const shimPath = path.join(bundleRoot, 'bin', 'monkeypaw');
const bundleName = `monkeypaw-node-v${version}`;
```

The shim must execute `node_modules/@monkeypaw/cli/bin/monkeypaw.mjs`. Update README install URLs to `arexgill/monkeypaw`, commands to `monkeypaw`, and uninstall data paths to `monkeypaw`.

- [ ] **Step 6: Update behavioral tests without weakening assertions**

Update all existing tests to the new exact identity. Preserve the same assertions for:

- terminal, JSON, resolve, and web parity;
- JS/TS and general Python nonexecution;
- explicit Docker-isolated FastAPI behavior;
- session authority, path containment, size bounds, and redaction;
- report and artifact atomicity;
- installer checksum, generation rollback, no-sudo, and uninstall ownership;
- package and installed-layout contents.

Do not delete a behavioral assertion merely because it contains the old identity; translate it to Monkeypaw.

- [ ] **Step 7: Run focused rename tests**

Run:

```bash
node --test test/identity.test.mjs test/workspace.test.mjs test/install.test.mjs \
  packages/cli/test/cli.test.mjs packages/cli/test/project.test.mjs \
  packages/cli/test/session-store.test.mjs packages/cli/test/web-review.test.mjs \
  packages/core/test/config.test.mjs packages/core/test/contracts.test.mjs \
  packages/core/test/build-report.test.mjs packages/ui/test/web-app.test.mjs
```

Expected: PASS with no legacy finding outside the temporary planning files.

- [ ] **Step 8: Run the complete package verification**

Run:

```bash
npm ci
npm run check
bash -n install/install.sh install/uninstall.sh
git diff --check
```

Expected: all tests pass, workspace dry-run packages are `@monkeypaw/*`, and shell syntax is valid.

- [ ] **Step 9: Commit the atomic in-repository rename**

```bash
git add -A
git commit -m "feat: rename product to Monkeypaw"
```

---

### Task 2: Prove the Hard Break and Installed Monkeypaw Artifact

**Files:**
- Modify: `test/identity.test.mjs`
- Modify: `test/install.test.mjs`
- Modify: `packages/cli/test/project.test.mjs`
- Modify: `packages/cli/test/cli.test.mjs`

**Interfaces:**
- Consumes: `monkeypaw` command, `.monkeypaw/` state, `@monkeypaw/*` package graph, Monkeypaw bundle/installer from Task 1.
- Produces: regression proof that old state and environment names receive no compatibility behavior and installed artifacts contain only Monkeypaw identity.

- [ ] **Step 1: Write failing hard-break tests**

In `packages/cli/test/project.test.mjs`, construct the old hidden directory name from character codes and create only that directory in a fixture Git repository. Assert `status` returns operational exit `1`, creates no `.monkeypaw/`, and does not mutate the old directory.

In `test/install.test.mjs`, construct old environment-variable names without embedding them and set them to sentinel values. Assert the installer uses only `MONKEYPAW_VERSION`, `MONKEYPAW_INSTALL_DIR`, and Monkeypaw release endpoints. Assert the resulting temporary home contains `bin/monkeypaw`, contains no old executable link, and uses `share/monkeypaw` only.

Add bundle assertions:

```js
assert(entries.includes('monkeypaw-node-v0.1.0/bin/monkeypaw'));
assert(entries.includes('monkeypaw-node-v0.1.0/node_modules/@monkeypaw/cli/scripts/collect-openapi.py'));
assert(entries.includes('monkeypaw-node-v0.1.0/node_modules/@monkeypaw/core/scripts/extract-python.py'));
assert(entries.includes('monkeypaw-node-v0.1.0/node_modules/@monkeypaw/ui/public/index.html'));
```

- [ ] **Step 2: Run the focused tests to verify any missing hard-break behavior fails**

Run:

```bash
node --test packages/cli/test/project.test.mjs test/install.test.mjs test/identity.test.mjs
```

Expected: FAIL if any compatibility alias, old data path, old environment variable, package path, bundle path, or executable remains.

- [ ] **Step 3: Make the minimum corrections required by the hard-break tests**

Remove any remaining compatibility behavior. Do not add migration detection or warnings. Ensure installer ownership checks and uninstaller deletion remain constrained to the Monkeypaw data directory and executable link.

- [ ] **Step 4: Build and execute the standalone bundle in a temporary directory**

Run:

```bash
TMP_DIR=$(mktemp -d)
node scripts/build-node-bundle.mjs --output-dir "$TMP_DIR/dist"
node scripts/generate-checksums.mjs "$TMP_DIR/dist"
tar -xzf "$TMP_DIR/dist/monkeypaw-node-v0.1.0.tar.gz" -C "$TMP_DIR"
"$TMP_DIR/monkeypaw-node-v0.1.0/bin/monkeypaw" --version
rm -rf "$TMP_DIR"
```

Expected output: `0.1.0`.

- [ ] **Step 5: Dogfood project initialization and state isolation**

Run in a temporary Git repository:

```bash
REPO_ROOT=$PWD
TMP_PROJECT=$(mktemp -d)
git -C "$TMP_PROJECT" init
(
  cd "$TMP_PROJECT"
  node "$REPO_ROOT/packages/cli/bin/monkeypaw.mjs" init
  test -f .monkeypaw/config.json
  test ! -e .vlp
)
rm -rf "$TMP_PROJECT"
```

The final `test ! -e` command is an operator-side check and must not be copied as a contiguous legacy string into tracked source.

- [ ] **Step 6: Run complete regression verification**

```bash
npm run check
bash -n install/install.sh install/uninstall.sh
git diff --check
```

Expected: all tests and package dry-runs pass.

- [ ] **Step 7: Commit hard-break verification**

```bash
git add test/identity.test.mjs test/install.test.mjs \
  packages/cli/test/project.test.mjs packages/cli/test/cli.test.mjs \
  install packages scripts package.json package-lock.json README.md
git commit -m "test: enforce Monkeypaw identity boundary"
```

---

### Task 3: Rename the Live GitHub Repository and Verify Origin

**Files:**
- No tracked source changes are expected.
- External mutation: GitHub repository `arexgill/vlp-cli` → `arexgill/monkeypaw`.
- Local Git configuration: `origin` URL.

**Interfaces:**
- Consumes: clean, fully verified `rename/monkeypaw` branch from Tasks 1–2 and authenticated `gh` access.
- Produces: live `arexgill/monkeypaw` repository and local origin `https://github.com/arexgill/monkeypaw.git`.

- [ ] **Step 1: Verify clean branch and authentication**

```bash
git status --short
gh auth status
gh api repos/arexgill/vlp-cli --jq .full_name
```

Expected: clean status, authenticated as the repository owner, and `arexgill/vlp-cli` exists.

- [ ] **Step 2: Verify the destination does not already exist**

```bash
if gh api repos/arexgill/monkeypaw >/dev/null 2>&1; then
  echo "Destination repository already exists" >&2
  exit 1
fi
```

Expected: command continues because the destination is absent. If it exists, stop for human resolution; do not delete or overwrite it.

- [ ] **Step 3: Rename the repository exactly once**

```bash
gh api --method PATCH repos/arexgill/vlp-cli -f name=monkeypaw --jq .full_name
```

Expected output: `arexgill/monkeypaw`. Do not automatically retry a failed live mutation.

- [ ] **Step 4: Update and verify local origin**

```bash
git remote set-url origin https://github.com/arexgill/monkeypaw.git
test "$(git remote get-url origin)" = "https://github.com/arexgill/monkeypaw.git"
gh api repos/arexgill/monkeypaw --jq .full_name
git ls-remote origin HEAD
```

Expected: all commands resolve the renamed repository.

- [ ] **Step 5: Push the verified rename branch to the renamed repository**

```bash
git push -u origin rename/monkeypaw
```

Expected: branch is available on `arexgill/monkeypaw`. Do not publish a package or release.

---

### Task 4: Remove Temporary Planning Artifacts and Enforce a Zero-Legacy Current Tree

**Files:**
- Delete: `specs/2026-08-01-monkeypaw-full-rename-design.md`
- Delete: `specs/2026-08-01-monkeypaw-full-rename-plan.md`
- Modify: `test/identity.test.mjs`

**Interfaces:**
- Consumes: renamed code and live repository from Tasks 1–3.
- Produces: current tracked tree with no temporary transition documents and no legacy identity exclusions.

- [ ] **Step 1: Tighten the identity test before deleting planning files**

Remove `temporaryPlanningFiles` and its `.filter(...)` call from `test/identity.test.mjs`, so every tracked file is scanned.

- [ ] **Step 2: Run the tightened test and verify it fails only on the temporary spec and plan**

```bash
node --test test/identity.test.mjs
```

Expected: FAIL with findings only in the two files under `specs/`.

- [ ] **Step 3: Delete the temporary planning files**

```bash
git rm specs/2026-08-01-monkeypaw-full-rename-design.md \
  specs/2026-08-01-monkeypaw-full-rename-plan.md
```

- [ ] **Step 4: Run final full verification**

```bash
npm ci
npm run check
bash -n install/install.sh install/uninstall.sh
git diff --check
test "$(git remote get-url origin)" = "https://github.com/arexgill/monkeypaw.git"
git status --short
```

Inspect the final status output before commit: only the intended identity-test edit and two planning deletions may be present. Expected test result: all tests pass and all package dry-runs use `@monkeypaw/*`.

- [ ] **Step 5: Commit the final current-tree cleanup**

```bash
git add -A
git commit -m "chore: remove rename planning artifacts"
```

- [ ] **Step 6: Prove the committed tree and renamed remote are clean**

```bash
node --test test/identity.test.mjs
git status --short
git ls-tree -r --name-only HEAD | grep '^specs/' && exit 1 || true
gh api repos/arexgill/monkeypaw --jq .full_name
git push
```

Expected: identity test passes, status is clean, no tracked `specs/` files remain, repository is `arexgill/monkeypaw`, and the final branch is pushed without publishing artifacts.

---

## Final Review and Integration Gate

After Task 4:

1. Run a whole-implementation review from commit `4318679` through the final rename commit.
2. Verify package imports, CLI behavior, `.monkeypaw/` state, installed bundle contents, installer rollback/uninstall, repository URLs, and zero-legacy identity scan.
3. Fix all Critical and Important findings before integration.
4. Run fresh `npm ci && npm run check`, shell syntax checks, standalone bundle execution, secret scan, `git diff --check`, and clean-status verification.
5. Use `superpowers:finishing-a-development-branch` for the human-selected merge/PR path. Do not rewrite history or publish packages/releases.
