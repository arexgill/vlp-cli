# VLP CLI Product Design

## Product goal

Create `arexgill/vlp-cli`, a public MIT-licensed developer product that augments agent-driven development with explicit behavioral contracts, local static analysis, optional sandboxed runtime contracts, deterministic review state, portable agent guidance, and optional agent-assisted review.

The product is installed as `vlp`, initialized inside an existing project, and usable both directly from a terminal and through supported coding-agent hosts.

## Product principles

- Contract before implementation: every reviewed change has an explicit project artifact describing intended behavior.
- Local and private by default: no remote model call without explicit opt-in or explicit project policy.
- Questions, not correctness claims: findings require policy or human validation.
- Review never edits source: corrections become repair instructions.
- Portable core, native adapters: one authoritative workflow with thin host-specific integrations.
- Safe installation and execution: checksummed releases, no automatic sudo, repository-relative evidence, localhost-only UI, and explicit runtime sandboxes.

## Repository and ownership

Create public repository `https://github.com/arexgill/vlp-cli` with the MIT license. It becomes the product source of truth. The existing `vlp-review` repository remains a research archive and migration source.

Use an npm-workspace monorepo:

```text
packages/core/          contracts, language adapters, mismatch questions, reports
packages/cli/           vlp commands, project config, local server
packages/ui/            embedded local review interface
packages/vertex/        optional ADC Gemini reviewer
adapters/               Pi, Claude, Codex, Gemini, OpenCode
rules/                  AGENTS.md, Cursor, Windsurf, Cline, Copilot variants
skills/                 contract, review, status, help
install/                curl installer and uninstaller
scripts/                release and adapter consistency checks
.github/workflows/      test and release automation
```

## Developer workflow

Installation:

```bash
curl -fsSL https://github.com/arexgill/vlp-cli/releases/download/v0.1.0/install.sh \
  | VLP_VERSION=0.1.0 sh
```

Project setup and use:

```bash
cd my-project
vlp init
vlp contract new checkout-flow
vlp review
vlp status
```

`vlp init` creates:

```text
.vlp/config.json
.vlp/contracts/
.vlp/reviews/
.vlp/.gitignore
```

It detects supported agent hosts and offers non-destructive adapters. It never overwrites an existing agent instruction or settings file without confirmation.

## Contract model

The authoritative intent artifact is `.vlp/contracts/<task>.md`. A contract records task identity, status, behavioral requirements, exclusions, source scope, and optional base/head references.

Host plugins may prefill a draft contract from conversation context when their APIs permit. Auto-captured content remains `draft` until the agent or developer confirms it. Review output always identifies the exact contract revision used.

`vlp review` compares the active contract with the working tree, staged changes, or an explicit Git range. In an interactive terminal it presents concise numbered questions and evidence inline; it does not open a browser. `vlp review --web` explicitly starts and opens the richer localhost UI. `vlp review --json` emits machine-readable output without prompts for agent and CI integrations. Every mode writes machine-readable audit data plus a repair-ready Markdown report when decisions are complete.

Stable process exit codes are part of the product contract:

- `0`: review completed with no corrections required;
- `1`: operational or provider failure;
- `2`: corrections required;
- `3`: unresolved human escalation required.

When stdin/stdout are not interactive, plain `vlp review` fails safely with guidance to choose `--json` or `--web`; it never hangs waiting for invisible input. A JSON review with unresolved questions returns a `sessionId` and exit `3`. Agent adapters submit structured decisions through `vlp resolve --session <id> --input <file-or-stdin> --json`; the CLI validates question identity and evidence server-side before producing final audit/report output.

## Language and runtime support

### JavaScript and TypeScript

Migrate current syntax-directed extraction and bounded discovery for JS, JSX, TS, and TSX.

### General Python

General Python is first-class. Static analysis extracts modules, imports, classes, functions, async functions, signatures, defaults, decorators, type annotations, conditions, calls, returns, yields, raises, and exception handlers.

Python source is never imported or executed. A repository-owned helper uses only Python standard-library AST processing, receives source text through stdin, and requires `python3` only for Python analysis. `vlp doctor` reports this dependency.

### FastAPI

FastAPI is an optional enrichment over general Python. Static route/dependency/model extraction is always safe. Explicit runtime mode may start the selected app only in the Docker sandbox and retrieve only bounded OpenAPI metadata. Generic Python never requires Docker.

## Agent portability

Full command/hook adapters:

- Pi;
- Claude Code;
- Codex;
- Gemini CLI; and
- OpenCode.

Instruction-mode adapters:

- `AGENTS.md`;
- Cursor;
- Windsurf;
- Cline; and
- GitHub Copilot instructions.

Always-on guidance is lightweight: establish or confirm a VLP contract before implementation and run VLP before completion. Explicit commands provide contract, review, status, and help workflows. Agent adapters use `--json` rather than scraping terminal prose; developers opt into `--web` when visual evidence density makes the browser useful.

## Agent reviewer

Default review remains local:

```bash
vlp review
```

Explicit agent review:

```bash
vlp review --agent vertex-gemini
```

Vertex Gemini uses Application Default Credentials, defaults to `global` and `gemini-3.1-pro-preview`, and sends only the active contract plus question-linked excerpts.

Policy is server-owned:

- valid confidence `>= 0.80`: read-only `Correction required` repair entry;
- valid confidence `< 0.80`: human escalation;
- malformed/missing output or provider/auth/network/timeout failure: `Reviewer failed`, no correction.

Project config may enable automatic agent review, but fresh installs do not.

## Distribution

Publish GitHub Release artifacts for:

- macOS arm64/x64 standalone binaries;
- Linux arm64/x64 standalone binaries;
- Node 20+ fallback bundle;
- `SHA256SUMS`; and
- versioned installer/uninstaller scripts.

The curl installer detects platform/architecture, downloads a versioned artifact, verifies SHA-256, and installs `vlp` under `~/.local/bin` by default. It never invokes sudo automatically. `VLP_VERSION` and `VLP_INSTALL_DIR` provide explicit overrides.

Commands include `vlp doctor`, `vlp update`, and `vlp uninstall`.

## Delivery phases

1. Usable vertical slice: repository, migrated core/UI, contracts, JS/TS/general Python/FastAPI, CLI, Node fallback installer, project initialization.
2. Distribution: standalone macOS/Linux binaries, checksums, release CI, update/uninstall.
3. Agent portability: full and instruction-only adapters.
4. Vertex reviewer: explicit ADC provider and confidence policy.

Each phase must be independently installable and dogfooded before the next begins.

## Security boundaries

- Local server binds only to `127.0.0.1`.
- Reviewed source is never modified by VLP.
- Reports contain repository-relative paths only.
- Source and contracts remain local unless remote agent review is explicit.
- Runtime execution requires an explicit adapter and sandbox.
- Installers use checksummed release assets and no unpinned secondary scripts.
- Agent adapters never silently overwrite existing host configuration.

## Product success

The product is useful when a developer can install it from a clean machine, initialize an existing project, establish a contract, review an agent-created diff, understand or resolve each finding, and hand a repair report back to the agent with less effort than an unstructured manual review.
