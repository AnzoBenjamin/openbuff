# LESSONS — Over-strict Agent Guardrail Audit

## Process lesson (why this session exists)

The first pass treated the user's git-committer _example_ as the whole scope and
only audited the terminal-command policy. The request was a GENERAL sweep. Lesson:
when a user gives "X, for example", X is one instance — measure breadth and shard
across ALL sibling surfaces, don't tunnel on the example.

## Cross-cutting pattern: substring/whole-token over-matching

The same over-strictness recurs in unrelated subsystems:

- sensitive-paths.ts: basename.includes('kubeconfig'/'.tfstate') blocks docs/scripts.
- ripgrep allowlist: whole-token match rejects combined `-ni`.
- /git args: raw-input char class blocks `()[]{}` even though args are single-quoted.
  Fix shape is identical each time: match the real artifact/operator precisely; stop
  conflating "mentions the dangerous thing" with "is the dangerous thing".

## Guidance-vs-enforcement contradictions

git-committer (F1): the prompt tells the model to do exactly what the policy blocks.
Whenever a guardrail and the guidance are authored separately, they drift into
conflict. Co-locate or cross-test them (there is already a security-glob-parity test
doing this for the reviewer globs — a good model to copy).

## Authority-derivation traps (highest risk)

spawn-agent-utils deriveSpawnTemplateCapabilities has three "narrow on handoff"
behaviors that over-fire: empty readablePaths -> zero reads (HIGH), spawnableAgents
forced [], programmaticToolNames intersected with model-visible allowedTools. The
static template list is already the ceiling (getMatchingSpawn), so several of these
narrowings are redundant AND breaking. Redundant-but-breaking is worse than
redundant-but-inert.

## What NOT to touch

SSRF (host/IP/redirect revalidation), .env/private-key/credential denials,
project-path containment, cap.v3 HMAC+scope, replace_range authority chain,
plan-only terminal attenuation, force/default-branch push gating. These are precise
and load-bearing; the audit deliberately classified them KEEP.

## Tooling gotcha

general-agent cannot call code_search directly (not granted). Discovery shards must
use read_files/read_subtree/query_index or spawn a code-searcher. Several parallel
general-agents also hit transient upstream/rate-limit errors — keep audit waves
small (<=4-5) and re-run only the missing shards by checking the findings/ dir.

<!-- update_plan_status:appended -->

## Tier 1 execution — 2026-07-24T07:35:28.290Z

- PLAN preflight rejects `Depends on: none` — omit dependency lines when there are none.
- Empty handoff readablePaths must preserve undefined read scope, never emit `read: []`.
- security-reviewer LOOKS_GOOD on spawn-agent-utils, find-files-matching-content, git-command-args (receipt kwvcyLW4E1g).
- Validation receipts: spawn-agents-permissions kwPDvM-wCIg (35 pass); find-files-matching-content kwPDwKZR-Js (26 pass); git-command-args kwPDxEHrdNM (8 pass).

<!-- update_plan_status:appended -->

## T1.3 decision — 2026-07-24T07:47:24.219Z

Did not carve HEREDOC into git-commit policy. Multi-line commits already work via multiple -m flags (tested). Fixed the guidance contradiction in git-discipline.ts only — safer and smaller than expanding shell syntax under git-commit.

<!-- update_plan_status:appended -->

## Circuit-breaker drain gaming — 2026-07-24T08:50:49.803Z

Drain-by-1 on clean str_replace success looks like recovery but allows fail↔success oscillation to stay forever below the limit. Prefer non-draining success (leave counter unchanged) with a modestly higher limit (5) for mid-refactor friction. Never full-reset on success within a turn.

<!-- update_plan_status:appended -->

## Specialist gate vs plan markdown — 2026-07-24T09:13:35.902Z

Session markdown under .agents/sessions/ is often non-reviewable source; specialist attestation should target the real source pending set. Stale pending paths (e.g. general-agent.ts with no diff) can linger from earlier turns—confirm with git status before chasing phantom blockers.

<!-- update_plan_status:appended -->

## Commit gate re-arm — 2026-07-24T15:00:42.421Z

After any source/test edit (including database.test isolation), git-committer is withheld until hooks+reviewer pass again. Do not tight-loop spawn; wait for gate-state passed, then commit source+docs only.

<!-- update_plan_status:appended -->

## Reviewer double-spawn and terminal-stop (addresses finding RF-1-eef7064f) — 2026-07-24T15:28:15.818Z

This entry is the durable resolution of open reviewer finding RF-1 ("Explain why reviewers spawned twice despite a clean first run, and why the run stopped after the second completion").

**Why a second review spawned after a clean first run.** The gate attests to a _(snapshot fingerprint, pending file set)_ pair, and it re-arms on every edit. The first review returned LOOKS_GOOD against an earlier snapshot whose pending set did NOT include sdk/src/**tests**/database.test.ts. After that review, the database.test.ts full-suite isolation fixes landed (namespace import of ../impl/database, clearUserInfoCacheForTests(), beforeEach mock.restore()). Each edit bumped the workspace revision and added database.test.ts to the pending set, so the earlier attestation no longer covered the current pair. A second review was therefore required by design; the gate correctly refuses to reuse a stale approval over files it never saw.

**Why the run stopped after the second completion.** The second attempt routed to migration-reviewer, which returned specialist-terminal-failure. Two compounding causes: (1) wrong specialist for the diff — nothing in the change set touches schemas, backfills, migrations, or rollbacks, so migration-reviewer had no surface to bind an attestation to; (2) the gate allows one automatic snapshot refresh when the tree moves under a bound reviewer, and that single retry also failed to produce a matching attestation, so it aborted. The harness then fail-closed (a terminal reviewer failure is neither an approval nor a finding-with-a-fix) and did NOT spawn repair-editor, because there was no code defect to repair.

**Resolution path.** A fresh matching code-reviewer was run against stable snapshot e0088f39... (workspace revision 542) covering all 27 pending files: verdict LOOKS_GOOD, coverage covered, zero blocking findings (only two non-blocking pre-existing SSRF notes). This LESSONS entry records the explanation durably so the runtime gate reviewer can attest the RF-1 requirement as satisfied.

**Reusable takeaway.** Route reviewer specialists to the actual risk surface of the diff. A specialist with no matching surface (migration-reviewer on a non-migration diff) is prone to terminal failure and should not be selected; the general code-reviewer is the correct gate reviewer for guardrail/policy relaxations with no schema surface.
