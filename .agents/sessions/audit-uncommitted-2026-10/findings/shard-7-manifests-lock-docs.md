# Shard 7 — manifests, bun.lock, docs (dependency-hygiene restructuring)

Branch: `feat/polyglot-reaudit-roadmap` (uncommitted working-tree changes)
Files audited: root `package.json`, `bun.lock`, `cli/package.json`, `common/package.json`, `evals/package.json`, `packages/{agent-runtime,code-map,indexer,internal}/package.json`, `scripts/package.json`, `sdk/package.json`, `docs/development.md`, `docs/testing.md`.

Method note: bun.lock is JSONC (trailing commas); reconciliation was scripted — every workspace member's `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies` maps in the lock compared against the on-disk manifest, member by member. Frozen-lockfile behavior was tested empirically under both bun 1.3.5 (CI pin) and 1.3.14 (local): a controlled manifest edit (new dep) triggers `error: lockfile had changes, but lockfile is frozen` even with `--dry-run`, while the current `scripts` section-move does NOT — establishing that the mismatch below is real but not CI-breaking.

---

## Finding 1 — bun.lock `scripts` block is stale: `@ai-sdk/openai-compatible` still in `dependencies`

- **Severity:** MEDIUM
- **Domain:** 2 Correctness / 6 Dependency hygiene (manifest↔lockfile coherence)
- **Where:** `bun.lock:185-190` (scripts workspace entry, `dependencies` at :189) vs `scripts/package.json` `devDependencies` (on-disk: deps = `@codebuff/common` only; devDeps = `@ai-sdk/openai-compatible@^1.0.19`)
- **Risk:** The stated invariant for this changeset — bun.lock workspace entries mirror manifests exactly — is violated for exactly one member. This directly disproves the prior review's "match exactly everywhere" claim (it held for root/:10/:17, common/:89/:100, agent-runtime/:137/:141, sdk/:207/:217 but was never checked for scripts). Practical impact is limited: `bun install --frozen-lockfile --dry-run` passes under bun 1.3.5 and 1.3.14 because bun's staleness check does not flag a deps↔devDeps section move for a private workspace member, so CI does not break. But the next unfrozen `bun install` (any developer adding any dependency anywhere) will rewrite the scripts block and produce a spurious `bun.lock` diff unrelated to their change, and any future bun release that tightens the frozen check would fail CI on this repo.
- **Fix:** Re-run `bun install` (bun 1.3.5) and commit the updated `bun.lock` so the scripts entry lists `@ai-sdk/openai-compatible` under its `devDependencies`. One-line lockfile churn, no manifest change needed.

## Finding 2 — `.bun-version` still `1.3.11` while everything else now pins 1.3.5: release workflows build on a different bun than CI tests

- **Severity:** MEDIUM
- **Domain:** 2 Correctness (engine pin consistency) / 8 contract
- **Where:** `.bun-version:1` (tracked, contains `1.3.11`, untouched by this changeset) vs `package.json` `engines.bun: "1.3.5"` + `packageManager: "bun@1.3.5"` and all 9 member manifests at 1.3.5. Consumers of the stale file: `.github/actions/setup-project/action.yml` (`bun-version-file` defaults to `.bun-version`), used by `cli-release-build.yml`, `cli-release-prod.yml`, `cli-release-staging.yml`, `sdk-release.yml`, `nightly-e2e.yml`. Meanwhile `ci.yml` (x3), `evals.yml`, `nightly-evals.yml`, `buffbench.yml` pin `bun-version: '1.3.5'` explicitly (`ci.yml` was already 1.3.5 at HEAD).
- **Risk:** Split toolchain: CI validates on bun 1.3.5 while all release workflows (binary builds via `cli-release-build.yml`, the published sdk build in `sdk-release.yml`) install and run bun 1.3.11 from `.bun-version`. Binaries are compiled with a bun the test suite never ran under, and `engines`/`packageManager` claim 1.3.5. Note bun does not hard-enforce `engines` (verified: bun 1.3.14 runs `bun install` fine against `engines: "1.3.5"`), so this is not an install failure — it is an untested-toolchain-in-the-release-path risk. The split partially pre-exists (ci.yml was 1.3.5 before this diff), but this changeset is the dependency-pin authority change and left `.bun-version` behind.
- **Fix:** Set `.bun-version` to `1.3.5` (single tracked file, aligns all five release workflows with CI, engines, and packageManager), or pass `bun-version-file: package.json`-derived input if 1.3.11 in releases is intentional — it currently is not justified anywhere.

## Finding 3 — sdk `//devDependencies` comment misstates how declarations reference lodash types

- **Severity:** LOW
- **Domain:** 6 Dependency hygiene / docs accuracy inside manifest
- **Where:** `sdk/package.json` `//devDependencies` ("dist/index.d.ts references the lodash types src/ re-exports, so those typings must resolve from this manifest")
- **Risk:** The premise is inaccurate: `sdk/scripts/build.ts` runs dts-bundle-generator with only `@modelcontextprotocol/sdk` in `importedLibraries` (:113-131), so all other library types — including `@types/lodash` and `@types/ws` — are inlined into `dist/index.d.ts`; the last built `sdk/dist/index.d.ts` (2026-10-22) contains zero external `lodash`/`ws` references (verified by grep of all module specifiers). The placement decision itself is still correct (@types as devDep of the same manifest; consumers don't need @types/lodash), and moving `@types/ws` out of sdk `dependencies` is safe — the only runtime `ws` import (`sdk/src/tools/browser-logs.ts:8`) is internal, `ws` remains a runtime dep and a hardcoded external (`sdk/scripts/build.ts:52`). Caveat: the inspected `dist/` predates the newest src edits, but the `lodash` import in `run.ts` pre-exists (the diff only adds a comment around it), so the conclusion holds.
- **Fix:** Reword the comment to the defensible rationale (typings resolve from the owning manifest for isolated installs / publish builds), dropping the "dist/index.d.ts references" claim, or confirm by rebuilding sdk and re-checking the specifiers.

## Finding 4 — docs/testing.md "matches ci.yml exactly" claim weakened by its own edit

- **Severity:** LOW
- **Domain:** 2 Correctness / docs accuracy
- **Where:** `docs/testing.md:44` (discovery snippet) vs `.github/workflows/ci.yml:241`
- **Risk:** This changeset removed `2>/dev/null` from the documented `find` pipeline while keeping the sentence "This matches the test discovery command in `.github/workflows/ci.yml` exactly" — ci.yml still carries `-print 2>/dev/null | sort | tr '\n' ' '`. Cosmetic: stderr suppression does not change the collected file set, so the documented command is behaviorally identical; but the word "exactly" is now false in a doc whose point is schedule fidelity.
- **Fix:** Restore `2>/dev/null` in the docs snippet or drop "exactly" for "collects the same file set".

## Finding 5 — tracked `knowledge.md` still documents the 1.3.11 pin

- **Severity:** LOW
- **Domain:** 2 Correctness / docs staleness
- **Where:** `knowledge.md:7` ("Bun is pinned to 1.3.11 via `packageManager` in `package.json`")
- **Risk:** Stale tracked note contradicting the new `packageManager: bun@1.3.5` (`cli/knowledge.md`'s mention is a dated historical journal entry and acceptable). No runtime effect.
- **Fix:** Update the line to 1.3.5.

## Finding 6 — scripts `//devDependencies` comment names the wrong importer of `@ai-sdk/openai-compatible`

- **Severity:** LOW
- **Domain:** 6 Dependency hygiene / comment accuracy
- **Where:** `scripts/package.json` `//devDependencies` ("calibrate-openai-tokens.ts and friends import the provider SDK")
- **Risk:** `scripts/calibrate-openai-tokens.ts` imports from `../packages/agent-runtime/src/util/token-counter`, not from `@ai-sdk/openai-compatible`; the sole importer in the package is `scripts/fat-sdk-openrouter-example.ts:6`. The placement decision (devDep for maintainer-only tooling) is correct; only the cited example is wrong, which could send a future reader auditing the wrong file.
- **Fix:** Cite `fat-sdk-openrouter-example.ts` instead.

---

## Verified non-findings (claims that RE-VERIFIED clean)

- **Lockfile reconciliation:** all 13 workspace members compared; only `scripts` mismatched (Finding 1). No lock-only members, no manifest-only members, no version-range mismatches, no peer/optional drift anywhere.
- **Prior review's spot claims re-verified:** root (:10/:17), common (:89/:100), agent-runtime (:137/:141), sdk (:207/:217) — all OK, including sdk `@types/ws` moved into the lock's devDependencies block and `lodash 4.17.23` in both sdk deps maps.
- **Goal (c):** `cli/package.json` declares neither `lodash` nor `@types/lodash`, and bun.lock's cli block carries neither — confirmed.
- **`@types/lodash` version consistency:** `^4.17.21` in all four declaring manifests (root, common, agent-runtime, sdk); runtime `lodash` pinned exact `4.17.23` in all four. Consistent.
- **Runtime-import coverage for lodash:** every importer declares it — `common/src` (project-file-tree, util/object, util/string, util/messages, util/array), `sdk/src/run.ts`, `packages/agent-runtime/src` (7 files); zero lodash imports in `cli/src`, `evals/`, `scripts/`, root-level ts, `agents/`. No gap remains.
- **sdk published-consumer impact (goal 8):** sdk deps diff is `+lodash` (additive) and `-@types/ws` (types-only, never runtime-imported; 0 references in built public d.ts — safe removal that stops force-installing `@types/ws` into every consumer graph). sdk declares `engines: {node: >=20.3.0}` only — the bun pin change does not touch published consumers. `sdk/scripts/build.ts:32-38` confirmed to read `pkg.dependencies` (minus `@codebuff/*`) for externals, exactly as the new `//dependencies` comment claims.
- **Engine pin sweep:** repo-wide grep for `1.3.11` outside node_modules finds only `.bun-version` (Finding 2), `knowledge.md` (Finding 5), untracked/ignored logs (`success.log`, `tmp-windows.log`), a dated `cli/knowledge.md` journal note, and a test fixture string (`cli/src/utils/__tests__/index-workspace-watcher.test.ts:36,45` — data, not a pin). All 9 changed manifests + `packageManager` agree on 1.3.5; `evals.yml`, `nightly-evals.yml`, `buffbench.yml`, `ci.yml` all pin 1.3.5.
- **docs/development.md claims verified against code:** `guard:dependency-provenance` / `guard:types-declaration` exist in `scripts/package.json`; `REGISTRY_ORIGIN` (:116), `LICENSE_ALLOWLIST` (:220), `LICENSE_EXEMPTIONS` (:256), `UNKNOWN` handling, `--refresh` + `npm_config_registry` mirror refusal (:1244-1258) all present in `scripts/dependency-provenance-guard.ts`; `NO_TYPES_PACKAGE` with the `bun`→`@types/bun`/`bun-types` exemption present in `scripts/types-declaration-guard.ts:64`; CI runs the guard (`ci.yml:98,110`) and the tamper check `git diff --exit-code HEAD -- scripts/dependency-provenance.json` (`ci.yml:107`); `check-ci-local.ts` runs Steps I/J for both guards. `dependency-provenance.json` is indeed not in this shard.
- **docs/testing.md claims verified:** `cli/package.json` test = `bun run scripts/run-cli-tests.ts`; the wrapper exists (`cli/scripts/run-cli-tests.ts`, new) with the exact empty-discovery guard `No test files found in cli ...` exit-1 (:108) and node:fs discovery mirroring ci.yml's prunes (`node_modules`, `.git`, `dist`) and `.integration.test.ts` exclusion; pinned by new `cli/src/__tests__/run-cli-tests.test.ts`; `packages/indexer` test is `bun test --isolate` ("adds just --isolate" — accurate); the "all 39 `*.test.tsx` suites" figure matches an actual count of 39; `bunx --bun bun@1.3.5` references agree with the pin.
- **indexer empty `devDependencies: {}`** — cosmetic only; harmless no-op (lock carries no indexer devDeps either).
- **Root `//devDependencies` comment** — phrasing "its own runtime dependencies" is loose (nothing at root imports lodash; zod/canvas/gif-encoder-2 pre-existed), but the structure it documents is exactly what `types-declaration-guard.ts` enforces (runtime dep in `dependencies` ⟺ `@types` sibling in `devDependencies` of the same manifest), and root previously carried lodash as a devDep next to `@types/lodash`, which the new guard's symmetry rule would reject. Informational, no risk, no finding.

## Coverage receipt

| Assigned file | Audited | Note |
| --- | --- | --- |
| `package.json` (root) | YES | lodash devDeps→deps + @types/bun/bun-types 1.3.11→1.3.5 + engines/packageManager 1.3.5 + `//devDependencies` comment; lock block reconciles OK; root comment wording loose but harmless |
| `bun.lock` | YES | Full 13-member scripted reconciliation; single stale entry: scripts `dependencies` still lists `@ai-sdk/openai-compatible` (Finding 1); @types/bun/bun-types/@types/lodash/lodash/@types/ws placements all correct elsewhere |
| `cli/package.json` | YES | test script → wrapper (script exists, behavior verified); engines 1.3.5; correctly free of lodash/@types/lodash in manifest and lock block |
| `common/package.json` | YES | +@types/lodash ^4.17.21 devDep; engines 1.3.5; lodash runtime dep pre-existing; lock OK |
| `evals/package.json` | YES | engines 1.3.5 only; no lodash imports in evals src; lock OK |
| `packages/agent-runtime/package.json` | YES | +@types/lodash devDep + explanatory comment; engines 1.3.5; 7 src files import lodash, dep declared; lock OK |
| `packages/code-map/package.json` | YES | engines 1.3.5 only; lock OK |
| `packages/indexer/package.json` | YES | engines 1.3.5; empty `devDependencies: {}` cosmetic; lock OK |
| `packages/internal/package.json` | YES | engines 1.3.5 only; lock OK |
| `scripts/package.json` | YES | @ai-sdk/openai-compatible →devDeps (placement correct, lock stale — Finding 1; comment names wrong importer — Finding 6); guard scripts exist; engines 1.3.5 |
| `sdk/package.json` | YES | +lodash 4.17.23 deps (additive, import pre-exists); @types/ws→devDeps safe (0 refs in built d.ts); @types/lodash devDep; both comments substantively accurate except Finding 3; lock OK |
| `docs/development.md` | YES | All guard/CI/build-script claims verified against code; no inaccuracies found beyond none in this file |
| `docs/testing.md` | YES | Wrapper script, guard message, indexer --isolate, 39-suite count, bun@1.3.5 all verified; one "exactly" weakened by removed `2>/dev/null` (Finding 4) |

## Lockfile reconciliation table

Every workspace member in bun.lock vs on-disk manifest (dependencies + devDependencies + peerDependencies):

| Workspace member | bun.lock key | Verdict |
| --- | --- | --- |
| openbuff-project (root) | `""` | OK |
| @codebuff/.agents | `.agents` | OK |
| @codebuff/agents | `agents` | OK |
| @codebuff/cli | `cli` | OK |
| @codebuff/common | `common` | OK |
| @codebuff/evals | `evals` | OK |
| @codebuff/agent-runtime | `packages/agent-runtime` | OK |
| @codebuff/build-tools | `packages/build-tools` | OK |
| @codebuff/code-map | `packages/code-map` | OK |
| @codebuff/indexer | `packages/indexer` | OK |
| @codebuff/internal | `packages/internal` | OK |
| @codebuff/scripts | `scripts` | **MISMATCH** — lock `dependencies` carries `@ai-sdk/openai-compatible@^1.0.19`; disk manifest has it in `devDependencies` (Finding 1) |
| @openbuff/sdk | `sdk` | OK |

**Verdict: 12/13 OK, 1 mismatch (scripts).** No lock-only entries, no manifest-only entries.
