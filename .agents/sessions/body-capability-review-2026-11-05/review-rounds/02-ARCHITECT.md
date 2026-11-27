# Dedicated architect review — final recovery-qualified revision

Verdict: **APPROVED**

The revised plan is architecturally viable and fits the user’s macro capability and micro implementation objective. The prior architectural blockers are resolved: participating writers have one backend/epoch protocol; native imports consume corrected producers through explicit milestones; semantic edits distinguish complete preflight from sequential application and recovery; and current diagnostic truth repair is independently ready. No substantive architectural blocker remains.

This approves the **planning architecture**. It does not establish repaired behavior, installed/native readiness, empirical model quality, publication completion or execution authorization. The next gate is the root’s **independent Critic review after this completed result**.

## Review basis and source qualification

I read `/home/ben/.codex/prompts/architect.md` first and followed its read-only, file-backed review contract. I read the full PLAN.md and SPEC.md, including the embedded RALPLAN-DR principles/drivers/options and ADR; AUDIT-REPORT.md, CAPABILITIES.md, OLD-TASK-MIGRATION.md, REQUIREMENTS-REVIEW.md; both preserved round-1 reviews; REVIEW-VALIDATION.json, COVERAGE-RESULT.json, PLAN-VALIDATION.json and SOURCE-STABILITY.md. I also opened representative current implementation anchors identified below and selected architecture/request-flow/package/toolchain documentation.

I made no file edits, ran no product tests, activated no goal and spawned no agents. This dedicated responsibility used the available inherited native model; it does not claim the unavailable fixed-role configuration ran.

The four core document hashes matched the root’s supplied values and remained unchanged through my final check:

| Reviewed file | SHA-256 |
|---|---|
| PLAN.md | `8ffbb2268dc0b5641ded1201bdd6b15964630d08575f73369512c9798ab7b368` |
| SPEC.md | `3bf9585bc801bc718c4f8e5fa8816d1b0d1b922fa8ff66e359a94ab18c6bddf6` |
| OLD-TASK-MIGRATION.md | `e227904717f54ac415d57e9b43d85a86914f9a0d031a5f1e79b088bcac548ba1` |
| CAPABILITIES.md | `f5953baaded163f3268db9c3ab516806c5eb7a688b601f865424d13cc17c3265` |

Supporting artifact hashes captured after reading:

| Reviewed file | SHA-256 |
|---|---|
| AUDIT-REPORT.md | `8de8eee0ac32b8947e873b292035fde47d33f2826c4a151874706fa1757735b7` |
| REQUIREMENTS-REVIEW.md | `4d5e6806913b3f93c442896c09a84cd64c33e27ede6f6341fd1bfeeada21c867` |
| REVIEW-VALIDATION.json | `ad1ab7c571d399fe65345672cbe864cf6f1cd7ac003540a400712a0059429dbb` |
| COVERAGE-RESULT.json | `02f8bf299f565783c0226290f61bfe11738d4b0a9cd02c567f93917aa6c117cd` |
| PLAN-VALIDATION.json | `3eaeac4322f771767339f93b12d71c8f0e8fbd07ddb875ee0d3d43d23de6768d` |
| SOURCE-STABILITY.md | `d991ed25522c57723e040ac585a437ec012da2e1a8a5b4ac19b71c1710e8001a` |
| review-rounds/01-ARCHITECT.md | `bab81c2f03fa48465c115e6a513e5c9f2ae300ed005efdc9d38bd837b827cfc4` |
| review-rounds/01-CRITIC.md | `63b154d05816bb77ec72604888e8a3df923f6b6416a70bde1a9a79ff3551a367` |

A fresh read-only Git check confirmed HEAD `e65c06c0ae783130998bd9ab18c8d35320e40ea8`.

Recovery assurance is appropriately qualified. The synthesis credits 555 receipt files and 147,555 reconstructed read-window lines; it separates the historical 147,721 count and missing 166-line interval. The lost original 558-file whole-byte map is not freshly certified. The 258 surviving captured windows across 173 files agree with current normalized lines, while CURRENT-FILE-HASHES.json is a fresh binding rather than historical equality evidence (`AUDIT-REPORT.md:19`, `AUDIT-REPORT.md:25`, `SOURCE-STABILITY.md:3`, `SOURCE-STABILITY.md:5`, `SOURCE-STABILITY.md:7`). I did not independently reinspect all audited files.

## Architectural diagnosis and requirement fit

The plan addresses the underlying integration cause instead of treating authored-language variety as feature completeness. Current code demonstrates several examples of useful information becoming weaker at the next boundary:

- A generator exception sets `endTurn=true` and returns normally, while normal finalization writes a completed journal boundary and run status (`packages/agent-runtime/src/run-programmatic-step.ts:749`, `:794`; `packages/agent-runtime/src/run-agent-step.ts:3664`, `:3678`).
- A `rollback_failed` action becomes `applied`, and the SDK’s shared selector advances workspace observations from those confirmed actions (`common/src/tools/results/filesystem.ts:1130`; `sdk/src/run.ts:3184`, `:3210`).
- WorkspaceEdit normalization explicitly ignores document versions; semantic application constructs new content from disk and later supplies unguarded full-file requests (`sdk/src/services/lsp-multiplexer.ts:1057`, `:1318`; `sdk/src/services/language-intelligence.ts:350`; `sdk/src/tools/semantic-edit-apply.ts:136`).
- Diagnostic capture parses output while discarding execution status, then a no-new-error result is projected as `diagnostic_delta_passed` (`sdk/src/services/diagnostic-delta.ts:232`, `:463`; `sdk/src/tools/file-change-hooks.ts:1691`).
- Next-turn retrieval supplies the new task ID to a repository filter that excludes earlier-task observations (`sdk/src/services/memory-v2/coordinator.ts:1173`; `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:5235`).
- Outgoing MCP projects `content` without carrying the complete result envelope, while evaluator errors can still reach an ordinary return and comparison code overwrites repeats and removes low scores (`common/src/mcp/client.ts:862`; `evals/buffbench/runners/codebuff.ts:125`, `:198`; `scripts/compare-buffbench-runs.ts:35`, `:66`).

These opened anchors support the audit’s recurring cause: authority, identity, completeness and lifetime lose meaning between producers and consumers (`AUDIT-REPORT.md:168`, `:170`). Moving those consumers to another language would not restore discarded information.

The replacement architecture keeps model-owned strategy and host-owned trustworthy observations/effects explicit. It preserves local/BYOK routing, custom strategies and intentionally selected full access, which the shipped terminal handler confirms (`SPEC.md:9`, `:11`; `docs/request-flow.md:3`; `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:38`). The finite F1–F10 families, ten responsibilities and tiered capability catalog cover present strengths and partial/unwired/absent/unknown boundaries without promising every frontier (`SPEC.md:29`, `:44`; `CAPABILITIES.md:9`, `:124`).

## Resolution of prior blockers

| Prior issue | Resolution verified in this revision | Architectural judgment |
|---|---|---|
| ARCH-1 / CRIT-1: competing TS/native writer authorities | One SessionAuthority semantic owner; physically bound repository control record; schema/protocol compatibility; common participating admission gate; guarded native effects; quiescence/import/activation; outage/skew refusal; no automatic TS fallback; explicit post-activation downgrade refusal (`PLAN.md:712`–`:720`; `SPEC.md:17`–`:23`) | Resolved |
| ARCH-2 / CRIT-2: ungated corrected-store imports | M22-CORE is limited to eligible fresh namespaces; M22-TXN requires B05/B07; M22-CHILD requires B16 and M22-TXN; B22 requires all three current receipts and the populated transition matrix (`PLAN.md:122`–`:128`, `:722`–`:728`) | Resolved |
| ARCH-2 / CRIT-2: unsupported all-file atomicity | B06 now requires B04/B07, enumerates supported/refused forms, promises zero-write complete preflight refusal and guarded sequential application, and retains partial/uncertain/recovery/conflict state (`PLAN.md:530`–`:546`; `SPEC.md:65`) | Resolved |
| CRIT-3: diagnostic truth behind unrelated integration | B36 has no prerequisites, owns the actual delta→hook→SDK/client projection, and is first worker rotation; B27 consumes it for deeper coverage (`PLAN.md:79`, `:120`, `:860`–`:868`) | Resolved |

The native transition is now realizable within its stated scope. A fence governs admitted operations; it cannot universally exclude unaware binaries, user editors or arbitrary full-access shell effects. The plan states that boundary and requires conflict/reconciliation evidence instead (`PLAN.md:714`, `:717`, `:720`). The original defect remains concrete: broker reclaim removes a lock after a separate recovery check, and index reclaim reads before renaming (`sdk/src/services/workspace-mutation-broker.ts:601`; `packages/indexer/src/index-store.ts:1164`, `:1176`). A shared admission protocol is therefore necessary; a native token checked only by new native clients would have been insufficient.

The semantic-edit correction also matches the current implementation’s limits. Per-file splice failures currently leave surviving changed files available for application, and normalization can drop unsupported members (`sdk/src/services/language-intelligence.ts:418`; `sdk/src/services/lsp-multiplexer.ts:1059`). Complete-intent preflight followed by visible sequential commits is a feasible replacement. It does not require a general filesystem-wide atomic transaction.

## Important boundaries retained

**Immediate TS safety is credible.** B04 disables ambiguous automatic takeover and accepts explicit recovery-needed state. It does not claim read/recheck→unlink or rename is a compare-and-swap primitive. Ordinary participating ownership and snapshot publication receive real-process/CAS controls, while crash-reclamation liveness waits for native ownership (`PLAN.md:510`–`:514`). The current snapshot path reads a parent and updates the ref without an expected old value, so this repair addresses a real publication boundary (`cli/src/utils/turn-snapshots.ts:461`, `:488`).

**Replay has a defensible eligibility boundary.** B15/B29 reconstruct only a verified recorded prefix with bundle/runtime/contract/configuration identity, ordered yields and recorded reconstruction inputs. Mutable module state, direct unrecorded I/O or nondeterminism requires a tested adapter or replay-unavailable; trusted execution remains usable (`SPEC.md:110`; `PLAN.md:634`, `:796`). This is necessary because the current runtime reconstructs serialized functions with `new Function`, and programmatic dispatch has a journal wrapper distinct from model/custom dispatch (`run-programmatic-step.ts:401`, `:1042`; `tools/stream-parser.ts:706`, `:731`). A bundle alone is not a live heap or complete effect ledger.

**Process limits describe observed scopes.** The finite launcher matrix includes shell/jobs, children, hooks, diagnostic/build/version/SCIP processes, LSP, MCP, Chrome, Blender and native roles. Selected deadline acceptance requires observed covered-scope exit, drained streams and no late effects; escape beyond a cooperative tier is disclosed (`SPEC.md:86`, `:88`). Current leader-close and background settlement paths cancel escalation while later kill rejects a terminal job, validating the separate cleanup-liveness contract (`sdk/src/tools/run-terminal-command.ts:1663`; `sdk/src/tools/background-jobs.ts:497`, `:1257`). B36 correctly reports cancellation truth without claiming B20’s process-death proof (`PLAN.md:866`).

**Native adoption uses the actual boundary.** Rust consumes a raw ExecPlan after its handshake and replaces itself with the target; the generic TS supervisor sends method/params RPC requests (`rust/crates/openbuff-native/src/exec/mod.rs:149`; `exec/runner.rs:65`; `sdk/src/services/sidecar-supervisor.ts:246`). B21’s explicit one-shot adapter, separate control traffic, installed artifact checks and JSON-RPC-shaped target-output control address that mismatch. Linux enforcement and other platform cells remain distinct future proofs (`PLAN.md:692`–`:696`; `SPEC.md:153`).

**Polyglot cooperation has independent proofs.** Authored fixture A tests installed TS→Rust execution without Python. Target fixtures B/C require actual TS/Rust/Python schema consumers and C/Python ABI consumers; unknown-language D retains generic operations with unavailable deeper tiers (`SPEC.md:139`–`:149`). Consumed parsers, servers and compilers do not inflate authored-body language count.

**Memory and learning preserve meaning and limits.** The factual fixture fixes values, negation, blocker state, decision/rationale and original-result hashes through compaction and restart. Quota/expiry, pins and keep-until-delete have honest capacity behavior (`SPEC.md:114`–`:122`). B30/B31 retain complete paid/error populations, predeclare held-out comparison rules and separate synthetic plumbing from empirical improvement (`PLAN.md:804`–`:818`). Those gates discriminate the opened retrieval, archive-selection and comparison defects; they do not certify a quality gain in advance.

**Installation and staffing are feasible planning contracts.** Bootstrap acquisition is separated from locked/offline assurance; unavailable cells cannot satisfy positive graduation; actual SDK package exports and Rust pin provide concrete inputs (`PLAN.md:910`–`:959`; `sdk/package.json`; `rust/rust-toolchain.toml`). Leader plus three workers is viable when shared schemas and `sdk/src/run.ts` remain serialized and independent verification rotates within the four slots (`PLAN.md:40`, `:965`). “C-owned” here denotes the leader contract lane, not new C-language body authorship.

## Antithesis, tradeoff tension and synthesis

**Strongest steelman against favored A/hybrid:** Option B can still be the better delivery strategy when interruption and concurrent work dominate. B04’s safe refusal can strand work after an unknown/killed owner. Repairing several provisional TS ownership paths and later migrating them imposes two integration passes. A persistent native authority lane could shorten that liveness gap and establish one owner before ACP, children and lanes further multiply consumers. Moreover, the hybrid’s “early” M22-CORE still waits for full B19/B20/B21; adjacency is not a short calendar schedule (`PLAN.md:30`, `:36`, `:696`).

That argument is substantive, but it does not remove the need to repair bytes, results, identities, diagnostic outcomes or memory producers. A daemon cannot reconstruct information already discarded. Fixing its interface before those meanings are established can preserve defects in a more durable store.

| Tension | A/hybrid benefit | B benefit | Viable resolution |
|---|---|---|---|
| Safety versus recovery liveness | Immediate fail-closed exclusion | Earlier OS-held crash reclamation | Accept B04’s safety tier honestly; graduate reclamation at the exact native milestone |
| Repair throughput versus transition duration | More independent current defects repaired | Shorter provisional ownership lifetime | Keep B02/B03/B04 and B36 rotation; reserve the native lane after its real prerequisites |
| Small baseline versus populated migration | M22-CORE remains bounded | One authority earlier for clients | Preserve separate TXN/CHILD producer gates and all-three B22 rollup |
| Full access versus universal exclusion | User strategy/access choices remain useful | Stronger mediated ownership | Fence participating operations; observe and reconcile external effects |

**Synthesis:** retain immediate independent TS truth/safety repairs and the bounded native authority lane. The revised plan implements this synthesis without accepting partial B21/B22 work, bypassing corrected producers or pretending unavailable platforms are proven. Option B remains selectable through a dated scheduling revision when workload evidence makes its liveness benefit more valuable (`PLAN.md:32`, `:965`, `:989`–`:995`).

## Nonblocking polish and future acceptance

Two citation/metadata repairs were reported to the root:

1. B19’s abbreviated `services/scip-runner.ts:322` should identify `packages/indexer/src/scip-runner.ts:322`. I opened the actual launcher; it confirms the intended environment/context seam.
2. `COVERAGE-RESULT.json:150` still names absent INSPECTED-FILE-HASHES.json. Replace that reference with the current fresh binding and retain SOURCE-STABILITY.md’s historical-equality qualification.

These do not undermine the architecture because the actual source and qualified binding are available. The root acknowledged both and will record the bounded corrections before the Critic gate.

Future implementation must still prove the stated adversarial cases—especially admission held through effects/acknowledgement, complete preflight, sequential recovery, recorded-prefix eligibility, actual scope cleanup, populated native imports and isolated installed consumers. Those are acceptance obligations, not remaining planning blockers.

## Handoff

Persist this result against the hashes above, record subsequent citation/status edits explicitly, and run the independent Critic on the resulting revision. Preserve the historical roadmap, user knowledge edits, recovery limits and prospective card states. Architectural approval must not be converted into a repaired-feature claim or automatic execution handoff.
