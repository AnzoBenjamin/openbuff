# Audit findings: r6b-cli-deps

- Subsystems: cli
- Features: cli-dependency-manifest, vendored-ripgrep-provenance, terminal-image-protocols, markdown-rendering-helpers, turn-snapshots-git-plumbing, index-directory-watch-worker, dev-dependency-isolation
- Files covered: 9
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [MEDIUM] dependency-hygiene — cli/package.json:37 — @gravity-ai/api declared but never imported anywhere in cli
- **Risk:** A third-party runtime dependency (^0.1.2, caret range) is installed and bundled into every CLI build but is imported by zero source files (code_search across cli/ for 'gravity-ai' matches only package.json:37). Dead dependencies enlarge the supply-chain attack surface and install footprint, and a package that is never imported is never exercised by typecheck or tests, so a compromised or broken release would ship silently.
- **Fix:** Remove @gravity-ai/api from cli/package.json dependencies, or if it is reserved for imminent use (e.g. provider integration), gate it behind the PR that introduces the first import and pin it to an exact version.
- **Evidence:** cli/package.json line 37 declares "@gravity-ai/api": "^0.1.2"; code_search pattern 'gravity-ai' over cwd cli returns only package.json:37 — no import, require, or dynamic import anywhere under cli/src or cli/scripts.

## [MEDIUM] dependency-hygiene — cli/package.json:48 — posthog-node declared but never imported in cli
- **Risk:** posthog-node ^5.8.0 (a server-side analytics SDK) is declared in runtime dependencies but has zero importers in cli/src (code_search for 'posthog-node' over cli matches only package.json:48; analytics.go(es) through @codebuff/common/analytics-core instead). An unused server analytics SDK is dead weight in the shipped binary and an unreviewed third-party code path that nothing tests.
- **Fix:** Remove posthog-node from cli/package.json, or wire the intended direct usage and add an import-level test; if the common package needs it, move the declaration to the workspace package that actually imports it.
- **Evidence:** cli/package.json line 48 declares "posthog-node": "^5.8.0"; code_search patterns 'posthog-node' over cli and cli/src return only the package.json declaration; cli/src/utils/analytics.ts imports analytics from '@codebuff/common/analytics-core', not posthog-node.

## [LOW] dependency-hygiene — cli/package.json:53 — yoga-layout declared without any direct import (probable transitive pin)
- **Risk:** yoga-layout ^3.2.1 is declared but no cli/src file imports it (code_search 'yoga-layout' over cli matches only package.json:53). Undeclared intent — direct dependency vs. deliberate transitive pin for @opentui/core's layout engine — means a future @opentui/core bump can silently desynchronize the pinned yoga version, or the entry can linger after opentui stops needing it.
- **Fix:** If it is a transitive pin, keep it but document the reason in a comment/overrides block (e.g. packageManager overrides) and record which @opentui/core version justifies it; otherwise remove it and let @opentui/core declare its own yoga-layout range.
- **Evidence:** cli/package.json line 53 declares "yoga-layout": "^3.2.1"; code_search for 'yoga-layout' across the whole cli tree returns only the declaration; @opentui/core imports in cli/src (e.g. cli/src/index.tsx:18) never reference yoga-layout directly.

## [LOW] dependency-hygiene — cli/package.json:35 — Caret ranges on all external runtime deps while engines pins exact bun 1.3.11
- **Risk:** Every non-workspace runtime dependency uses ^ ranges (@opentui/core 0.5.12 is exact but jimp ^1.6.0, zod ^4.2.1, immer ^10.1.3, react 19.2.0 etc. mix exact and caret). Minor-version drift across contributor machines and CI can change behavior (jimp 1.x minor releases have changed API surface; zod 4 is still young), and the CLI ships as a compiled Bun binary where a drifted transitive tree is frozen into the artifact without re-verification.
- **Fix:** Commit and enforce a lockfile check in CI (bun install --frozen-lockfile) and/or tighten the high-churn runtime deps (jimp, zod, @tanstack/react-query) to exact or ~ ranges consistent with how @opentui/core is pinned.
- **Evidence:** cli/package.json lines 35-56: dependencies mix exact (@opentui/core "0.5.12", react "19.2.0", pino "9.4.0") with caret ranges (jimp "^1.6.0", zod "^4.2.1", immer "^10.1.3", @tanstack/react-query "^5.90.12"); engines pins "bun": "1.3.11" exactly; no lockfile-verification step appears in the scripts block (lines 12-21).

## [LOW] dependency-hygiene — cli/src/native/ripgrep.ts:58 — Vendored ripgrep digest verification fails OPEN for paths missing from RG_SHA256
- **Risk:** verifyRipgrepDigest returns true (skip with warning) when embeddedRgPath has no entry in RG_SHA256 — both for the documented UNPINNED sentinel and, critically, for any genuinely unknown path. The suffix-matching fallback (endsWith after stripping '../') means a newly vendored platform binary in sdk/dist/vendor/ripgrep that the RG_SHA256 map was not updated for is extracted and executed with zero integrity verification, only a log line. All five currently vendored binaries are pinned (lines 15-26), so today's map is complete, but the fail-open default makes provenance checking opt-out rather than opt-in for future additions.
- **Fix:** Invert the default for the compiled path: treat an unresolvable embeddedRgPath as a verification failure (fall back to getBundledRgPath()) instead of returning true, or keep the sentinel path but log at error level and emit a release-checklist assertion in scripts/build-binary.ts that every vendored rg artifact has a pinned digest.
- **Evidence:** cli/src/native/ripgrep.ts lines 48-73: digest lookup falls back to Object.entries(RG_SHA256).find(...endsWith...) then 'if (digest === undefined) { logger.warn(...); return true }'; lines 68-73 also return true for the UNPINNED sentinel. The five entries at lines 15-26 carry real sha256 digests, so the skip branch is only reachable for a future unlisted artifact.

## [LOW] dependency-hygiene — cli/src/utils/turn-snapshots.ts:60 — Undeclared external toolchain dependencies: system git and chmod assumed on PATH
- **Risk:** The snapshot/bisect pipeline shells out to the system 'git' binary (defaultRunGit, execFileAsync('git', ...) at line 60) and cli/src/native/ripgrep.ts shells out to 'chmod' (spawnSync(['chmod','+x',...]) in the Unix branch). Neither is a package dependency, and neither is probed or surfaced at startup; on machines without git on PATH every snapshot call burns a 15s-timeouts execFile failure per turn and resolves to {status:'unavailable'}, which is silent unless logTurnSnapshotFailure warns. This is graceful degradation, not a crash, but the toolchain requirement is undocumented and unverified.
- **Fix:** Document the git>=2.x (for 'git replace --graft' used by pruneTurnSnapshots) and chmod runtime requirements in cli/README.md, and add a one-shot capability probe at startup that flips turn-snapshot features off (and logs once) when git is absent, instead of paying a per-turn failed spawn.
- **Evidence:** cli/src/utils/turn-snapshots.ts lines 60-68: defaultRunGit = execFileAsync('git', args, {timeout: 15_000}); line ~410: default test command 'bun test' via execFileAsync(argv[0], ...) — an external bun assumption as well; cli/src/native/ripgrep.ts lines ~205-215: spawnSync(['chmod', '+x', tmpOutPath]) with exitCode checked but binary presence only implied by PATH.

## [LOW] dependency-hygiene — cli/src/utils/index-dir-watch.ts:22 — Duplicated IGNORED_TOP_LEVEL constant is a deliberate, documented copy — drift risk only
- **Risk:** IGNORED_TOP_LEVEL (lines 22-34) re-declares the same set as cli/src/utils/index-workspace-watcher.ts instead of importing it, to break a circular dependency (documented in the comment). The duplication is intentional and correctly scoped (top-level-only semantics), but any future ignore-list change must be made in two places; a one-sided edit makes the Linux+Bun worker pool and the recursive watcher disagree about which top-level directories are watched, silently missing index-change events for newly ignored dirs.
- **Fix:** Extract IGNORED_TOP_LEVEL into a leaf module (e.g. cli/src/utils/index-watch-shared.ts) that both files import, eliminating the cycle without the copy; or add a unit test asserting the two constants are structurally equal so drift fails CI.
- **Evidence:** cli/src/utils/index-dir-watch.ts lines 20-34: comment 'Mirrors IGNORED_TOP_LEVEL in index-workspace-watcher.ts. Re-declared locally instead of imported to avoid a circular module dependency'; the Set contents match index-workspace-watcher.ts today (verified by read of this file; watcher file referenced by cli/src/utils/index-workspace-watcher.ts:4 imports from '@codebuff/indexer').

## [LOW] dependency-hygiene — cli/src/utils/terminal-images.ts:9 — No dependency findings in terminal-images.ts and markdown-renderer.tsx (confirmation, not defect)
- **Risk:** No defect: terminal-images.ts imports only './env', '../types/env', and uses Node Buffer (line ~78) — the Jimp dependency is NOT used here (it lives in cli/src/utils/image-handler.ts:13 and cli/src/utils/image-thumbnail.ts:6, both declared and consistent). markdown-renderer.tsx has zero external imports (rendering delegated to @opentui/core's MarkdownRenderable per its docblock), so no drift between the retained helpers and the rendering pipeline's dependency set.
- **Fix:** No action needed for these two files. Optionally update the terminal-images.ts header comment so future readers do not expect image decoding/Jimp in this module (the sixel branch at 'renderInlineImage' explicitly returns null and defers to metadata display).
- **Evidence:** cli/src/utils/terminal-images.ts lines 8-9: imports are getCliEnv (local) and type CliEnv (local); only builtin Buffer usage. cli/src/utils/markdown-renderer.tsx lines 1-33: no import statements at all. code_search 'from "jimp"' over cli/src: image-handler.ts:13, image-thumbnail.ts:6, and test image-dimensions.test.ts:7 only.

## [LOW] dependency-hygiene — cli/package.json:58 — Dev-only deps correctly confined to test code; no production leakage (confirmation, not defect)
- **Risk:** No defect: the devDependencies (react-dom 19.2.0, @types/react, @types/react-dom, strip-ansi ^7.1.2) are imported exclusively from test files — react-dom/server from cli/src/**/__tests__/*.test.tsx (31 sites) and strip-ansi from cli/src/__tests__/tmux-poc.ts:16, integration-tmux.test.ts:5, e2e-cli.test.ts:5. No src/ production file imports a dev-only package, so the CLI runtime bundle carries none of them. Note the runtime ANSI-stripping path uses @codebuff/common's stripAnsi (cli/src/polyfills/bun-strip-ansi.ts:1), so there is no duplicated dependency concern either.
- **Fix:** No action required. If bundle-size paranoia is desired, add a lint rule (e.g. eslint no-restricted-imports) blocking devDependencies from non-test src/ files to keep this invariant enforced.
- **Evidence:** code_search 'from \'strip-ansi\'' over cli/src: only ./__tests__/tmux-poc.ts:16, ./__tests__/integration-tmux.test.ts:5, ./__tests__/e2e-cli.test.ts:5. code_search 'from \'react-dom' over cli/src: 31 matches, all under __tests__ directories. cli/src/polyfills/bun-strip-ansi.ts:1 imports { stripAnsi } from '@codebuff/common/util/string'.

## Coverage receipt

### Subsystems
- cli

### Features
- cli-dependency-manifest
- vendored-ripgrep-provenance
- terminal-image-protocols
- markdown-rendering-helpers
- turn-snapshots-git-plumbing
- index-directory-watch-worker
- dev-dependency-isolation

### Files
- cli/package.json
- cli/src/native/ripgrep.ts
- cli/src/utils/terminal-images.ts
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/turn-snapshots.ts
- cli/src/utils/index-dir-watch.ts
- cli/src/utils/image-handler.ts
- cli/src/utils/image-thumbnail.ts
- cli/src/polyfills/bun-strip-ansi.ts

### Domains
- dependency-hygiene
- security
- correctness
- state-mutation
- error-handling
- performance
- test-coverage
- api-contract
