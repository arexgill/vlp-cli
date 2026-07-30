# VLP CLI

VLP CLI is a terminal-first review tool for contract-driven validation of agent-built changes in local Git repositories.

## Install

```bash
VLP_VERSION=0.1.0
curl -fsSL "https://github.com/arexgill/vlp-cli/releases/download/v${VLP_VERSION}/install.sh" | VLP_VERSION="$VLP_VERSION" sh
```

Installer properties:
- macOS and Linux
- no automatic `sudo`
- verifies SHA-256 before install
- defaults to `~/.local/bin/vlp`
- supports `VLP_VERSION` and `VLP_INSTALL_DIR`
- uses `node`, `node20`, or `nodejs` when the resolved runtime is Node 20+

Uninstall:

```bash
sh "${XDG_DATA_HOME:-$HOME/.local/share}/vlp-cli/uninstall.sh"
```

## Terminal-first workflow

```bash
vlp --version
vlp init
vlp contract new sample
# fill in the contract sections, then:
vlp contract confirm sample
vlp review --json > review.json || test $? -eq 3
SESSION_ID=$(node -p "JSON.parse(require('fs').readFileSync('review.json','utf8')).sessionId")
vlp resolve --session "$SESSION_ID" --input decisions.json --json
```

Plain `vlp review` is for interactive terminals. Agent and CI flows should use `--json` plus `vlp resolve`.

## Optional web mode

Browser review is explicit:

```bash
vlp review --web
```

The local web server binds only to `127.0.0.1`. No browser opens unless `--web` is selected.

## Language/runtime support

- JS/TS review is static.
- General Python review uses the host `python3` interpreter only for the packaged AST helper.
- Reviewed Python code is never imported or executed.
- Optional FastAPI runtime enrichment is separate and Docker-bounded.
- Generic Python does not require Docker.

## Privacy and trust boundaries

- reviewed source stays local
- reports use repository-relative paths only
- VLP never edits reviewed source
- localhost web mode is local-only
- Phase 1 keeps `agentReview: "off"`

## Exit codes

- `0`: complete / no corrections required
- `1`: operational failure
- `2`: corrections required
- `3`: unresolved human decisions remain

## Phase 1 limitations

- terminal-first, local/manual review only
- no Vertex calls
- FastAPI runtime support requires explicit config and Docker
- FastAPI runtime support covers app objects, not factories
- standalone release bundles are currently the Node fallback path
