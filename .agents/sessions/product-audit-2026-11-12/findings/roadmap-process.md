# Shard `roadmap-process`: process and priorities of the body roadmap

Audit time: 2026-11-12 ~18:40 EAT (15:40 UTC). HEAD `f5aba489d` (2026-11-10 21:59 +0300). Read-only; the only write is this file.

## Scope

Inspected:
- Plan/spec: `.agents/sessions/body-capability-review-2026-11-05/PLAN.md` (135 KB; graph table at lines 81–129, cards B01–B36 at lines 476–870), `SPEC.md` (39 KB), `STATUS.md`, `AUDIT-REPORT.md`, `CAPABILITIES.md`, `OLD-TASK-MIGRATION.md` (sizes only plus targeted greps).
- Execution: `docs/execution/body-roadmap/STATE.md` (27.8 KB, 126 lines), `ledger.json` (145 KB, 39 nodes), `execution-plan.json` (RWEB addendum), the Python tooling (`validate-ledger.py` 531 lines/28.6 KB, `test-validate-ledger.py` 434, `seal-acceptance.py` 128, `run-checks.py` 225, `run-b19-checks.py` 154, `run-b19-compiled-checks.py` 129, `join-b19-captures.py` 515, `adjudicate-b19-oracles.py` 618; 2,734 lines total), `evidence/` (sizes, directory names, round counts), `archive/` (size only).
- `.omx/` (143 MB, 3,103 files): `context/openbuff-body-execution-20261106T102953Z.md`, `context/body-b21-bootstrap-checkpoint.md`, `state/session.json`, directory listing.
- Git: `git log --since=2026-11-01` (45 commits), `--numstat` since 2026-11-06, ledger.json history (`6b3547451`, `0ad263fd0`), `git status`/`git diff --numstat` of the working tree.

Skipped: content of individual evidence receipts (64,686 files; sampled by name/size only), product source correctness (other shards), token/cost of the agent loop (no billing data in repo).

## Node classification

Class: **U** = user-visible usability, **R** = user-visible reliability, **A** = internal assurance only. "Unaccepted ancestors" counts prerequisites not yet accepted (computed from `ledger.json` `completionGraph`).

| Node | Title (PLAN.md) | Class | Status | Unaccepted ancestors / ready? | User-noticeable result if accepted |
|---|---|---|---|---|---|
| B01 | Coverage/maturity/source evidence independent | A | accepted | – | None (audit tooling) |
| B02 | Authoritative action/run/task outcomes | R | accepted | – | Yes: cancelled/failed runs no longer shown as completed |
| B03 | Mutation evidence only from forward effects | R | accepted | – | Yes: failed edits no longer reported "applied" |
| B04 | TS lock ownership and snapshot/index CAS | R (rare) | accepted | – | Rarely: concurrent-session corruption avoided |
| B05 | Raw bytes, bounded reads | R | accepted | – | Yes: BOM/CRLF preserved; huge one-line files don't blow memory |
| B06 | Versioned semantic/refactor transactions | U | pending | 1 (B07) | High: safe multi-file rename/refactor |
| B07 | Durable intents, owned recovery | R | pending | ready | Medium: crash-safe multi-file edits |
| B08 | Provider errors, retry, route settings | R | accepted | – | Yes: real HTTP status, sane retries, backup failover |
| B09 | Usage/cost provenance, request admission | U (cost) | pending | ready | High: correct cost display and spend caps |
| B10 | CLI prompt/context admission transaction | R | pending | ready | High: no lost drafts/attachments on failure |
| B11 | Artifact containment, command discovery | U | pending | ready | Medium: hidden commands appear in palette |
| B12 | Memory lifecycle, next-turn selection | U | pending | ready | High: cross-task memory actually recalled |
| B13 | Original results, durable CLI history | U | pending | 1 (B12) | High: compaction keeps facts; history pages back |
| B14 | Verified procedures active and scoped | U | pending | 1 (B12) | Medium: learned playbooks apply correctly |
| B15 | Journal identity, replay at dispatch | R | pending | ready | Medium: resume after crash |
| B16 | Child journal ownership/leases | R | pending | 1 (B15) | Low–medium: detached subagents survive |
| B17 | Canonical ACP sessions, reconnect | U | pending | 1 (B15) | High: editor (ACP) integration survives reconnect |
| B18 | Exact executable action hashing/approval | R | accepted | – | Yes: approvals bind to the exact command |
| B19 | One effective execution context | A (security) | accepted | – | Mostly invisible: env scrubbing, hook trust |
| B20 | Owned process-scope cleanup | R | accepted | – | Sometimes: no orphan processes after cancel (Linux only) |
| B21 | Rust exec role + OS enforcement | A (security) | **in progress** | ready | Low unless user opts into sandbox |
| B22 | Minimal rusqlite daemon (rollup) | A | pending | 7 | None directly |
| M22-CORE | Native admission/epoch baseline | A | pending | 2 (B15, B21) | None |
| M22-TXN | Legacy transaction import | A | pending | 4 | None |
| M22-CHILD | Child journal migration | A | pending | 6 | None |
| B23 | Language registry/graph identities | R | pending | ready | Medium: correct code-map/search edges |
| B24 | Ship parser/query assets in packages | R | pending | 1 (B23) | High: language features work in the *installed* CLI |
| B25 | LSP versions/roots/server life | R | pending | 1 (B23) | Medium–high: fresh diagnostics, no zombie LSPs |
| B26 | Retrieval generations, caches, coverage | R | pending | 1 (B23) | Medium: no stale/ghost search hits |
| B27 | Per-root validation, joined contracts | A | pending | 6 | Low (polyglot validation) |
| B28 | MCP/custom schema/result/origin | R | accepted | – | Yes for MCP users: errors and structured output preserved |
| B29 | Explicit agents, trusted module transport | R (authors) | pending | 1 (B15) | Medium for custom-agent authors |
| B30 | Evaluator isolation | A | accepted | – | None (evals) |
| B31 | Held-out trials, application/rollback | A | pending | 11 | None near-term |
| B32 | CI/release oracles + perf baselines | A→U | pending | ready | Indirect: first real startup/latency/token numbers |
| B33 | Browser/image/render truth | U | pending | ready (+RWEB addendum) | Medium: browser research tool reliable |
| B34 | Isolated concurrent workspaces, landing | U | pending | **15** | High: parallel agents without clobbering |
| B35 | 3D previews bound to sources | U (niche) | pending | ready | Low (Blender users) |
| B36 | Diagnostic outcome/coverage truth | R | accepted | – | Yes: timeouts/exit 127 not shown as "passed" |

Totals: 12 accepted (10 R, 2 A). Of 27 remaining: 11 U, 10 R, 6 A (B21, B22, M22-×3, B27, B31 counted A; B32 counted A). **11 nodes are ready today** (B07, B09, B10, B11, B12, B15, B21, B23, B32, B33, B35); only B21 is being worked.

## Findings

### roadmap-process-01 — Throughput collapsed after the first wave; projected finish is 5–7 weeks and getting slower
- Axis: completeness (delivery). Severity: HIGH.
- Evidence:
  - Ledger start `startedAt 2026-11-06T10:29:53Z` (`ledger.json`).
  - Commit `6b3547451` (2026-11-07 02:13 +0300) ledger: 8 nodes accepted at `2026-11-06T21:50:30Z` (B01, B02, B03, B04, B08, B18, B30, B36), i.e. 8 nodes in ~11 h.
  - Commit `0ad263fd0` ledger: B05 and B28 added by `2026-11-08T08:58Z`; B19 `in_progress`.
  - Live ledger: B19 accepted `2026-11-11T12:17Z` (manifest `20261111T121757392087Z`, ~3.1 days in progress); B20 accepted `2026-11-11T23:58:13Z` (intake dir `evidence/B20/intake-20261111/` first file 2026-11-11 15:37 +0300; ~11 h, but B20 work overlapped B19 renewals).
  - B21: `evidence/B21/intake-20261112` created 2026-11-12 02:22 +0300; at 18:39 +0300 it is ~16.3 h in progress, 96 evidence dirs, still "B21 remains unaccepted" (`STATE.md:3`).
- Rates: overall 12 nodes / 6.2 days = 1.9/day (inflated by the first wave). After the first wave: 4 nodes in 5.7 days = 0.70/day → 27 remaining ≈ **39 days**. B19/B20 era: 2 nodes in 3.6 days = 0.55/day → ≈ **49 days**. The remaining graph is harder (B22 daemon, B34 depth 6, B31 11 ancestors), and renewal cost grows with each accepted node (finding 03), so these are lower bounds.
- Impact: the user-facing gaps in B09/B10/B12/B13/B17/B24/B34 stay open for weeks.
- Fix: see Recommendations (risk tiers, parallel ready lanes, timebox B21).
- Cross-ref: new.

### roadmap-process-02 — Evidence volume is ~600× product change and is filling the disk
- Axis: reliability (process). Severity: HIGH.
- Evidence:
  - `du -sb evidence` = 13,790,002,138 bytes (13.8 GB), `find evidence -type f | wc -l` = 64,686. `archive/` adds 537,804,443 bytes.
  - Per node: B19 18,459 files/3.51 GB; B20 24,294 files/3.69 GB; B21 (in progress, <1 day) 21,442 files/6.56 GB. B01–B18, B28, B30, B36 keep only 4 files each in `evidence/` (rest archived).
  - Text evidence (`*.json|md|txt|log|jsonl`, <20 MB each): 60,190,181 lines, 3.74 GB. Other content includes build outputs: 8,696 `.o`, 1,335 `.bin`, 570 `.rlib`, 3,090 `.py` copies, 5,374 `.ts` copies.
  - Product change since 2026-11-06: committed additions in sdk/cli/packages/common/agents/rust ≈ 77,100 lines (+17,000 deleted) from `git log --numstat`; uncommitted ≈ 7,100 modified-line additions plus ≈ 18,900 lines in untracked product/eval/script files. Roughly 100k product lines vs 60M evidence lines: **~600:1**. Committed `docs/execution/` churn alone was +996,576/−747,217 lines across 4,480 file touches before `evidence/` was gitignored (`.gitignore:64`), ~13× the committed product additions.
  - Disk: `df` shows `/` at 98% (22 GB free). Evidence growth B19→B21 ≈ 3.4 GB/day, so ~6–7 days of headroom. `STATE.md` already records "Disk-pressure failures" and a storage-recovery pass (`STATE.md` "Disk-pressure failures and the rejected overlapping package/build attempt…"; `evidence/B19/continuation-20261111/storage-recovery/`, 278 MB).
- Impact: the process will stall on ENOSPC unless pruned. Every rebuild round copies binaries into evidence.
- Fix: store hashes plus test-runner JSON summaries, not build artifacts; cap evidence per node (e.g. 50 MB); keep failed-attempt summaries, not full trees.
- Cross-ref: new.

### roadmap-process-03 — Renewal churn: each promotion re-certifies every prior node; most of B20's evidence is renewal
- Axis: reliability (process). Severity: HIGH.
- Evidence:
  - All 12 accepted nodes carry `acceptedAt 2026-11-11T23:58:1x` and epoch `f5aba489d` in the live ledger, although 8 were first accepted 2026-11-06 and 2 on 2026-11-08 (commits `6b3547451`, `0ad263fd0`). Each node has two accepted manifests (`20261111T121757…`, `20261111T235810…`).
  - Promotions: 2026-11-08 (2 new + 8 renewed), 2026-11-11 12:17 (B19 + 10 renewed, `STATE.md` "The ten previously accepted nodes were renewed"), 2026-11-11 23:58 (B20 + "all eleven predecessor renewals", `STATE.md:5`). That is ~29 node-renewals for 4 new acceptances after the first wave.
  - `evidence/B20/continuation-20261111/renewal-intake-r1`: 20,530 files / 2.94 GB of B20's 24,294 files / 3.69 GB (**~85% of files, ~80% of bytes**). Additional `b20-b19-renewal-*` dirs (controls r1–r3, compiled r2–r4). B19 `accepted-scope-renewals`: 4,006 files / 435 MB.
  - B21's census already finds "changed source pins in ten accepted nodes" (`STATE.md:3`), and `STATE.md:9` says "all changed accepted scopes still require renewal".
  - Out-of-roadmap commits that changed accepted sources on 2026-11-09/10: `a5ab1abb9` (sandboxing opt-in, 52 files), `d6ba4e839` (OpenTUI upgrade, 97 files), `66b98ed59`, `9bc57d16b`, `3029e2d82`, `a2259adf3` (memory recall/indexing, 43 files), `f5aba489d` (inline results/permissions, 53 files).
- Estimate: if every remaining promotion renews all prior nodes, finishing needs Σ k for k=12…38 ≈ **675 node-renewals vs 27 new acceptances**. On B20's measured split, 75–85% of effort per promotion goes to re-certifying old nodes, and the share rises with each acceptance.
- Impact: cost grows quadratically. Ordinary product work (the CLI commits above) is penalized because any touch of an accepted file triggers renewal.
- Fix: renew only when a node's *behavior tests* fail. Run the node's original test command in CI on every commit instead of byte-pinning sources (`sourceContractHashes` dicts with 15–154 entries per node). Batch renewals at weekly milestones.
- Cross-ref: new.

### roadmap-process-04 — Accepted B19/B20 work and the live ledger are uncommitted
- Axis: reliability. Severity: HIGH.
- Evidence: last commit touching `ledger.json`/`STATE.md` is `0ad263fd0` (2026-11-09 03:00 +0300). `git status --porcelain`: 77 modified + 54 untracked paths, e.g. `common/src/util/linux-process-scope.ts`, `common/src/util/owned-process-scope.ts`, `sdk/src/services/native-exec.ts`, `sdk/src/services/configured-host-execution.ts`, `rust/crates/openbuff-native/src/exec/{control,entry_waiter,linux_sandbox}.rs`. `git diff --stat`: 77 files, +9,289/−2,342. Zero commits on 2026-11-11 and 2026-11-12. Ledger `epoch` = `f5aba489d` while the bound sources exist only in the working tree.
- Impact: two "accepted" nodes and a large share of in-flight B21 code can be lost to a bad checkout or disk failure. They also aren't reviewable as diffs or visible in CI.
- Fix: commit each accepted node (product source and ledger) as its own commit; make "committed and CI green" an acceptance precondition.
- Cross-ref: new.

### roadmap-process-05 — STATE.md cannot tell a human what changed for users; no changelog exists
- Axis: usability (process). Severity: MEDIUM.
- Evidence: `STATE.md:3` is one ~450-word paragraph with 12 links. Examples of opaque phrasing:
  - "stable paired native-positive/write-file-stale successor … limited to pre-admission source SDK behavior" (`STATE.md:3`)
  - "An actual scoped D250 SDK consumer probe is proceeding with its original deadline" (`STATE.md:3`)
  - "physical completion and drained output by D250+G200+K200+J1000" (`STATE.md` B20 historical section)
  - "The 307 required command slots, 71 criteria and fresh prerequisite bindings retain their independently reviewed scope" (`STATE.md:7`)
  - "Ralph remains active and 27 nodes remain; source changes do not renew prior accepted bindings" (`STATE.md:13`)

  Accepted-node `coverageTier` strings are equally dense, e.g. B20's "exact66source contracts and ten recorded command packets,50original host receipts (37physical-positive/13qualified)…" (`ledger.json`, node B20). There is no `CHANGELOG*` anywhere in the repo (`ls CHANGELOG*` fails), and PLAN/SPEC contain zero occurrences of "changelog" or "user-visible".
- Impact: the owner cannot judge value delivered, and users can't learn what improved. The one plain-language user benefit of B20 ("no orphan processes after cancel on Linux") is never stated.
- Fix: add a one-line "user-visible change" field per node and keep a `CHANGELOG.md` updated on every acceptance and every product commit.
- Cross-ref: new.

### roadmap-process-06 — Priorities: the 12 accepted nodes are all reliability/assurance; high-value usability items sit behind long chains or are ready but idle
- Axis: completeness. Severity: HIGH.
- Evidence (from `completionGraph` in `ledger.json`; PLAN.md:83–122):
  - B34 concurrent workspaces has **15 unaccepted ancestors** (depth 6) because it requires B22 (the rusqlite daemon) and B27.
  - B31 has 11. B22 has 7 (B07, B15, B16, B21, M22-*).
  - B06 semantic edits waits only on B07 (ready). B12 memory, B10 prompt admission, B11 command discovery and B09 cost are **ready now** but idle while serial work continues on B21, a security-assurance node that matters only for opt-in sandboxing. Sandboxing became opt-in in `a5ab1abb9`.
  - B17 ACP needs only B15 (ready).
  - The original run used parallel lanes ("First worker queue: B02… B03… B04", `.omx/context/openbuff-body-execution-20261106T102953Z.md`). The current loop is serial.
- User-noticeable improvements so far (accepted nodes): B02 (true cancelled/failed state), B03 (no false "applied"), B05 (byte/EOL preservation, bounded huge reads), B08 (provider errors/retry/failover), B18 (exact approvals), B28 (MCP error/structured output), B36 (diagnostics not falsely "passed"), and partially B20 (Linux orphan cleanup). B01, B19 and B30 are invisible to users.
- Many visible UX gains this week came from commits *outside* the roadmap (`f5aba489d` inline result disclosure/interactive permissions, `d6ba4e839` OpenTUI upgrade, `9bc57d16b` message latency, `a2259adf3` memory recall), which then triggered renewals (finding 03).
- Fix: re-ordered queue in Recommendations. Cut B34's dependency on B22 by using git worktrees.
- Cross-ref: PLAN.md graph table lines 83–122.

### roadmap-process-07 — Scope gaps: the roadmap has no cards for onboarding, startup/latency budgets, prompt/tool-count discipline, cross-platform support or common competitor UX
- Axis: completeness. Severity: HIGH.
- Evidence: greps over PLAN.md/SPEC.md return 0 hits for "onboard", "first-run", "system prompt", "tool count", "prompt size", "changelog", "undo", "auto-commit", "web search", "theme". There are only 2 hits for "latency" and 1 for macOS. B20/B21 acceptance is Linux-only ("bounded cooperative Linux cleanup", `STATE.md:7`). Openbuff has 65 tool-param modules (`common/src/tools/params/tool/`), and no card bounds definition token cost. B32 records "comparable performance baselines" but sets no target.
- Impact: even a fully accepted roadmap would yield a truthful CLI, not a competitive one. See the gap table under Recommendations.
- Cross-ref: B32 (partial: baselines only), B09 (partial: cost accounting).

### roadmap-process-08 — Acceptance criteria demand OS/physical-level proofs beyond what users need, causing many retry rounds
- Axis: usability (process). Severity: MEDIUM.
- Evidence: B21 evidence has `native-artifact-build-20261112-r1` … `-r14` (14 rebuild rounds) and `host-native-ci-replay-20261112-r2` … `-r9`. Across B19/B20/B21 there are 240/379/214 `-rN` round directories and 98/457/32 `*review*` directories; 59/267/8 paths contain "fail". B20 needed a "delayed-marker successor review" because a supplemental sample was "0.574 ms early" (`STATE.md` historical B20 section). B21 requires "Authored fixture A passes using the actual checksummed installed binary without Python" (PLAN.md B21 Accept). B20's final review binds "307 command slots, 71 criteria".
- Impact: per-node effort is dominated by fixture timing, artifact identity and review lineage, not behavior. For B20 this is roughly 19 review dirs per accepted criterion-group.
- Fix: risk tiers (Recommendations §1). Keep physical/timing proofs for the security tier only.
- Cross-ref: new.

### roadmap-process-09 — Process tooling is itself a large, bespoke, untested-in-CI codebase
- Axis: cohesion. Severity: LOW.
- Evidence: 2,734 lines of Python in `docs/execution/body-roadmap/` (four `*-b19-*` scripts are untracked per `git status`), with long lines (`adjudicate-b19-oracles.py` 56 KB/618 lines). `test-validate-ledger.py` exists but is not in the 39-command CI census described in `STATE.md`. Node-specific runners (`run-b19-*.py`, `join-b19-captures.py`) don't generalize.
- Impact: maintenance burden; a second language toolchain inside a TS/Bun repo.
- Fix: replace with `bun test` suites tagged per node, plus one small ledger validator.
- Cross-ref: new.

## Competitive gaps

Capabilities a "best agentic CLI" needs that the roadmap does not plan (sources: public docs/READMEs of each tool as of my knowledge; treat details as approximate).

| Capability | Best-in-class and how | Openbuff roadmap state | Priority |
|---|---|---|---|
| First-run onboarding / provider setup | Claude Code: login flow and `/init` that writes CLAUDE.md. Gemini CLI: auth picker on first run. OpenCode: `opencode auth login` | Not covered (0 hits) | HIGH |
| Startup time and per-turn latency budget | Pi-Bolt: AOT-compiled Pi for fast cold start. Pi: minimal core | B32 baselines only, no target | HIGH |
| Tool-count / system-prompt size discipline | Pi: 4 tools (read, write, edit, bash) and a short prompt. Aider: small fixed edit formats | 65 tool param modules; no budget card | HIGH |
| Cost visibility and caps | Claude Code `/cost`. Aider per-message token/cost report | B09 (ready, not scheduled) | HIGH |
| Checkpoints / undo | Claude Code checkpoints and rewind. Gemini CLI `/restore` checkpoints. Aider `/undo` with git auto-commit | Snapshot CAS only (B04); no undo UX card | HIGH |
| Parallel agents in isolated trees | Common pattern with git worktrees in Claude Code and the Codex app | B34 behind 15 nodes | HIGH |
| Editor integration | Claude Code IDE extensions. Gemini CLI/Zed via ACP. Kiro IDE | B17 (ACP) behind B15 | MEDIUM |
| Cross-platform sandbox | Codex CLI: Seatbelt on macOS and Landlock/seccomp on Linux, with approval modes | B20/B21 Linux-only | MEDIUM |
| Headless / CI mode | Claude Code `-p` and GitHub Action. Codex `exec`. Gemini CLI non-interactive | Not a card (SDK exists) | MEDIUM |
| Extensions / skills marketplace | Claude Code plugins and skills. Gemini CLI extensions. Kiro powers/hooks/steering | B28/B29 fix semantics, no discovery/UX | MEDIUM |
| Web search/fetch built-in | Claude Code WebSearch/WebFetch. Gemini CLI Google Search grounding | B33/RWEB (browser) only | MEDIUM |
| Repo map for context | Aider repo map (tree-sitter + ranking) | B23/B24/B26 cover correctness, not ranking quality | LOW |
| User changelog / release notes | Claude Code, Codex and Gemini CLI publish release notes per version | Absent | MEDIUM |

## Strengths

Worth keeping, in lighter form:
- **Failed evidence is retained and never re-credited.** For example, the 42-of-43 evaluator attempt and the 31-of-32 oracle report stay preserved (`STATE.md` B20 historical section). This blocks quiet goal-post moving.
- **Independent review separate from implementation owners.** `verification.independentReviews[].reviewer` vs `implementationOwners` in each accepted ledger node (e.g. B01). The reviews have closed real defects, e.g. B19's callback-time expiry/permit reuse (`STATE.md` "Earlier checkpoint") and the missing `jobId` in the SDK error envelope (`STATE.md:3`).
- **Adversarial and negative controls.** The B20 "bare-leader negative control actually produced a late write" proves the test can fail. Cards specify stop conditions (PLAN.md "Verify/evidence/stop" on every card).
- **Explicit limits on every acceptance.** `risks` arrays and statements such as "Native confinement… remain outside this acceptance" (`STATE.md:7`) avoid overclaiming.
- **A dependency graph with a mechanical validator.** `validate-ledger.py` rejects unknown IDs and cycles. Ready-queue computation is cheap and correct.
- **Consumer-level checks** (packed CJS/ESM, rebuilt CLI read/edit/command) catch packaging bugs unit tests miss. B24 shows this matters for installed users.
- **Plan quality.** Each card names exact `file:line` defects and a concrete test command (PLAN.md:476+), so cards can be executed without re-auditing.

## Recommendations

### 1. Lighter process
1. **Acceptance tiers by risk.**
   - *T1 security/data-loss* (B04, B07, B18, B19, B20, B21, B22): keep independent review, adversarial controls and a frozen fixture. Allow at most one review round plus one repair round.
   - *T2 behavior* (most cards): acceptance is a green PR with the card's named test command plus new failure-path tests, one reviewer, and a 1-paragraph receipt.
   - *T3 assurance/internal* (B01, B27, B30, B31): tests only.
2. **Tests as evidence.** The card's `bun test …` command, run by CI on every commit, *is* the evidence. Store the CI run ID and the commit SHA, not copied sources, `.o`/`.rlib` files or logs. Cap stored evidence per node at ~50 MB and keep summaries of failed attempts (command, exit, 20-line excerpt).
3. **Renewal by regression, not by hash.** Drop byte-pinned `sourceContractHashes` as a renewal trigger. A node needs renewal only when its tagged tests fail or its card's public contract changes. Batch any semantic re-reviews weekly.
4. **Commit per acceptance.** "Accepted" requires a merged commit with CI green. The 2026-11-09 → 11-12 uncommitted window must not recur.
5. **User-visible changelog.** Add `CHANGELOG.md` (Keep-a-Changelog style) and a required `userVisibleChange` field per ledger node. STATE.md gets a 10-line top summary with no jargon (no D250, slots, successors, pins).
6. **Parallel ready lanes.** Run 2–3 ready nodes concurrently with disjoint ownership, as in the original first wave.
7. **Timebox.** If a node exceeds 2 days, the tier is wrong or the card is too big. Split it or land a lower tier.
8. **Evidence pruning now.** Disk is at 98%. Move B19–B21 build artifacts out of the tree, keeping hashes.

### 2. Re-prioritized order of the remaining 27 nodes
Dependencies respected. "→" means it can start once the prior node lands; items in the same step can run in parallel.

1. **B21 (timeboxed close-out):** land the current Linux opt-in sandbox at T1 with explicit limits, then stop. Do not start the native broker/daemon chain yet.
2. **B10** (no lost drafts), **B12** (memory), **B09** (cost/caps), **B32** (CI oracles and the first startup/latency/token baselines with targets). All are ready.
3. **B13** and **B14** (after B12), **B11** (command discovery/containment), **B23** (language identities).
4. **B24** (installed-CLI parser assets), **B26** (retrieval), **B25** (LSP).
5. **B07 → B06** (crash-safe and semantic multi-file edits).
6. **B15 → B17** (ACP/editor integration) and **B29** (custom agents).
7. **B34 re-scoped:** parallel lanes via git worktrees and an observed merge, depending on B06/B07/B17 but **not** B22.
8. **B16**, **B33** (with RWEB addendum).
9. **B27**, **B35**.
10. **M22-CORE → M22-TXN → M22-CHILD → B22**, then **B31**. Infrastructure and self-improvement come last, and only if a measured need appears (e.g. B34 shows worktrees are insufficient).

Also add new cards for the gaps in finding 07: first-run onboarding, a tool-count/system-prompt token budget with a CI check, checkpoint/undo UX, headless/CI mode, and macOS sandbox parity.

## Roadmap mapping

| Finding | Covered by |
|---|---|
| roadmap-process-01 | Not covered (process) |
| roadmap-process-02 | Not covered |
| roadmap-process-03 | Not covered; the renewal rule is in the execution protocol, not a card |
| roadmap-process-04 | Not covered |
| roadmap-process-05 | Not covered |
| roadmap-process-06 | Partially: graph in PLAN.md:83–122; ordering not addressed |
| roadmap-process-07 | Partially: B32 (baselines), B09 (cost), B17 (ACP); rest not covered |
| roadmap-process-08 | Not covered |
| roadmap-process-09 | Not covered |
