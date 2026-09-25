# Gate robustness verification — whole-refactor / n≈9000 gate cycles

Date: 2026-09-22. Scope: base2 handleSteps reviewer/validation gate
(`agents/base2/base2.ts`, `agents/base2/gate-reviewer.ts`, `gate-fingerprint.ts`,
`gate-paths.ts`) checked against the documented contract in
`docs/request-flow.md`. Method: 4 parallel read-only audit shards; full shard
findings in `findings/gate-verify-{a,b,c,d}-*.md`. Every conclusion below is
tagged CONFIRMED (code read) or INFERRED (reasoned from partial reads).

## Q1 — Will the gate survive n≈9000 incremental gate cycles? YES (bounded), with 2 caveats

**All gate-owned ledgers are bounded and reset at gate clear (CONFIRMED):**

- Reviewer/repair prompts do NOT embed growing history: the per-round ledger
  slices to 12 findings / 12 files with `+N more omitted`
  (`base2.ts:7008-7044`); `buildRepairEditorPrompt` is self-contained
  (`gate-repair.ts:121`).
- Condoned-finding lists cap at 200 (`base2.ts:7575` `slice(-200)`); review
  receipts cap at 24 entries × 4000 chars (`:10198-10203`); plan-task gate
  receipts cap at 24 (replaced per task).
- `openReviewerFindings` / `openReviewerBlockers` are REPLACED per reviewer per
  round, not appended (`mergeReviewerFindings`, `:7579-7645`).
- Finding ids do not grow unboundedly: `buildReviewerFindingId` mints
  `RF-<currentRoundIndex+1>-<fnv1a-8hex>` over the CURRENT round's blocker
  array (`:10597-10604`), explicitly documented "not a durable identity"
  (`:7499-7506`). The counter restarts every round.
- Gate-clear eviction is comprehensive (`:6568-6623`): open blockers/findings,
  condoned sets, owed revalidations, `pendingGateFiles.clear()`, and every round
  counter (repairRoundCount, reviewerCrashCount, reviewerProtocolRetryCount,
  specialistNoVerdictCounts, …) are zeroed. Fresh edits re-arm via
  `recordChangedFiles` (`:9209-9215`).

**Idempotent cheap re-runs (CONFIRMED):** identity is content-keyed — per-file
marker `sha256:<hash>:<byteLength>` (`:10354-10355`) → sorted `files-v4` details
(`:11573-11579`) → `v3:<64hex>` (`gate-fingerprint.ts`). An unchanged re-cycle is
a no-op via `hasFreshGateFingerprintForPendingFiles` (`:10373-10396`),
`hasDurableGatePassForPendingFiles` (`:10398`), and per-reviewer receipt skip
`gateId = ${reviewer}:${fingerprint}` (`:5221-5228`). Only drifted markers re-arm
(`:1634-1653`). So 9000 cycles over unchanged files do NOT do O(files×cycles)
reviewer work.

**Caveat 1 (INFERRED):** the conversation transcript grows per cycle (per-cycle
`add_message` gate-state/pinned blocks, `:1470`, `:5439`, `:6400`). The only
bound is runtime context compaction. Gate state itself is bounded.

**Caveat 2 (CONFIRMED) — the "crash like this" class:** reviewer-protocol
attestation failure (`reviewer-protocol-attestation-failed`) gets exactly ONE
auto-retry then PARKS (`:5372-5376` retry, `:5423-5453` blocked,
`reviewerProtocolBlocked` `:4614-4619`) with an explicit user escape
(`BYPASS REVIEWER <challenge-id>`, `:4620-4636`). It cannot loop forever — but
it also cannot self-heal, so a FALSE protocol failure stalls the whole run.
The false failure this session hit has a concrete root cause (see "The crash"
below) and is being fixed.

Other park-by-design paths (all bounded, all with an escape or fail-closed
documentation): reviewer crash retries once then parks on a
`BYPASS REVIEWER <id>` challenge (`:6351-6415`); only `transient` crashes
(429/overloaded/resource_exhausted) self-heal (`:4148-4164`); `protocol` and
`fatal` crash classes park (`:4166-4183`); step cap parks (`:1850-1853`);
non-attestable fingerprint (no crypto) parks fail-closed (`:3416`, `:3532`);
no-verdict self-heals with bounded retries (default 2, cap 10) and has a
user-bypass deadlock escape (`:6418-6428`). Repair budget defaults to
`POSITIVE_INFINITY` (`:1133`) — fine for incremental refactors but worth a
finite cap for runaway repair loops.

## Q2 — Are cleared files properly recorded? YES, with 2 MEDIUM gaps

**What is recorded on pass (CONFIRMED):** per-file `path → content-marker`
(`base2.ts:11845-11846`) in `gatePassedFiles` + `gatePassedFileMarkers`
(`creditGatePassedFiles` `:11456-11468`), plus pass-level
`gatePassedPendingFiles` / `gatePassedReviewerVerdict` (LOOKS_GOOD only) /
`gatePassedValidationSummary` / `gatePassedFingerprint` (`:6586-6594`). Review
receipts keep reviewer family (`gateId = ${reviewer}:${fingerprint}`,
`:10124`), verdict (`:10145`), snapshotFingerprint (`:10146-10147`), reviewedFiles
names, and `recordedAt` (`:10196`). Storage is durable in
`mutableAgentState.base2ActiveWork` (`:1161`, `:1469`) — survives turns AND
context compaction. Gap: the pass ledger has no per-file reviewer/receipt
provenance (pass-level only).

**Re-arm on edit (CONFIRMED):** exact comparison at `:1643-1647`
(`storedMarker !== currentMarker || !isCreditableContentMarker(...)` → evict +
re-pend `:1648-1652`); explicit-edit path `recordChangedFiles` (`:9123-9180`);
fingerprint reopen (`:1593-1623`).

**Deleted files (CONFIRMED, all 4 documented clauses):** marker `missing`
(`:1086`, lstat ENOENT `:11770-11771`); creditable attest-by-absence
(`:10366-10370`; deleted set excluded from the coverage requirement
`gate-reviewer.ts:283-287`); stays credited while absent (marker equality
`:1643-1647`); evicted on reappearance (stored `missing` ≠ current sha256
`:1645`).

**Unreadable files (CONFIRMED):** `unreadable:<code>` / no-crypto markers are
never creditable (`:11465`, `:1646`, `gate-fingerprint.ts:38-40`) and durable
reuse fails closed (`:10385-10395`).

**Gaps:**

1. MEDIUM (CONFIRMED path) — clean-tree committed-prune credits pending
   never-reviewed files into `gatePassedFiles` WITHOUT reviewer attestation
   (`:1943-1953`) and drops them from all later submissions. In a refactor that
   commits in waves, a file could skip review entirely.
2. MEDIUM (CONFIRMED) — fingerprint drift is tolerated when file NAMES are fully
   covered (`gate-reviewer.ts:302-307` blocks only on a coverage gap) =
   stale-byte credit, contradicting `docs/request-flow.md` ("A mismatch … is
   blocking"). Doc/code disagreement; the shipped code is more permissive.
3. LOW (INFERRED) — delete→recreate TOCTOU window (`:11459`); marker cache
   size+mtime fast path can serve stale markers (`:11641-11646`); conversation
   gate-reuse verdict regex-scraped from message text (`:10342-10344`), bounded
   by the durable fingerprint precondition (`:4488-4491`).

Credit from a DIFFERENT file's attestation is CLOSED (entry-scoped resolution,
`:7952-7955`).

## Q3 — Are only changed-since-clear + new files submitted? YES (incremental across clears)

**Per-cycle lists (CONFIRMED):**

- `run_file_change_hooks` gets `gateScopeFiles` =
  `deriveGateScopeFiles(dirty ∩ taskRelated \ gatePassedFiles) ∪ pending`
  (`base2.ts:4468-4472`, `:4752`, filter `:11540-11541`) — cleared files are
  excluded.
- code-reviewer gets `reviewableGateScopeFiles` (`:4669`, `:5173`, prompt
  `:5336`, attestation requirement `:5366-5371`).
- security-reviewer gets `securitySpawnFiles` = drifted subset else sensitive
  pending (`:2859-2862`, `changed_files` `:2886`).
- specialists get `specialistScopedFileSets` = drifted subset else
  aux-relevant pending (`:3352-3358`, `:3463-3466`).
- Within one cycle, repair rounds resubmit THAT cycle's pending set (`:5014`,
  `:6254`) — by design (the repairs changed those files).

**"Already attested LOOKS_GOOD … bytes may have changed since"** (generated in
`buildReviewerRoundLedgerLines`, `:7042`, `:7051`) is DEPTH GUIDANCE ONLY
(`:7063`): listed files stay REQUIRED in `reviewedFiles` — the spawn says
"still attest to every pending file" (`:5352-5354`) and
`collectReviewerAttestationIssues` has no exemption (`gate-reviewer.ts:283-315`,
BLOCKING at `:312-315`). Entry-scoped resolution (`:181-193`) means a prior
receipt can never lend coverage to a changed file. Correct.

**New files (CONFIRMED):** brand-new/untracked files enter the pending set and
are submitted — `recordChangedFiles` (`:9122-9124`) fed by tool edits
(`:1866-1872`), message-side edits (`:1896`), and git-status absorption
including untracked (`:1989`; `parseGitStatusLine` `:11927-11937` drops only
untracked DIRECTORIES).

**Failure modes hunted:**

- (a) changed-but-dropped files: PARTIAL HIT — only via the Q2 gap #1
  committed-prune (`:1943-1953`); every other drop vector is defended (marker
  eviction `:1644-1651`, re-arm `:11521-11528`, scope/byte reopen
  `:5162-5171`, `:6535-6550`).
- (b) unchanged files re-submitted every cycle: REFUTED (cleared exclusion
  `:11540-11541`, pending reset per pass `:6581-6585`, identical
  family+fingerprint+file-set reviews skipped `:5221-5228`).
- (c) monotonic pending growth across clears: REFUTED (`:6581-6582`, `:4513`).

## Q4 — Do records differentiate code-reviewer vs specialists? MOSTLY YES, 3 identity gaps

**Differentiation (CONFIRMED):** stored finding records carry a `reviewer`
field plus family-prefixed `gateId` (`base2.ts:2928/2939`, `3763/3771`,
`5678/5799`; `reviewerFamilyFromFinding` `:7366-7380`). Attestation is evaluated
PER FAMILY with its own fingerprint + reviewedFiles (security `:2909-2914`,
per-agentType specialists `:3604-3610`, code-reviewer `~:5468`), all through
`collectReviewerAttestationIssues` (`gate-reviewer.ts:205`) with fail-closed
conflicting-verdict / conflicting-fingerprint blockers (`:236`, `:260`). One
family's verdict cannot satisfy another's attestation; gate-pass credit is
family-scoped (`:3787-3794`, `:7411-7446`, `:2790-2799`) with fail-closed
routing (`:4664-4668`, `:7350-7351`). `agentReceipt.role` is recorded
(`'reviewer' | 'security-reviewer' | 'specialist'`, `agent-handoff.ts:4-22`), and
the pinned round ledger + `owedReviewerRevalidations` carry full agent names
(`:6980`, `:7388`). No cross-credit of a specialist's LOOKS_GOOD as the
code-reviewer's pass was found.

**Gaps:**

1. MEDIUM — `reviewerOriginFromGateId` is BINARY: every specialist gateId maps
to `'code-reviewer'`, and the owed-reviewer re-arm reads `findings[0]` only
(`:6265-6269`), so multi-family findings can re-arm the wrong reviewer.
2. MEDIUM — condone keys are `${class}::id:${id}` and NOT
reviewer-namespaced (`:7508-7536`): two reviewers emitting the same free-form
id (reviewer-chosen prefixes are arbitrary — e.g. `sec-tokencounter:…`) can
collide, and condoning one condones the other. Plain `RF-…` ids collide on
same text+index (partially mitigated for condone by
`isMintedReviewerFindingId` `:7504`).
3. LOW — repair-progress checks accept ANY family's open finding id (unfiltered
`openSecurityFindingIds` `:3086-3098`); the structured repair handoff drops the
`reviewer` field (`agentFindingSchema`, `agent-handoff.ts:52-58`).

## The crash ("like this") — root cause and fix

Symptom: `Protocol failure: BLOCKING: reviewer did not return the required
structured snapshot attestation` repeating until the gate parks, despite
security reviews returning LOOKS_GOOD with valid fingerprints (receipts
`zGNm9sjIM7Q`, `zGcWXGCbqoM`, rev 5068).

Root cause (CONFIRMED against `gate-reviewer.ts:910-1073`): the structured
verdict walker `visitForStructuredVerdict` recognizes verdicts at the JSON
block surface (`record.type === 'json'` → visit `record.value` and RETURN,
`:926-929`). `spawn_agent_inline` results embed the review under
`agentReceipt.review` as a SIBLING of the json `value` — the early return
skips it, so the walker finds zero shaped entries and the attestation check
fails closed with the protocol message (`:218-220`), even though the review
exists and is valid. (The batch `spawn_agents` path — used by the code-reviewer
— surfaces the verdict inside `value`, which is why only the security round
was failing.)

Fix direction (recognition-only): teach the walker to also visit the
`agentReceipt` envelope (`review` / `output.value`) alongside the json `value`,
merging receipt-level `schemaVersion` when the review object omits it. No
loosening of fingerprint/coverage/entry-scoping checks. Plus regression tests
and the regenerated `<gate-helpers-generated>` inline copy in `base2.ts`.

## Recommendations (not yet implemented)

1. Fix the walker envelope recognition (in progress — the crash fix).
2. Q2 gap #1: don't credit committed-prune files without attestation — evict
   them or keep them pending until a review covers their bytes.
3. Q2 gap #2: reconcile docs and code on fingerprint drift (either block on
   mismatch as documented, or document the drift-tolerant behavior).
4. Q4 gaps: namespace condone keys by reviewer family, widen
   `reviewerOriginFromGateId` beyond binary, filter repair-progress checks to
   the owed family.
5. Consider a finite repair-round cap (instead of `POSITIVE_INFINITY`) for
   runaway loops in very large refactors.
