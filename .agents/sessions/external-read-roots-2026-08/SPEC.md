# SPEC — Read-only external read roots

## Overview

Openbuff tools are contained to the project root, plus a narrow exception for the
openbuff-owned OS temp namespace (`owned-temp`). Users cannot read files outside
the project — including their own openbuff config directory (logs, harness
state) — even though those are the user's own files and reading them is a
legitimate, non-mutating action.

This work adds a third containment scope, `external-read`: a **read-only**,
**default-closed**, **configure-once** allowlist of roots outside the project
that path-taking READ tools may reach. The write path is structurally excluded.

Wave 1 (the `common` primitive) is COMPLETE, gate-approved, and committed.
Wave 2 (product wiring) is implemented in the working tree but NOT yet green.

## Goals

- A user can read files in their openbuff config dir (e.g. logs, harness state)
  through `read_files` / `read_logs` / `read_image` / `list_directory`.
- A user can allowlist additional absolute roots via `openbuff.json`
  → `readableRoots: string[]`.
- Mandatory-sensitive files stay blocked **inside** allowlisted roots
  (`credentials.json`, `.env`, private keys, kubeconfig, tfstate, …).
- Writes can never reach an allowlisted root, enforced structurally rather than
  by handler discipline.
- Default posture is closed: with nothing configured, behavior is byte-identical
  to before this work.

## Non-goals

- `glob` stays project-only. It is a pattern-driven directory walk; widening it
  would let a pattern enumerate an allowlisted root. Deliberately out of scope.
- No write, move, delete, or `cwd` access to external roots, ever.
- No relative entries in `readableRoots` (ambiguous in a global config file;
  dropped rather than guessed).
- No mid-session reconfiguration. Changing `readableRoots` requires a restart.
- No UI/slash-command surface for managing roots in this iteration.

## Requirements

### R1 — Containment primitive (`common`) — DONE, committed

- `ContainedProjectPath['scope']` is `'project' | 'owned-temp' | 'external-read'`.
- `configureExternalReadRoots(roots)` normalizes/dedupes/sorts; skips filesystem
  roots and `..` entries; idempotent for an equivalent set; THROWS on a
  differing set.
- `ensureExternalReadRootsConfigured(roots)` — non-throwing wrapper returning
  `'configured' | 'unchanged' | 'refused-changed'`.
- `getExternalReadRoots()`, `resetExternalReadRootsForTesting()`,
  `isExternalReadPath(input)`.
- `resolveProjectPathForRead` / `resolveProjectPathForFileSystemRead` — the ONLY
  entry points that can produce `external-read`. They delegate to the existing
  write resolvers first and only fall back to the external branch on `null`.
- `resolveProjectPath` / `resolveProjectPathForFileSystem` are UNCHANGED.
- The external resolver refuses mandatory-sensitive basenames on BOTH the
  lexical and dereferenced path, so consumers inherit the refusal fail-closed.
- `credentials.json` / `.yaml` / `.yml` added to `SENSITIVE_BASENAMES`.

### R2 — Config schema (`sdk/src/provider-config.ts`) — implemented, unverified

- `readableRoots: z.array(z.string().min(1)).default([])`.
- `.default([])` is intentional: downstream code never handles `undefined`.
  Consequence: `readableRoots: string[]` is REQUIRED in the schema OUTPUT type
  and therefore in `LoadedProviderConfig['config']`. This is what breaks the
  hand-built test fixtures (see PLAN task T1).

### R3 — Read-only operation resolvers (`sdk/src/tools/path-utils.ts`) — implemented

- `resolveFilePathForReadOperation`,
  `resolveFilePathForFileSystemReadOperation`.
- Follow-symlink shape only; no `followFinalSymlink: false` (that option exists
  for unlink-style mutations).
- The existing `resolveFilePathFor*Operation` write twins are unchanged.

### R4 — Read handlers rewired — implemented

`read-files.ts` (`authorizeReadTarget`), `read-logs.ts`, `read-image.ts`,
`list-directory.ts`. Plus: `read-files.ts` extends its owned-temp fileFilter
alias block to cover `external-read` (both scopes carry an ABSOLUTE
`relativePath`, so a host filter written against project-relative globs would
silently fail OPEN). Alias key: `external-read/<basename>`.

### R5 — Run-start configuration (`sdk/src/run.ts`) — implemented

In `runOnce`, before tool dispatch: `ensureExternalReadRootsConfigured([...])`
with the openbuff config dir (`getConfigDir(env)`) plus absolute-only entries
from `loadProviderConfigSync().config.readableRoots`. Wrapped in try/catch so a
malformed config cannot block a run. `'refused-changed'` logs a warn naming
counts, not paths (home-dir paths are mildly sensitive and logs get shared).

### R6 — Agent-runtime read backstop (`tool-executor.ts`) — implemented

The pre-dispatch scope check's `ownedTempRead` condition extended so an
allowlisted external READ is not hard-blocked. Writes there still hard-block.

### R7 — Fixtures + validation — BLOCKED (this is the remaining work)

Six typecheck failures, all "missing required `readableRoots`" in hand-built
`LoadedProviderConfig` fixtures. See PLAN task T1 for exact sites.

### R8 — Security review — NOT STARTED

`security-reviewer` on the permission-boundary widening.

### R9 — Documentation — NOT STARTED

`docs/configuration.md` + `openbuff.json.example`.

## Acceptance criteria

- AC1 — `bun run typecheck` exits 0 for all 11 workspace packages.
- AC2 — `bun test sdk/src/__tests__/` reports 0 fail AND 0 error.
- AC3 — `bun test common/src/util/__tests__/` and the agent-runtime tool tests
  report 0 fail.
- AC4 — Test named for the write-path invariant still passes: `resolveProjectPath`
  returns `null` for a path inside a configured allowlisted root.
- AC5 — `credentials.json` inside an allowlisted root is refused by BOTH
  `isExternalReadPath` and the resolver.
- AC6 — With `readableRoots` unset and no config dir on the allowlist, external
  paths are refused exactly as before (default-closed).
- AC7 — Full-directory SDK test run is order-independent: the read-logs external
  suite passes both alone and after a suite that exercises the SDK run path.
- AC8 — `security-reviewer` returns no unresolved BLOCKING finding.
- AC9 — Docs state: reads only, absolute-only entries, sensitive files still
  blocked, restart required to apply changes.

## Relevant files

Committed (wave 1):
- `common/src/util/project-path-containment.ts`
- `common/src/util/sensitive-paths.ts`
- `common/src/util/__tests__/{project-path-containment,sensitive-paths}.test.ts`
- `sdk/src/tools/filesystem-authority.ts` — `toAuthorizedPath` fails closed on
  `external-read` with code `external_read_scope_unsupported`

Dirty (wave 2, in working tree):
- `sdk/src/provider-config.ts`, `sdk/src/run.ts`
- `sdk/src/tools/{path-utils,read-files,read-logs,read-image,list-directory}.ts`
- `packages/agent-runtime/src/tools/tool-executor.ts`
- `sdk/src/__tests__/{path-utils,read-files,read-logs,model-provider}.test.ts`
- `packages/agent-runtime/src/__tests__/run-agent-step-tools.test.ts`
- `common/src/util/project-path-containment.ts` (+ its test) — `ensureExternalReadRootsConfigured`

To touch in T1:
- `sdk/src/__tests__/model-provider.test.ts`
- `sdk/src/impl/__tests__/failover.test.ts`

To touch in T4:
- `docs/configuration.md`, `openbuff.json.example`
