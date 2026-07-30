# VLP CLI Phase 1 Design

## Goal

Deliver the first installable `vlp` vertical slice in the new public `arexgill/vlp-cli` repository. A developer must be able to install the Node fallback bundle with curl, initialize an existing repository, create/confirm a contract, review local changes directly in the terminal, and obtain a repair report. A browser remains an explicit richer review option.

Standalone binaries, deep native host hooks, and Vertex review are later phases. Phase 1 establishes interfaces they will consume.

## Repository bootstrap

Create a public GitHub repository named `vlp-cli` under `arexgill`, initialized locally with:

- MIT `LICENSE`;
- Node 20+ `.nvmrc`/engine declaration;
- npm workspaces;
- CI for macOS and Linux;
- contribution/security documentation;
- no copied Git history or private artifacts from `vlp-review`.

Migrate code with attribution in commit/release notes. Preserve existing safe VLP tests while reorganizing source into packages.

## Phase 1 packages

```text
packages/core/     no HTTP/UI concerns; contracts, input, language analysis, questions, reports
packages/cli/      argument parsing, project initialization, Git scope, terminal renderer, localhost server, commands
packages/ui/       optional static browser assets embedded/distributed with CLI
install/           checksummed Node fallback installer and uninstaller
fixtures/          JS/TS, general Python, and FastAPI project fixtures
```

Use public interfaces rather than cross-package private imports.

## Commands

### `vlp init`

- Requires a Git worktree/repository.
- Creates `.vlp/config.json`, `.vlp/contracts/`, `.vlp/reviews/`, and `.vlp/.gitignore`.
- Is idempotent.
- Detects existing `AGENTS.md`/host files and reports available adapters without changing them in Phase 1.

### `vlp contract new <name>`

Creates `.vlp/contracts/<slug>.md` with front matter:

```yaml
id: <slug>
status: draft
created: <ISO date>
scope: working-tree
```

and sections for intent, acceptance criteria, exclusions, and context. Reject unsafe names/path traversal and existing files unless `--force` is explicitly supplied.

### `vlp contract confirm <name>`

Validates required sections and changes `status` from `draft` to `confirmed`. Review refuses to treat drafts as authoritative.

### `vlp review`

- Selects `--contract <name>` or the sole confirmed active contract.
- Defaults to the working-tree diff against `HEAD`; supports `--staged` and `--base <ref>`.
- Discovers only changed supported source files within configured limits.
- Runs core static analysis and creates deterministic questions.
- In an interactive TTY, presents numbered questions, source/contract evidence, and Accept behavior / Correct intent / Not relevant choices inline.
- `--web` explicitly starts and opens the localhost browser UI; the browser is never opened by default.
- `--json` emits a stable machine-readable review envelope with no prompts for agents and CI.
- Plain review in a non-TTY fails safely and tells the caller to select `--json` or `--web`.
- Writes `.vlp/reviews/<session>.json` plus a Markdown repair report after decisions.
- Never edits reviewed source.
- Exits `0` for completed/no corrections, `1` for operational failure, `2` when corrections are required, and `3` when human escalation remains unresolved.

### `vlp resolve`

`vlp resolve --session <id> --input <file-or-stdin> --json` accepts structured decisions for a prior JSON review. It validates session identity, known question IDs, one decision per question, allowed decision values, required correction text, and size limits. It never accepts source evidence or effective question content from the caller. On success it writes final audit/report output and returns exit `0` or `2`; incomplete valid decisions retain exit `3`.

### `vlp status`

Reports installation version, repository root, active contract, changed supported files, latest review status, optional dependency availability, and safe next command.

### `vlp doctor`

Checks Node, Git, Python availability for Python projects, and Docker only when FastAPI runtime is configured. It exposes no credential values.

## Project configuration

`.vlp/config.json` schema:

```json
{
  "version": 1,
  "source": {
    "include": ["**/*"],
    "exclude": ["node_modules", ".git", "dist", "build", "coverage", ".venv", "venv"]
  },
  "runtime": null,
  "agentReview": "off"
}
```

Phase 1 accepts `runtime: null` or a FastAPI object with explicit app target. `agentReview` is reserved and must remain `off` in Phase 1.

## Language analysis

### JS/TS

Migrate the existing Babel-based analyzer and bounded deterministic source discovery.

### General Python

Generalize the repository-owned Python AST helper so route extraction is optional rather than the only output. Emit syntax-directed documentation units for module/class/function structure, signatures, decorators, annotations, conditions, calls, returns/yields, raises, and exception handling.

The Node adapter resolves the exact packaged helper path, sends source text through stdin, bounds output, and verifies a strict stdlib import allowlist. It never imports target modules.

### FastAPI

Retain static route contracts. Runtime OpenAPI collection remains explicit through project configuration and Docker. Use independent dependency-build/runtime/cleanup deadlines and safe diagnostics. Generic Python analysis remains available if Docker is absent.

## Review model

Phase 1 is local/manual. Questions remain heuristic and severity ordered. The terminal is the default reviewer and records Accept behavior, Correct intent, and Not relevant decisions. The optional browser presents the same normalized questions and decisions. Review state belongs to the CLI/core boundary; neither terminal input nor browser payloads can forge source evidence or question identity.

The JSON envelope and exit codes are versioned interfaces. The later agent-reviewer package and host adapters consume them without scraping prose or altering Phase 1 report semantics.

## Installer

Phase 1 publishes a versioned Node fallback tarball containing packages, UI assets, Python helper, lockfile metadata, license, and a shim.

`install/install.sh`:

- supports macOS/Linux;
- requires Node 20+ and curl or wget;
- selects a release version through `VLP_VERSION` or latest GitHub release;
- downloads tarball plus checksum from GitHub Releases;
- verifies checksum using available platform tools;
- installs under `${XDG_DATA_HOME:-$HOME/.local/share}/vlp-cli/<version>`;
- atomically links `${VLP_INSTALL_DIR:-$HOME/.local/bin}/vlp`;
- uses no sudo;
- cleans temporary files on failure.

An uninstall script removes only VLP-owned paths and does not remove project `.vlp/` data.

## Tests

- Core contract parsing/validation and safe slug behavior.
- Git working-tree/staged/base scope selection using fixture repositories.
- Idempotent initialization and non-overwrite guarantees.
- JS/TS regression suite migrated from `vlp-review`.
- General Python extraction and target-nonexecution tests.
- FastAPI static/runtime fake-boundary tests.
- Terminal renderer/input validation, non-TTY failure, JSON envelope, resolve-input trust boundary, and exact exit-code tests.
- Server-owned question/report validation and optional browser UI contract tests.
- Installer test in a temporary HOME using a local fake release endpoint and checksum corruption case.
- End-to-end Node fallback smoke test on macOS and Linux CI.

No automated test calls Vertex or executes a fixture application on the host.

## Acceptance criteria

From a clean temporary home with Node 20+:

```bash
curl -fsSL <versioned installer URL> | sh
vlp --version
cd <fixture git repository>
vlp init
vlp contract new sample
vlp contract confirm sample
vlp review --json
```

must install safely, create only documented project files, analyze supported changed source, emit the versioned JSON envelope with a session ID, use exit `3` when questions need decisions, and avoid opening a browser. The acceptance flow then submits fixture decisions through `vlp resolve --session <id> --input <file> --json` and verifies final report/exit behavior. A separate `vlp review --web` test must bind only to `127.0.0.1` and exercise the optional visual flow.

The same commands must work for JS/TS and general Python fixtures. FastAPI adds route analysis and either bounded OpenAPI evidence or a safe runtime diagnostic.
