# Lessons — review-gate correctness & convergence

Companion to `PLAN.md` (design) and `STATUS.md` (progress). This file holds decisions and gotchas that outlived the slice that produced them.

## Decision record: T1.4d — embedder guide fallback

**Status: implemented** as the hybrid below, with recovery keyed PER POINTER. `common/src/util/guides.ts` owns the guide→body tables and detection; one `ON_DEMAND_GUIDE_FALLBACK_<GUIDE>` placeholder per relocated guide in `packages/agent-runtime/src/templates/{types,strings}.ts` is the provider surface; base2 appends, after its pointers, exactly the placeholders whose pointers that mode actually emitted. The record is kept in full because the two rejected framings are the ones a future reader will reach for first.

Source: `architect` specialist, run against the working tree at `v3:4a19a075615be`. `PLAN.md` framed T1.4d as a choice between (A) gate the disclosure default to workspaces containing `agents/guides/`, (B) have `disclose()` emit the pointer plus an inline section copy when the guide is unreachable, or (C) keep the compact degrade clause only. **Both A and B are wrong as framed, and the defect is more severe than "open follow-up" implied.**

### The defect is worse than described

`PLAN.md` says the pointer read "fails" in an embedder workspace. The stronger finding: the advertised read contract is **unsatisfiable by construction**, and no published artifact ships the guides.

- `cli/release/package.json` and `cli/release-staging/package.json` publish only `index.js`, `http.js`, `postinstall.js`, `README.md`. `sdk/package.json` publishes only `dist`, `README.md`, `CHANGELOG.md`. `cli/scripts/build-binary.ts` copies native libs and wasm only — no `agents/guides` copy step.
- Path rewriting cannot rescue it: `normalizeToolPath` (`packages/agent-runtime/src/tools/handlers/tool/write-file.ts`) rejects absolute and drive-relative paths and enforces project-relative, so a pointer cannot be redirected at a package-root guide directory. Content injection is the only delivery mechanism short of adding the guides to a published `files` list.
- The same defect exists independently of base2: `packages/agent-runtime/src/system-prompt/prompts.ts` emits an `agents/guides/knowledge-files.md` pointer from the runtime package.

### Why option A cannot work at the layer PLAN.md implies

Not merely because prompt assembly is synchronous. `cli/scripts/prebuild-agents.ts` imports every module under `agents/` and `JSON.stringify`s the **resolved** definitions into `cli/src/agents/bundled-agents.generated.ts` at CLI build time — inside the openbuff worktree. `cli/package.json` wires that into the build and `cli/src/utils/local-agent-registry.ts` consumes the bundle in the shipped CLI. So any `createBase2`-layer probe is frozen at build time and would resolve "guides present" for **every** embedder: a guaranteed false negative, independent of the sync/async question.

### Why option B cannot ship as authored text

`agents/__tests__/base2-progressive-disclosure.test.ts` measures `authoredSurface` (systemPrompt + instructionsPrompt + stepPrompt) **before** placeholder injection and asserts `(off - on) / off >= 0.25`. The disclosed/explicit-off delta _is_ the six section bodies, so inlining them as authored text destroys the acceptance metric it was created to protect.

### Recommended: hybrid C + runtime placeholder

Keep today's authored surface (compact pointer + "If that guide is unavailable" clause) and recover full bodies through an **additive** runtime placeholder whose provider does the detection.

- **Detection belongs in** `packages/agent-runtime/src/templates/strings.ts` `toInject` — async-capable, filesystem-capable, keyed on the embedder's `fileContext.projectRoot`. `PATTERNS_INDEX` (with `common/src/util/patterns.ts`) and `FRONTEND_SECTION` are exact precedents, including the collapse-to-empty-string behavior.
- **Single-sourcing:** re-home the six section bodies into `common/` and re-export them unchanged from `agents/base2/quality-prompt-section.ts`. Re-export rather than copy: it keeps `qualitySection` byte-identical under `quality-prompt-snapshot.test.ts` and keeps `review-rubric-parity.test.ts` the single drift owner. `agent-runtime` must not import from `agents/` (`packages/agent-runtime/src/util/base2-tool-tiers.ts` documents this), which is why the bodies move rather than being imported.
- **Shape:** add `ON_DEMAND_GUIDE_FALLBACK` to `placeholderNames` (`packages/agent-runtime/src/templates/types.ts`); in `common/src/util/guides.ts` expose `GUIDE_FALLBACK_SECTIONS`, `findMissingGuides(projectRoot, logger)`, `formatGuideFallbackSections({ missing })` returning `''` when nothing is missing.
- **Additive, never a replacement.** If the placeholder replaces `guideSections` instead of following it, the pointer-presence assertions and the >=25% metric both become **vacuous rather than preserved**. The provider must return `''` in-repo so the resolved in-repo prompt stays byte-identical to today.
- **Keep every degrade clause verbatim.** It is unverified that all embedder entry points (notably SDK-direct consumers of the bundled definitions) run `injectPlaceholders`, so the compact inline clause remains the last line of defense.

### Metric consequence

The >=25% authored reduction survives byte-for-byte, because `authoredSurface` is measured pre-injection and a placeholder is a short marker. But that metric is then **structurally blind** to resolved-prompt regrowth in embedder workspaces. Add (do not replace) a resolved-surface budget: inject against both the repo root and a synthetic guide-less temp root, and assert the guide-less resolved surface is no larger than the resolved explicit-off surface.

### Falsifying test

Inject placeholders for `createBase2('default')` against a temp root with no `agents/guides/` and assert every relocated body appears in the resolved prompt; inject against the repo root and assert no body appears and the >=25% reduction still holds. Derive the section list from `GUIDE_POINTERS` so the loop cannot pass vacuously.

### Unknowns the architect could not close

- Exact token counts per option (requires running `countTokens`).
- Whether every embedder entry point runs `injectPlaceholders` — only the `strings.ts` provider table was inspected. **Still open**, which is why every pointer keeps its compact degrade clause as the last line of defense.
- Whether any publish pipeline outside `cli/release*`, `sdk/package.json`, and `build-binary.ts` copies `agents/guides/*.md`. Evidence is strongly negative but not exhaustive.

### What implementation added to the record

- The re-home is a **move plus re-export**, not a copy: `agents/base2/quality-prompt-section.ts` now re-exports the six bodies from `common/src/constants/prompt-sections.ts`, so `qualitySection` stays byte-identical under `quality-prompt-snapshot.test.ts` and every existing consumer import path is unchanged. `gateAwarenessSection` deliberately did NOT move — it is not relocatable to a guide, so it has no fallback body.
- `findMissingGuides` returns `[]` for a falsy or non-string `projectRoot`. "Unknown root" must not mean "everything is missing", or every prompt formatted without a real root regrows by six full sections.
- The resolved-surface budget the architect asked for landed as its own case: inject against a guide-less temp root and against the repo root, and compare against the resolved explicit-off surface. The pre-injection >=25% authored metric is structurally blind to embedder-workspace regrowth, so it was kept AND supplemented rather than replaced.
- `GUIDE_FALLBACK_SECTIONS` is keyed by plain `string`, not base2's `GuidePath` union — `common/` cannot import from `agents/`. The two drift-guard assertions comparing pointer paths to table keys therefore need `String(guide)` widening; comparing the narrower union to `string[]` has no matching `toEqual` overload and fails typecheck rather than at runtime.

### Recovery must mirror the mode's exclusions (review repair)

The first implementation emitted ONE `ON_DEMAND_GUIDE_FALLBACK` placeholder whose provider re-inlined all six bodies. That is wrong for two mode-specific reasons, both found in review:

- **Plan mode omits git-discipline deliberately** (`!planOnly && disclose(GUIDE_PATHS.gitDiscipline)`, pinned by `base2-progressive-disclosure.test.ts`). An all-six recovery handed a guide-less embedder commit/push guidance back in a read-only mode. Fix: one placeholder per pointer (`GuidePointerRow.fallbackPlaceholder`), emitted from the same `buildArray` entry that emits the pointer, so an omitted pointer omits its recovery by construction.
- **The broad-audit body is clause-parameterized.** Plan mode's pointer tail says "do not implement", so recovering `buildBroadAuditSection('proceed to implementation or the answer')` there produced directly contradictory finalize instructions. Fix: `BROAD_AUDIT_FALLBACK_SECTIONS` keyed by `BroadAuditFinalizeClause`, plus a plan-clause placeholder base2 substitutes in plan mode. `GUIDE_FALLBACK_SECTIONS` keeps the implementation variant as the table default because that is what the guide file documents.

Two further consequences of the same review:

- **Recovered bodies are recorded in the shared `ContextBudgetLedger`** (`applyMeasure`, category `systemPrompt`, label `guide-fallback:<guide>`), the way `getProjectFileTreePrompt`/`getGitChangesPrompt` do. They are the largest block this path adds, so an unrecorded block silently under-counts an embedder's context budget. A collapsed (in-repo) block records nothing, which is what keeps the ledger honest.
- **`findMissingGuides` has no try/catch and no `logger`.** `fs.existsSync` reports a failed probe as `false` instead of throwing and `path.join` only ever sees the type-guarded root plus a literal table key, so the guard was unreachable dead code with an unreachable `logger?.warn` inside it.

The filesystem probe is memoized once per formatted prompt: six providers now ask the same question, and each one runs only when its placeholder is present in the prompt.

### Scope note

This is cross-package (`common/`, `packages/agent-runtime/`, `agents/`, plus a new test), unlike every other Tier 1 item which stayed inside `agents/`. Schedule it as its own slice rather than bundling it with the reviewer-loop work.

## Gotchas worth carrying forward

**An advisory channel is only real once it has a display surface on every path that persists it.** The first advisory slice wrote `receipt.advisories` from all three reviewer families but rendered them only on the gate-pass `<gate-state>` block, so intermediate `NON_BLOCKING` receipts and every security/specialist receipt stored advisories invisibly. Review caught the prompt/behavior mismatch ("shown to the user" vs shown only on pass). Two valid fixes exist — narrow the claim or add the surfaces — and they are not equivalent: adding surfaces is the one that keeps the reviewer's mental model true.

**Advisory display on the aux-pass paths must be conditional on a non-empty list.** `base2.test.ts` and `gate-lifecycle.e2e.test.ts` advance the generator yield by yield, so an unconditional `add_message` on a passing security or specialist gate shifts every subsequent expectation and fails as a confusing off-by-one yield mismatch rather than as "a new message appeared".

**On the blocker/repair path there is no receipt to read yet.** `recordSuccessfulReviewReceipt` runs only once a finalization verdict exists, so that surface must read `collectReviewerAdvisories(reviewerToolResult)` directly. Using the shared collector (rather than a second inline `result.advisories` read) is what keeps the displayed semantics identical to the persisted ones.

**Reconstructed inline helpers need their whole closure.** `base2.test.ts` rebuilds `formatGateStateBlock` with `extractInlineFunctionSource` + `new Function`. Extracting the advisory bounding into a shared `boundAdvisoryLines` helper broke that test at call time until the helper was added to the reconstruction list — the typecheck cannot see it, because the reconstruction is string-based. Any new inline helper called by an already-reconstructed one must be added to the same list.

**Sanitize before the bounds check, and collapse whitespace before stripping controls.** In `formatGateStateBlock` and the CLI's `parseGateStateAdvisories`, collapsing `\s+` first turns tabs/newlines into spaces; stripping `/[\x00-\x1f\x7f]/` first would delete them and glue words together. Applying the 240-char cap after the strip is what makes the bound describe the text actually emitted. On the parse side, sanitizing after the emptiness check would let a controls-only entry pass as non-empty.

**T1.5's id-keying only bites when the reviewer supplies an id.** Minted `RF-<n>-<hash>` ids embed the blocker's position in the round's list, so identical text at a different index yields a different id. They are deliberately excluded from `::id:` keying. Consequence for T1.2(c): the round ledger must instruct **verbatim** re-raise text regardless of ids, because bare-string findings still condone on `(class, text)`.

**The condone/merge logic cannot import from `gate-reviewer.ts`.** It lives inside the serialized `handleSteps` generator (`.toString()` + `new Function(...)`), so module-scope closures are unavailable at reconstruction time. Any change is duplicated by hand into the `<gate-helpers-generated>` region; `scripts/generate-gate-helpers.ts` is the source of truth and the parity tests enforce it. Always re-run `--check` after touching `base2.ts`.

**`lastPinnedStateMessage` is an invalidation sentinel, not a history.** `markActiveWorkStateChanged` resets it to `''` on every gate-state write. Any "did this change since last time" comparison must use a separate emitted-value baseline (`lastEmittedPinnedStateMessage`) or the branch is dead. This exact mistake shipped once and was caught by review.

**A reviewer "crash" is not always a code defect.** Four of this session's gate stalls were a provider switch, a user interrupt, a provider billing error (`预扣费额度失败`, insufficient prepaid credit), and a transient `Unable to connect` whose provider host answered HTTP 200 on a probe moments later. None warranted a bypass. Read the crash detail — and probe the host — before proposing `BYPASS REVIEWER`.

**A stable review bundle is worth more than an extra slice of progress.** After a specialist crash, the correct move is to end the turn without editing: any edit moves the worktree and invalidates the bundle the specialist must attest against, re-triggering the same snapshot-mismatch refresh that preceded the crash.

**Do not hand mutating git commands to a subagent.** A basher spawn ran `git stash push --include-untracked` despite an explicit read-only instruction, reverting the entire uncommitted working set; recovery was `git stash apply stash@{0}`. It also produced a misleading test failure (`Unable to find inline stripReviewerVerdictPrefix declaration`) because the test file reconstructs helpers from a `base2.ts` that had just been reverted. Use `git show HEAD:<path>` or the read tools for historical comparison instead.

**`.base2-test-scratch` has a pre-existing cleanup race.** Two `base2.test.ts` cases can `mkdtemp` into the shared scratch root after `afterAll` removes it, producing `ENOENT` as an unhandled-between-tests error with 0 failures. Predates this work; unrelated to any gate change.
