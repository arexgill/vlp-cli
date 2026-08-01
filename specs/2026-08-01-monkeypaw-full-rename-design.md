# Monkeypaw Full Rename Design

**Date:** 2026-08-01  
**Status:** Approved design, pending implementation plan

## Goal

Rename the VLP CLI product completely to Monkeypaw while preserving its existing behavior, safety properties, and version `0.1.0`.

The live GitHub repository will become `arexgill/monkeypaw`. The current Git tree will contain no active VLP identity. Existing Git history will not be rewritten.

## Identity Boundary

Monkeypaw is the only supported identity after this change:

| Surface | New identity |
|---|---|
| Product | Monkeypaw |
| GitHub repository | `arexgill/monkeypaw` |
| CLI executable | `monkeypaw` |
| CLI package | `@monkeypaw/cli` |
| Core package | `@monkeypaw/core` |
| UI package | `@monkeypaw/ui` |
| Root workspace | `monkeypaw-workspace` |
| Project state | `.monkeypaw/` |
| Default install data | `~/.local/share/monkeypaw` |
| Bundle | `monkeypaw-node-v0.1.0.tar.gz` |
| Environment prefix | `MONKEYPAW_` |

The installer will use `MONKEYPAW_VERSION`, `MONKEYPAW_INSTALL_DIR`, `MONKEYPAW_RELEASE_BASE_URL`, and `MONKEYPAW_RELEASE_API_URL`.

## Compatibility Policy

This is an intentional hard break:

- no `vlp` executable alias;
- no `.vlp/` discovery or migration;
- no legacy package names or exports;
- no legacy environment variables;
- no automatic migration or compatibility warning.

Users must manually rename existing `.vlp/` directories to `.monkeypaw/` before using Monkeypaw. Monkeypaw will otherwise treat those repositories as uninitialized.

## Components

### Workspace and packages

All manifests, package-lock entries, workspace dependencies, imports, package exports, package tarball expectations, and installed-layout tests will use the `@monkeypaw/*` names. The executable entry point will become `packages/cli/bin/monkeypaw.mjs`, and the CLI package will expose only the `monkeypaw` binary.

### Project state and reports

Config, contracts, review sessions, reports, audit files, temporary files, and ignore templates will move from `.vlp/` to `.monkeypaw/`. Session schemas, decision envelopes, report contents, limits, and exit codes will not otherwise change.

Reviewer-facing output will say Monkeypaw, including help, status, doctor, report headings, web UI titles, initialization messages, and operational errors.

### Installer and bundle

The release bundle, checksum files, extracted directory, temporary install paths, generation directories, stable executable link, uninstall script, and ownership checks will use Monkeypaw names. Existing checksum verification, no-sudo behavior, atomic generation switching, smoke checks, rollback, and ownership-safe uninstall semantics remain unchanged.

The default release endpoints will target `arexgill/monkeypaw`. No npm package or GitHub Release will be published during implementation.

### Repository rename

Code changes will be implemented and verified in an isolated branch. After the current tree passes all rename and regression checks, the authenticated GitHub repository will be renamed from `arexgill/vlp-cli` to `arexgill/monkeypaw`. The local `origin` URL will then be updated and verified before pushing the completed branch or merged result.

GitHub's redirect for the old repository URL may exist, but the current tracked tree must not rely on it.

## Error Handling and Safety

The rename must not weaken existing boundaries:

- reviewed source remains local and is never imported or executed;
- generic Python still invokes only the packaged stdlib AST helper through host `python3`;
- FastAPI runtime remains explicit and Docker-isolated;
- sessions and decisions remain server-owned and bounded;
- path, symlink, artifact, and installer validation remains intact;
- exit codes remain `0`, `1`, `2`, and `3` with their existing meanings.

A partial rename is a build failure. Internal imports must resolve only through declared `@monkeypaw/*` dependencies, and installed artifacts must not reference old package, command, state, repository, or environment names. This temporary design specification contains the legacy names needed to define the transition, so implementation will remove it before the final tracked-tree identity scan and integration.

## Testing and Acceptance

Implementation follows test-driven development. Rename-contract tests will fail first against the current VLP identity and then pass after each boundary is converted.

Acceptance requires:

1. all existing behavioral tests pass under Monkeypaw names;
2. package dry-runs emit only `@monkeypaw/*` packages and the `monkeypaw` binary;
3. the fallback bundle contains the UI, Python helper, FastAPI helper, and `bin/monkeypaw`;
4. offline install, reinstall, rollback, and uninstall tests use Monkeypaw paths and variables;
5. JS/TS, general Python, FastAPI fake-runtime, terminal, JSON, resolve, and web tests remain green;
6. a tracked-tree scan, excluding Git metadata and dependencies, finds no `VLP`, `vlp`, `vlp-cli`, `.vlp`, or `@arexgill/vlp` identifiers;
7. the live repository is `arexgill/monkeypaw` and local `origin` points to it;
8. no package, release, or other external artifact is published.

## Non-goals

- rewriting Git history;
- compatibility aliases or automatic migration;
- publishing npm packages;
- creating a GitHub Release;
- changing analysis heuristics, review workflows, security limits, or UI behavior beyond naming.
