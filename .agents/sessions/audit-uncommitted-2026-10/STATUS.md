# Audit session: uncommitted-changes coherence audit — 2026-10-23

Scope: all uncommitted changes on branch `feat/polyglot-reaudit-roadmap`
(37 modified + 9 untracked files, ~8.6k insertions). Question: are the changes
coherent and do they break anything?

Method: adapted map-reduce per `agents/patterns/audit-codebase.md` — 7 audit
shards + 2 cross-cutting picker sweeps (consumer breakage, repo consistency),
each writing durable findings to `findings/`; validation executed in parallel
(typecheck, affected test suites, new guards, frozen-lockfile install).

## Validation results (executed, not inferred)

| Check | Result |
|---|---|
| Root typecheck (12 workspaces) | PASS |
| sdk changed-file tests (5 files) | 141/141 PASS |
| cli full suite (`bun run test`, new wrapper) | 3977 pass / 4 fail — 3 text-layout (real, diagnosed in shard-1), 1 yield-gate wall-clock gate (passes in isolation → load flake) |
| scripts suite | 341/342 — 1 fail: types-declaration smoke "this repository satisfies the invariant today" |
| guard:dependency-provenance | PASS (107 releases reconcile, ~50ms, offline) |
| guard:types-declaration | **FAIL (exit 1)** — 61 flagged deps incl. self-typed packages; guard has never been green (HEAD yields 63 violations) |
| bun install --frozen-lockfile --dry-run | PASS |
| Worktree mutation by audit | none (status identical before/after) |

## Coverage matrix

| Domain | Shard IDs | Covered |
|--------|-----------|---------|
| cli text-layout rewrite | shard-1, picker-consumers (area 1) | yes |
| cli input components/chat wiring | shard-2, picker-consumers (area 5) | yes |
| sdk run-terminal-command | shard-3, picker-consumers (area 3) | yes |
| sdk harness-intelligence | shard-4, picker-consumers (area 4) | yes |
| sdk file-change-hooks/concurrency/small tools/run.ts dispatch | shard-5, picker-consumers (areas 2–3) | yes |
| scripts guards + CI workflow + cli test runner | shard-6 | yes |
| manifests + bun.lock + docs + version pins | shard-7, picker-consistency | yes |
| public SDK API surface (index.ts re-exports) | picker-consumers | yes |
| repo-wide consistency (version pins, leftovers, naming, hygiene) | picker-consistency | yes |

## Subsystem enumeration

| Top-level dir | Disposition |
|---|---|
| cli/ | audited (shards 1, 2; picker areas 1, 5) |
| sdk/ | audited (shards 3, 4, 5; picker areas 2–4) |
| common/ | manifest audited (shard 7); no code changes |
| packages/ | manifests audited (shard 7); no code changes |
| scripts/ | audited (shard 6) |
| docs/ | audited (shards 6, 7) |
| .github/ | audited (shard 6, picker-consistency) |
| root files (package.json, bun.lock, .bun-version, knowledge.md, openbuffissues.txt) | audited (shard 7, picker-consistency) |
| evals/ | package.json engines change audited (shard 7); code unchanged — out-of-scope |
| agents/, agents-graveyard/ | out-of-scope (no uncommitted changes) |
| debug/, e2e-traces/, node_modules/, openbuff.d.example/, rust/, scratch-logs/, test/, web/ | out-of-scope (no uncommitted changes) |

## Severity rollup (pre-synthesis)

1 CRITICAL, 7 HIGH, 9 MEDIUM, 24 LOW across 7 shard findings files
+ 2 public-API breaks and 2 hygiene issues from picker sweeps.
Full detail: `findings/*.md`; synthesized report: `AUDIT-REPORT.md`.
