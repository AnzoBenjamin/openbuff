# Body roadmap vs product audit (2026-11-12)

Inputs:
- Card graph: `.agents/sessions/body-capability-review-2026-11-05/PLAN.md:83-122`.
- Node status: `docs/execution/body-roadmap/ledger.json`. 12 nodes are accepted: B01, B02, B03, B04, B05, B08, B18, B19, B20, B28, B30, B36. The other 27 are pending, and B21 is in progress per STATE.md.
- Shard roadmap-mapping sections in `findings/*.md`, and `findings/roadmap-process.md`.

## Strengths of the roadmap

**What it gets right**
- Every card names exact `file:line` defects, a test command and a stop condition (roadmap-process strengths). A shard could check prior findings at HEAD in minutes.
- Failed evidence is kept and never re-credited. Reviewers are independent of the implementers. Negative controls prove the tests can fail. Every acceptance states its limits.
- The dependency graph has a mechanical validator, which rejects unknown IDs and cycles.
- Consumer-level checks (packed CJS/ESM, rebuilt CLI) catch packaging bugs that unit tests miss. B24's tarball defect (language-intel-05) is exactly that class.
- The truthfulness focus was correct. Several of today's worst issues are in the same family (silent wrong answers, see REPORT.md "Cross-cutting patterns" §1); they simply live in tool results and UI text rather than run outcomes.

**Accepted cards whose fixes shards confirmed at HEAD**

| Card | Confirmed by | What users get |
|---|---|---|
| B02 | orchestration (03-F1 budget stop, 03-F2 generator errors appear fixed at `run-agent-step.ts:684-699`, `run-programmatic-step.ts:789`) | Cancelled and failed runs are no longer shown as completed |
| B03 | write-edit strengths and write-edit-10 (06-F3 narrowed: `rollback_failed` maps to applied only with a proven forward effect) | Failed edits are no longer reported "applied" |
| B04 | write-edit-10 (06-F1 fixed: contenders never reclaim the lock) | No concurrent-session corruption |
| B05 | write-edit-06 and write-edit-10 (06-F7 BOM preimage and 06-F8 range/symbol CRLF fixed for localized edits; 06-F11 bounded reader fixed) | BOM and line endings preserved on edits; huge files don't exhaust memory |
| B08 | providers-sdk strengths (AI SDK `maxRetries: 0`, shared classifier on the stream path, `reasoning_effort` sent on OpenAI-compatible routes; 02-F1, 02-F5, 02-F7 fixed) | Real HTTP status, sane retries, failover |
| B18 | exec-jobs (09-F1 raw-byte hashing, 09-F2 every effect evaluated, 09-F3 push risks checked first, all fixed) | Approvals bind to the exact command |
| B19 | exec-jobs (09-F8 hooks derive the captured context, not reproduced; credential scrubbing after env merge verified) | Mostly invisible; env scrubbing |
| B20 | exec-jobs (09-F5/F6 addressed for Linux cooperative cleanup) | No orphans after cancel, on Linux |
| B28 | extensions (10-F1 `isError`/`structuredContent` kept, 10-F4 paginated discovery and list_changed, 10-F8 declared path params only, 10-F9 hashed aliases; all fixed) | MCP errors and structured output arrive intact |
| B36 | Not re-probed by a shard. write-edit-05 notes the 12-F5 inference default is fixed | Timeouts and exit 127 not shown as passed (per ledger) |
| B01, B30 | Internal only (source/maturity truth, evaluator isolation) | Nothing visible |

Some fixes landed outside the roadmap. memory-context-02 found 04-F1 and caller-side 04-F2 fixed while B12 is still `pending`. Several user-visible gains this week came from non-roadmap commits (`f5aba489d`, `d6ba4e839`, `9bc57d16b`, `a2259adf3`; roadmap-process-06), and those commits then forced renewals (roadmap-process-03).

## Weaknesses

### Product scope the roadmap misses

The audit raised 33 product HIGH findings. The roadmap covers 2 of them fully (memory-context-02 under B12, language-intel-05 under B24) and 9 partially. The other 22 have no card:

| Finding | Problem |
|---|---|
| read-search-01 | Memory-first discovery fabricates glob, list and search results |
| read-search-02 | No model-facing read cap (10 MB per result) |
| write-edit-01 | 800-char capability tokens dominate edit cost and failures |
| write-edit-02 | Undo snapshots miss pre-turn state, new files and failed turns |
| exec-jobs-01 | No default command timeout; stdin open |
| exec-jobs-03 | No persistent approval rules |
| orchestration-01 | Plan mode is not read-only |
| orchestration-02 | About 47k static tokens per step |
| cli-ux-01 | No first-run setup |
| cli-ux-03 | Headless `run` lacks a scripting surface |
| providers-sdk-01 | No prompt caching on the agent loop |
| memory-context-01 | `/compact` unreachable |
| extensions-01 | MCP tools never deferred |
| extensions-02 | `mcp.json` intake is strict, undocumented and silent on failure |
| extensions-03 | Project `openbuff.json` trusted for credential providers and hooks |
| extensions-07 | No lifecycle hooks |
| extensions-08 | ACP drops non-text prompt blocks |
| language-intel-02 | Cold `workspace_symbol` returns empty success |
| language-intel-03 | Mixed position conventions |
| language-intel-11 | `inspect_codebase_structure` unbounded and blocking |
| web-media-evals-01 | SSRF bypass in web fetch |
| web-media-evals-10 | `[buffbench]` workflow and eval scripts point at deleted files |

The 69 product MEDIUM findings break down as 8 covered, 27 partial and 34 not covered. The roadmap's design is the reason. Its scope came from a truthfulness and reliability audit, so it has no cards for:
- cost (beyond B09 accounting);
- prompt and tool size;
- onboarding;
- startup;
- command defaults;
- trust UX;
- hooks;
- web egress;
- undo;
- eval CI.

A fully accepted roadmap would give a truthful CLI, not a competitive one (roadmap-process-07).

### Process (from `findings/roadmap-process.md`)

- **Throughput.** After the first wave the rate is 0.70 nodes/day, and 0.55 in the B19/B20 era. At that rate the remaining 27 nodes take about 39–49 days, and that is a lower bound because later nodes are harder. Only B21 is being worked while 11 nodes are ready (roadmap-process-01, -06).
- **Evidence volume.** Evidence takes 13.8 GB in 64,686 files, plus 0.54 GB archived. That is roughly 600 evidence lines per product line. It includes build outputs: 8,696 `.o`, 570 `.rlib` and 1,335 `.bin` files. B21 alone wrote 6.56 GB in under a day (roadmap-process-02).
- **Renewal churn.** Every promotion re-certifies every accepted node by source hash. About 85% of B20's files and 80% of its bytes are renewal evidence. Finishing would mean about 675 node-renewals for 27 new acceptances, and ordinary product commits trigger renewals too (roadmap-process-03).
- **Uncommitted state.** B19 and B20 are "accepted", but their product source and the live ledger are not committed. The working tree has 77 modified and 54 untracked files (+9,289/−2,342 lines), with no commits on 11 or 12 November (roadmap-process-04).
- **Disk.** `/` is at 98% with 22 GB free. Evidence grows about 3.4 GB/day, which leaves 6–7 days. STATE.md already records disk-pressure failures (roadmap-process-02).
- **Readability.** `STATE.md:3` is a single paragraph of about 450 words full of internal codes ("D250+G200+K200+J1000", "307 command slots"). The ledger's `coverageTier` strings are just as dense. There is no CHANGELOG and no "user-visible change" field (roadmap-process-05).
- **Proof burden.** B21 has gone through 14 artifact rebuild rounds. Across B19–B21 there are 240/379/214 `-rN` rounds. One B20 sample was re-reviewed for being 0.574 ms early (roadmap-process-08).
- **Tooling.** 2,734 lines of node-specific Python sit in a TS/Bun repo, and none of it is tested in CI (roadmap-process-09).

## HIGH and MEDIUM findings vs roadmap

C = covered by a card, P = partially covered, N = not covered. Coverage comes from each shard's "Roadmap mapping" section.

| Finding | Sev | Coverage | Card / note |
|---|---|---|---|
| read-search-01 | H | N | B12 does not touch discovery skips |
| read-search-02 | H | N | B05 bounds allocation, not model output |
| read-search-03 | M | N | |
| read-search-04 | M | N | |
| read-search-05 | M | N | |
| read-search-06 | M | P | B05/C12 fan-out; downscale and formats not covered |
| read-search-07 | M | N | |
| read-search-08 | M | N | |
| write-edit-01 | H | N | B05 covers byte authority only |
| write-edit-02 | H | N | B34 adjacent |
| write-edit-03 | M | P | B18 (commands only) |
| write-edit-04 | M | N | |
| write-edit-05 | M | P | B36/B27 (12-F5); docs and timeout not covered |
| write-edit-06 | M | P | B05 scope; whole-file case not in acceptance |
| write-edit-08 | M | N | B30/B31 could host the metric |
| write-edit-10 | M | C | B06/B07 |
| exec-jobs-01 | H | N | |
| exec-jobs-02 | H | P | B19 keeps full-access by choice; plan bypass not covered |
| exec-jobs-03 | H | N | |
| exec-jobs-04 | M | P | B29 trust tiers |
| exec-jobs-05 | M | P | B18 (compound/push fixed); copy and coverage not |
| exec-jobs-06 | M | P | B18 roster; prompt UI not |
| exec-jobs-07 | M | C | B21 (in progress); distribution and network allowlist not |
| exec-jobs-08 | M | N | |
| exec-jobs-09 | M | P | B20 records the limitation |
| exec-jobs-10 | M | N | |
| exec-jobs-11 | M | N | |
| exec-jobs-12 | M | P | B21 macOS/Windows cells; `findWindowsBash` and tree-kill not |
| orchestration-01 | H | N | |
| orchestration-02 | H | N | B32 measures release perf, not tokens |
| orchestration-03 | M | N | |
| orchestration-04 | M | P | B20 |
| orchestration-05 | M | P | B16, B34; UI and completion push not |
| orchestration-06 | M | P | B29; Markdown agents and `/agents` not |
| orchestration-07 | M | N | B08 covers route metadata only |
| cli-ux-01 | H | N | Planned in `docs/design/cli-overhaul/PLAN.md`, not a card |
| cli-ux-02 | H | P | B32 baselines, no target |
| cli-ux-03 | H | N | B02 covers termination truth only |
| cli-ux-04 | M | P | B10 |
| cli-ux-05 | M | P | B13 (01-F7) |
| cli-ux-06 | M | P | B09 accuracy; commands not |
| cli-ux-07 | M | P | B11 (01-F8) |
| cli-ux-08 | M | N | |
| cli-ux-09 | M | N | |
| providers-sdk-01 | H | N | |
| providers-sdk-02 | H | P | B08 owns retry policy; 529 missing |
| providers-sdk-03 | H | P | B09 (02-F3, precision); price table not |
| providers-sdk-04 | M | P | B08 (OpenAI-compatible only) |
| providers-sdk-05 | M | N | |
| providers-sdk-06 | M | N | |
| providers-sdk-07 | M | N | |
| providers-sdk-08 | M | N | |
| providers-sdk-09 | M | P | B08 fixture values only |
| providers-sdk-10 | M | N | |
| providers-sdk-11 | M | P | B01 maturity wording |
| memory-context-01 | H | N | |
| memory-context-02 | H | C | B12 (04-F3, F5, F9 open) |
| memory-context-03 | M | C | B14 |
| memory-context-04 | M | N | |
| memory-context-05 | M | P | B13 fidelity oracles |
| memory-context-06 | M | N | |
| memory-context-07 | M | N | |
| memory-context-08 | M | N | B13 covers retention only |
| memory-context-09 | M | C | B13 (01-F7) |
| memory-context-10 | M | C | B13 (04-F4) |
| extensions-01 | H | N | B28 is a prerequisite |
| extensions-02 | H | N | |
| extensions-03 | H | N | |
| extensions-04 | H | P | B29; prompt, persistence and reload not |
| extensions-05 | M | N | |
| extensions-06 | M | N | |
| extensions-07 | H | N | PLAN P9 defers lifecycle hooks |
| extensions-08 | H | N | B17 covers sessions only |
| extensions-09 | M | P | B29 (10-F5, 10-F10) |
| extensions-10 | M | N | |
| extensions-13 | M | C | B29 (10-F3) |
| language-intel-01 | H | P | B25, B20 |
| language-intel-02 | H | N | |
| language-intel-03 | H | N | |
| language-intel-04 | H | P | B25 (07-F9), B27 |
| language-intel-05 | H | C | B24 |
| language-intel-06 | M | P | B26 |
| language-intel-07 | M | N | |
| language-intel-08 | M | N | |
| language-intel-09 | M | P | B25 (07-F6, 07-F8) |
| language-intel-10 | M | N | |
| language-intel-11 | H | N | |
| language-intel-12 | M | N | |
| language-intel-14 | M | C | B23, B24, B25 |
| web-media-evals-01 | H | N | |
| web-media-evals-02 | M | N | RWEB contract 3 covers the browser path only |
| web-media-evals-03 | H | P | B33 addendum RWEB-2 (browser backend) |
| web-media-evals-04 | M | P | RWEB contracts 4 and 8 (browser path) |
| web-media-evals-05 | M | N | |
| web-media-evals-06 | M | N | |
| web-media-evals-07 | M | C | B33 (13-F1) |
| web-media-evals-09 | M | P | B33, read-search-06 |
| web-media-evals-10 | H | N | B32 adjacent |
| web-media-evals-11 | H | P | B30 (accepted), B31; CI wiring not |
| web-media-evals-12 | M | N | |
| web-media-evals-13 | M | P | B31 candidate channel |
| web-media-evals-14 | M | P | B32 discovery scope |
| roadmap-process-01 | H | N | Process |
| roadmap-process-02 | H | N | Process |
| roadmap-process-03 | H | N | Execution protocol, not a card |
| roadmap-process-04 | H | N | Process |
| roadmap-process-05 | M | N | Process |
| roadmap-process-06 | H | P | Graph exists; ordering not addressed |
| roadmap-process-07 | H | P | B32, B09, B17 partial |
| roadmap-process-08 | M | N | Process |

Summary for the 102 product HIGH and MEDIUM findings: 10 covered, 36 partial, 56 not covered.

## Remaining unaccepted cards: value and recommended action

| Card | Title | User value | Action | Reason |
|---|---|---|---|---|
| B21 | Rust exec role and OS enforcement | Low today (sandbox is opt-in, Linux x64 only) | Shrink / timebox | Land the current Linux opt-in at the security tier with stated limits, then stop. It has taken 16+ h and 6.56 GB, and it blocks nothing users need. |
| B10 | CLI prompt/context admission | High (no lost drafts or attachments) | Do now | Ready. Also absorb cli-ux-11 (interrupt/queue race). |
| B12 | Memory lifecycle | High | Do now, shrink | 04-F1 and 04-F2 are already fixed. Scope down to 04-F3, F5 and F9 (memory-context-02). |
| B09 | Usage/cost provenance and admission | High | Do now, expand | Add the price/window table, Anthropic token semantics, sub-cent precision and `/usage` (providers-sdk-03, providers-sdk-05, cli-ux-06). |
| B32 | CI/release oracles and baselines | Medium–high | Do now, expand | Set targets, not just baselines: ready-to-type time, RSS, static prompt tokens. Add code-map to CI and fix the nightly (web-media-evals-11, -14; cli-ux-02). |
| B11 | Artifact containment, command discovery | Medium | Do now | Small. Add the single command definition, fuzzy inline menu, `/help` directory and `/compact` registration (cli-ux-07, memory-context-01). |
| B23 | Language registry/graph identities | Medium | Do now | Ready, and the prerequisite of B24, B25 and B26. |
| B24 | Ship parser/query assets | High (installed users get no symbols) | Reorder: pull ahead | Split the packaging fix out of the B23 dependency and ship it now. It is a tar-list change (language-intel-05). |
| B33 | Browser/image/render truth | Medium | Shrink, do now | The browser-policy fix (13-F1) and the `render_ui` result (13-F9) are small. Leave the RWEB addendum for later. |
| B13 | Original results, durable history | High | Keep order (after B12) | Removes the 100-message cap and fixes recall shadowing. |
| B14 | Verified procedures | Medium | Keep order (after B12) | Needed for the "learning agent" goal. |
| B25 | LSP versions/roots/server life | Medium–high | Reorder, expand | Add session-scoped servers, `$/progress`, diagnostics capture and conditional exposure (language-intel-01, -04, -07). Without these the LSP tools cost more than they return. |
| B26 | Retrieval generations and caches | Medium | Keep | Add the metadata size ceiling and the `.tmp` sweep (language-intel-06). |
| B07 | Durable intents, owned recovery | Medium | Keep (security tier) | Crash safety for multi-file edits. Do it after the user-facing ready set. |
| B06 | Versioned semantic/refactor transactions | High | Keep order (after B07) | Safe rename and refactor. |
| B15 | Journal identity, replay | Medium | Reorder: before B17 | Its main user value is unlocking B17. |
| B17 | Canonical ACP sessions | High | Reorder, expand | Add `resource_link`/`resource`/image prompt blocks (extensions-08) and Zed setup docs. Editor users lose `@file` today. |
| B29 | Trusted bundles, extension tiers | Medium | Reorder, expand | Make it the home for the project trust gate (extensions-03, -04, -05; exec-jobs-04). This is a security issue that affects default users. |
| B34 | Isolated concurrent workspaces | High | Reorder, shrink | Re-scope to git worktrees with an observed merge, and drop the B22 and B27 dependencies. It currently waits on 15 nodes. |
| B16 | Child journal ownership/leases | Low–medium | Defer | Detached subagents surviving restarts is rare. |
| B27 | Per-root validation, joined contracts | Low | Defer | Six ancestors; polyglot validation only. |
| B35 | 3D previews bound to sources | Low (Blender users) | Defer | Niche. Consider dropping the 3D tier from the default surface instead (see REPORT.md "Minimalism vs breadth"). |
| M22-CORE | Native admission/epoch baseline | None directly | Defer | Infrastructure. Start only when a measured need appears. |
| M22-TXN | Legacy transaction import | None | Defer | Same. |
| M22-CHILD | Child journal migration | None | Defer | Same. |
| B22 | Minimal rusqlite daemon (rollup) | None directly | Defer | Seven ancestors. Revisit only if worktree-based B34 proves insufficient. |
| B31 | Held-out trials, application/rollback | Low near-term | Defer | Eleven ancestors. A working nightly regression gate (new card N11) delivers most of the learning-loop value first. |

## Proposed new cards for uncovered gaps

| ID | Title | Scope | Acceptance (one line) |
|---|---|---|---|
| N01 | Prompt caching on the agent loop | providers-sdk-01, memory-context-11, orchestration-08 | A wire test shows `cache_control` on anthropic-compatible and OpenRouter-Anthropic stream bodies, and cache-hit % is shown per turn. |
| N02 | Plan mode is read-only | orchestration-01, exec-jobs-02 | The reachability test asserts that the plan surface plus plan-lineage children contain only `create_plan`/`update_plan_status` among mutating tools, and a plan-mode `basher rm` is refused. |
| N03 | Static prompt budget and deferred tools | orchestration-02, extensions-01, read-search-07, exec-jobs-14, language-intel-07, -12 | A CI check fails when base2 system + tools + catalog + instructions exceed a set budget (proposed 25k tokens), with MCP and rare tiers reachable through `tool_search`. |
| N04 | No silent empty results | read-search-01, language-intel-02, -07, web-media-evals-03, -06, -08, exec-jobs-13 | Each listed tool has a negative test proving that a blocked, cold, missing or unauthenticated state returns a typed `unavailable`/`blocked`/`auth` result with a next step. |
| N05 | Bounded tool outputs | read-search-02, -03, -04, language-intel-10, -11, -12, exec-jobs-11 | No read, list, search, LSP, inspect or bundle result exceeds about 25k tokens or 2,000 chars per line without returning `partial` and an offset, shown with 10 MB and 80k-file fixtures. |
| N06 | First-run onboarding and credentials | cli-ux-01, providers-sdk-06, -13 | In a fresh home directory, the TUI opens provider setup, accepts a pasted key into a 0600 store, and completes a prompt without a restart. |
| N07 | Undo and rewind | write-edit-02, -09, memory-context-08 | After a failed turn that created and edited files, `/rewind` restores the pre-turn tree, including deleting the new files, and the snapshots live outside `.git`. |
| N08 | Command execution defaults and rules | exec-jobs-01, -03, -05, -06, -18 | A prompting command fails fast with EOF. The default timeout is enforced. Allow/deny rules persist outside the repo. The approval prompt shows every effect. |
| N09 | Project trust gate | extensions-03, -04, -05, exec-jobs-04 | An untrusted clone's `openbuff.json` providers, hooks and `approvalMode`, its skills and its `.agents/` are all inert until a persisted trust prompt is accepted. |
| N10 | Web egress safety and backends | web-media-evals-01, -02, -03, -04, -05 | The four mapped-IPv6 vectors are refused. Fetch uses pinned DNS. `web_fetch` returns Markdown in base2's core. At least one keyed search provider is configurable. |
| N11 | Eval regression gate | web-media-evals-10, -11, -14, write-edit-08, language-intel-08 | The nightly runs `base2`, uploads results, fails on regression beyond a noise band against the last green run, and reports edit-commit rate and LSP call rate per model. |
| N12 | Headless run surface | cli-ux-03, providers-sdk-11 | `echo task \| openbuff run --model X --output-schema s.json` returns schema-valid JSON, `--continue` resumes, and the SDK accepts `model` per run. |
| N13 | Context controls | memory-context-01, -04, -06, -07 | `/compact [focus]` works. Nested and ancestor AGENTS.md/CLAUDE.md files load and are listed in `/context`. Overflow on Gemini and Ollama wording compacts and retries. |
| N14 | Lifecycle hooks | extensions-07 | PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop/PreCompact hooks are trust-gated, take Claude-compatible stdin JSON, and exit code 2 blocks. |
| N15 | Startup budget | cli-ux-02 | `--version` < 100 ms and ready-to-type < 800 ms on CI hardware, recorded in PERFORMANCE.json. |
| N16 | Provider resilience | providers-sdk-02, -08, -09, -10 | A 529 retries and fails over. Retry-After up to 120 s is honoured. A 401 failover leaves a persistent warning naming the env var. `[::1]` is accepted. |

## Recommended lighter process

This merges the recommendations in `findings/roadmap-process.md`, adjusted for the product gaps above.

1. **Free the disk today.** Move B19–B21 build artifacts (`.o`, `.rlib`, `.bin`, copied sources) out of the tree and keep only their hashes. Cap stored evidence at about 50 MB per node.
2. **Commit what is accepted.** Commit B19 and B20 product source and the ledger as separate commits now. Going forward, "accepted" means a merged commit with CI green.
3. **Three acceptance tiers.**
   - T1, security and data loss (B07, B21, B22, plus N02, N09 and N10): independent review, adversarial controls, at most one review round and one repair round.
   - T2, behavior (most cards and most new cards): a green PR running the card's named test command plus new failure-path tests, one reviewer, and a one-paragraph receipt.
   - T3, internal (B27, B31): tests only.
4. **Tests are the evidence.** Store the CI run ID and commit SHA, not copied logs. Keep failed attempts as a summary: command, exit code and a 20-line excerpt.
5. **Renew on regression, not on hash.** Tag each node's tests and run them in CI on every commit. Re-review a node only when its tests fail or its public contract changes, and batch re-reviews weekly. This removes the 75–85% renewal overhead and stops penalising ordinary product commits.
6. **Two or three parallel lanes** on ready cards with disjoint file ownership, as in the first wave (8 nodes in about 11 h).
7. **Timebox at 2 days per node.** If a node runs over, split it or land it at a lower tier.
8. **Plain-language status.** Add a required `userVisibleChange` field per node and a `CHANGELOG.md`. Replace STATE.md's top paragraph with at most 10 lines that avoid internal codes.
9. **Replace the bespoke Python** with `bun test` suites tagged per node, plus one small ledger validator.
10. **Proposed order:**
    1. Close out B21.
    2. In parallel: N01, N02, N04, B24 (packaging split), N10 (SSRF part), B10, B12.
    3. B09 (with the cost table), B32 (with targets, plus N11), B11, B23, N05, N08.
    4. N03, N06, N09, B13, B14, B33 (shrunk).
    5. B25 (expanded), B26, N07, N13, N16.
    6. B07 → B06, then B15 → B17 (expanded), B29 (expanded), N12, N14, N15.
    7. B34 on worktrees.
    8. Defer B16, B27, B35, M22-*, B22 and B31 until a measured need appears.
