# Review-gate correctness & convergence plan (rev 3)

> **Progress is tracked outside this file.** This document is the design: conclusions, evidence, tiers, sequencing. It carries no status markers by design, so nothing here goes stale as work lands.
> - `STATUS.md` — what has landed (with verified code citations), what is open and why, and resume instructions.
> - `LESSONS.md` — decision records (incl. the T1.4d architect decision) and gotchas.
>
> Tier 0 is closed and Tier 1 is mostly closed; T1.2(a), T1.2(c), and T1.4d remain open. Tier 2/3 are still gated on the sequencing step-8 re-measurement below.

Rev 3 supersedes rev 2 after adversarial review by `architect` and `thinker`. Eleven architect findings and three thinker findings are folded in. Material changes from rev 2:

- **New Tier 0** — a live authority hole: the condoned-pass branch bypasses the gate's own coverage/requirement hard rules. Found by the architect while verifying rev 2's evidence; independently confirmed at `base2.ts:4650-4655`.
- **H2's identity half is restored** as T1.5. Rev 2's decisive drop reason ("adds another persisted structure") was **factually false** — `openReviewerFindings` already is an id-keyed ledger with rehydration wired. Only the changed-files admissibility rule stays dropped.
- **T1.2(c) is withheld** until id-keyed condoning lands. As written it defeats the only convergence mechanism rev 2 keeps.
- **T1.3 resequenced before T1.2(a)** — the "advisory channel" T1.2(a) writes into does not exist yet.
- **New T1.6** — fingerprint cycle detection. The existing no-progress guard compares only against the immediately preceding fingerprint, so an A→B→A oscillation never trips it. Neither rev 1 nor rev 2 saw this.
- Tier gating stated once; T1.1 durability resolved; T1.3 migration hazard named.

## Governing conclusions

1. **The current prompt makes termination logically impossible.** "Find ways to improve the code changes" is a search that succeeds on any non-trivial file; "Do not emit `LOOKS_GOOD` while any findings remain" then forbids stopping. The acceptance predicate is unsatisfiable by construction — a divergence proof readable off `code-reviewer.ts` alone, not a probabilistic argument. Fixing the generator (T1.2) is the highest-confidence item here.
2. **Cross-round memory is an optimization for expected-case termination and a necessity for any worst-case bound.** With a stateless reviewer there is no monotone decreasing quantity to induct on. Rev 2's "fix the generator and drop the ledger" was half right: fix the generator *and* repair the memory that already exists.
3. **Locality does not bound the observed pathology.** New findings decompose into repair-induced (scales with edit size; contracts as repairs shrink) and **rediscovery** (findings about code the previous sample happened not to mention — not caused by the edit, so locality does nothing). Rediscovery dominates under an unbounded rubric. This is why "repair edits are small" never saved this loop, and why bounding the rubric precedes any output filtering.
4. **Enforcement belongs on the orchestrator side, never in new required reviewer output fields.** More required fields raise schema-non-compliance probability, and non-compliance routes to `currentPhase = 'blocked'` after one bounded retry — worse than an extra nit round. The condone credit is orchestrator-owned and costs zero protocol risk.

## Prior attempts (read before proposing anything)

| Commit | Subject |
|---|---|
| `6b5b035db` | Harden gate TUI and reviewer loop convergence |
| `bf31b9f3d` | harden the base2 specialist reviewer gate and its repair loop |
| `4573e2753` | Harden reviewer and validation gate against stalls, loops, and churn |
| `2d6ad7c27` | fix structured reviewer retry loop |
| `933dd440e` | add explicit MAX_REVIEWER_REPAIR_ROUNDS cap to reviewer-repair loop |
| `ff2ff4e24` | Run reviewer repair loop until findings clear |

The last two are opposite directions — a cap added, then removed for "run until findings clear." The fossil is still in `common/src/util/gate-repair-budgets.ts`: `DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS` is `null`, commented *"@deprecated Omitted option/env means unlimited, not these values."*

Every one of those fixes was unfalsifiable when it shipped: no per-round finding telemetry exists, so each author decided on judgment. **Do not add a seventh judgment-based fix without instrumentation.**

## Evidence base (verified reads)

| Fact | Location |
|---|---|
| Only `LOOKS_GOOD` finalizes; `NON_BLOCKING` is repair fuel | `gate-reviewer.ts:464-499`, `:319-334` |
| **Condoned pass pre-sets the verdict** | `base2.ts:4121-4127` |
| **…and the derivation is guarded, so the hard rules never run** | `base2.ts:4650-4655` (`if (!reviewerFinalizationVerdict)`) |
| `getReviewerFinalizationVerdict` is the only enforcement of `coverage: missing` and in-scope `missing`/`uncertain` | `gate-reviewer.ts:471-491` |
| Those hard rules are emitted as plain strings the condone capture can absorb | `gate-reviewer.ts:288-315` vs `base2.ts:4529-4539` |
| `recordSuccessfulReviewReceipt` returns early on `BLOCKING` ⇒ all-condoned BLOCKING round passes with **no receipt** | `base2.ts:6927-6932` |
| Fabricated verdict is persisted | `base2.ts:4842-4843` |
| Reviewer prompt is an unbounded generator, and self-contradicts | `code-reviewer.ts` instructionsPrompt |
| Condoning is exact-string after stripping the verdict prefix | `base2.ts:4093-4103`, capture `:4529-4539`, cleared `:4828` |
| Prefix stripping is severity-blind ⇒ NON_BLOCKING→BLOCKING escalation of identical text is swallowed | `base2.ts:4097-4101`, `:4530-4532` |
| **`openReviewerFindings` already is an id-keyed ledger** (`id`, `gateId`, `text`, `status: open\|resolved\|condoned`, `files[]`, `snapshotFingerprint`, `reviewer`) | `gate-state.ts:111-122` |
| …with rehydration already wired | `base2.ts:904` |
| …and `mergeReviewerFindings` already flips records to `condoned` | `base2.ts:5192-5206` |
| …and repair reconciliation is already id-keyed | `base2.ts:4493-4511`, `:4525-4528` |
| Condone credit is unverified self-report; `reviewerRepairHasProgress` (any changed file) short-circuits completeness | `base2.ts:4498-4511` |
| Finding identity has three owners: reviewer-supplied id, FNV hash of text, raw condone text | `gate-reviewer.ts:627-634`; `base2.ts:7459-7466`; `:4090-4101` |
| code-reviewer path is the only one that does **not** correlate reviewer ids (security/specialist do) | `base2.ts:4218-4232` vs `:2047-2054`, `:2688-2696` |
| Object findings render as `[id] summary` ⇒ ids churn every text-keyed identity | `gate-reviewer.ts:548-560` |
| `retainedBlockers` matches by substring | `base2.ts:5214-5221` |
| No-progress guard compares **only** the immediately preceding fingerprint | `base2.ts:4551-4575`; specialist `:2962-2995` |
| Bare-string findings never become `findingRecords` (`if (!id \|\| !text) return []`) | `gate-reviewer.ts:623-634` |
| ⇒ a `LOOKS_GOOD` receipt with bare-string nits records `findings: []` | `base2.ts:7042`, `:7069` |
| Receipt state + parsers already accept optional `severity`/`dimension` | `gate-state.ts:32-43`; `gate-reviewer.ts:639-644` |
| Findings carry `evidence: string[]` prose; `files[]` exists but is populated with the **whole pending set** | `code-reviewer.ts` schema; `base2.ts:4183`, `:4224` |
| Rubric reaches the model only as a pointer, uniquely targeting a `.ts` module | `base2.ts:154-155`, `:516`; siblings `:146-153` |
| Dead-env-canary trap: with a default-ON flag, `envFlag \|\| DEFAULT` can never read the env | `base2.ts:87-94` |
| Repair budgets resolve missing→null→unlimited; surfaced in `/context` | `base2.ts:100-123`; `gate-repair-budgets.ts:28-46`; `cli/src/commands/context.ts` |

---

# Tier 0 — live defect, fix before anything else

## T0.1 — The condoned pass bypasses the gate's own hard rules

**This is a defect in shipped code, not in a proposal.** It is also the only item here that can let a genuinely incomplete change through, so it precedes every improvement.

Mechanism, end to end:

1. `collectReviewerBlockers` emits coverage/requirement hard rules as plain strings, e.g. `"BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)"` (`gate-reviewer.ts:288-315`).
2. A prior repair round reported some finding addressed, so its text entered `condonedFindingTexts` (`base2.ts:4529-4539`).
3. On re-review the condone filter suppresses every collected blocker, so `blockers.length === 0` while `collectedBlockers.length > 0` (`:4093-4103`).
4. That branch assigns `reviewerFinalizationVerdict = 'LOOKS_GOOD'` directly (`:4121-4127`).
5. The derivation at `:4650-4655` is guarded by `if (!reviewerFinalizationVerdict)`, so **`getReviewerFinalizationVerdict` never runs** — and it is the only place `coverage: "missing"` and in-scope `requirementCoverage` `missing`/`uncertain` are enforced (`gate-reviewer.ts:471-491`).
6. `recordSuccessfulReviewReceipt` returns early for a `BLOCKING` verdict (`:6927-6932`), so the pass is credited with **no review receipt at all**, and the fabricated verdict is persisted as `gatePassedReviewerVerdict` (`:4842-4843`).

Fix — make condoning **blocker suppression only, never verdict authority**:

```
// at the condoned-pass branch (base2.ts:4121)
// do NOT assign reviewerFinalizationVerdict here.
// Suppress blockers, then let the normal derivation decide:
const condonedVerdict = getReviewerFinalizationVerdict(reviewerToolResult)
if (condonedVerdict === 'LOOKS_GOOD') { ...credit as today... }
else { keep the round open — coverage/requirement rules still stand }
```

Remove the `if (!reviewerFinalizationVerdict)` guard's dependence on the condone path, or at minimum re-run the coverage and requirement checks before crediting. Never let the condone path fabricate a verdict.

Note the interaction with T1.4b: rev 2 promised to teach implementers that "uncertain blocks exactly like missing," which is currently *not* reliably true. Fixing the code and the guideline together avoids documenting an aspiration.

Acceptance: an all-condoned round whose receipt carries `coverage: "missing"` or an in-scope `uncertain` requirement does **not** pass. Add e2e coverage in `agents/e2e/gate-lifecycle.e2e.test.ts`.

## T0.2 — Condone credit must be backed by evidence

Condoning is credited purely from the repair-editor's self-reported `findingsAddressed`, with no check that the claimed finding was touched. Worse, `reviewerRepairHasProgress` — true when *any* changed file path exists — short-circuits the completeness check, so a receipt with `status: 'blocked'` and unaddressed ids still condones every id it lists (`base2.ts:4498-4511`, `:4525-4539`).

This is the rubber-stamping risk, located in the orchestrator rather than the reviewer. Fix (zero protocol-failure cost, because no reviewer output changes):

- Only condone a finding id the receipt both lists in `findingsAddressed` **and** backs with at least one `changedFiles` entry.
- Require `receipt.status === 'completed'` for condoning even when other progress exists. Keep `reviewerRepairHasProgress` for loop-continuation decisions; do not let it authorize condoning.
- Log rejected condone claims via `emitGateTelemetry` so T1.1 can count them.

Acceptance: a repair receipt that lists ids without changed files condones nothing; the finding stays open.

---

# Tier 1 — ship these

Gate statement, stated once: **T1.1 data gates Tier 2. Tier 3 follows re-measurement.** No other tier gate exists.

## T1.1 — Per-round telemetry + shadow mode  ← first

`emitGateTelemetry` already carries `repairRound` and `skipReason`. Add per round:

- `findingCount`; severity histogram once T1.3 lands (before that, one `unlabeled` bucket)
- `newFindingCount` vs `carriedFindingCount`
- reviewer wall-clock; reviewed-file count
- terminal outcome: `passed` / `blocked` / which `lastReviewerGateSkipReason`
- **rejected condone claims** from T0.2

**Durability (architect finding 9).** Rev 2 defined round-over-round comparison against generator locals while forbidding new persisted state — so the counterfactual would silently degrade across a serialized turn, which is exactly when the metric matters (`base2.ts:4863` resets round count only on gate pass; rounds are expected to span serialization). Resolution: derive the comparison from **already-persisted** state — the prior round's `openReviewerFindings` plus `reviewReceipts`. If that proves insufficient, grant T1.1 one explicit persisted field with a `??=` default at `base2.ts:889-917` and say so; do not leave it on locals.

**Shadow mode.** Compute what a severity threshold *would* decide and log it without enforcing:

```
would-suppress: 4 of 6 findings (severity low / unlabeled-hygiene)
would-have-passed-at-round: 1 (actual: 4)
```

Acceptance: after N real turns you can state the nit-driven share of rounds and what a threshold would have let through.

## T1.2 — Fix the generator

The highest-confidence behavioral item: it removes a logical obstruction, not a heuristic one.

**(a) Resolve the contradiction.** One rule: `LOOKS_GOOD` when nothing requires a code or contract change; cosmetic observations go to the advisory channel. **Sequenced after T1.3** (architect finding 4) — bare-string findings on a `LOOKS_GOOD` receipt are surfaced nowhere today (`gate-reviewer.ts:275-334` emits no blockers for `LOOKS_GOOD`; `:623-634` drops findings without ids; `base2.ts:7042`/`:7069` therefore record `findings: []`). Shipping (a) before the channel exists silently discards the nits. Acceptance gate: a `LOOKS_GOOD` receipt's advisory findings must appear in `reviewReceipts` and in the CLI.

**(b) Bound the generator.** Replace "find ways to improve" with a finite completeness criterion: enumerate every violation requiring a change in one pass, then stop. Make "do not drip-feed" the framing rather than an aside. Per conclusion 3, this is what shrinks the rediscovery term; nothing else in this plan does.

Target the three convergence conditions explicitly: a satisfiable empty set ("nothing requires a change", not "nothing could be improved"); monotonicity under repair (findings must be over properties a repair can clear — taste-based findings are not monotone); and low churn sensitivity (violation-driven, not proportional to code in view).

**(c) Round ledger as a verification checklist — WITHHELD until T1.5.** The intended prompt:

```
Repair round: N. This is a re-review.
Findings raised earlier and reported addressed — verify each is genuinely
fixed and cite the line that fixes it. If a fix is wrong or incomplete,
re-raise it and say why:
  - <ledger entries>
Files the last repair changed: <paths>
```

**Why withheld (architect finding 2, decisive).** Condoning is exact-string equality (`base2.ts:4093-4103`). "Re-raise it and say why" changes the text, so the re-raise escapes the filter and re-enters the repair loop — while a *verbatim* re-raise of a genuinely unfixed blocker gets swallowed. T1.2(c) is therefore simultaneously suppressed and loop-amplifying depending on wording: the exact "reword problem" rev 2 cited as grounds to drop H2, reintroduced via prompt. Ship (c) only after T1.5 re-keys condoning on finding id — or, as a fallback, instruct re-raises to repeat the original text verbatim with the reason on a separate line the matcher strips. Also note: shipping (c) before T0.1 would worsen the escaped-defect path.

## T1.3 — Optional `id` / `severity` / `dimension` metadata

No thresholding. Nothing gates on it. Extend `code-reviewer.ts` findings to accept the specialist-style object shape **alongside** bare strings, with new fields **optional, never required** (conclusion 4). The plumbing already exists (`gate-state.ts:32-43`, `gate-reviewer.ts:639-644`); only the emitting schema is missing.

**Also route code-reviewer through id correlation (architect finding 7).** Finding identity currently has three owners, and the code-reviewer path always uses `buildReviewerFindingId(text, index)` (`base2.ts:4218-4232`) while security (`:2047-2054`) and specialist (`:2688-2696`) paths correlate reviewer-supplied ids via `record?.id ?? buildReviewerFindingId(...)`. Without this, T1.3's ids never reach `openReviewerFindings` and T1.5 has nothing to key on. Add the parity assertion to `gate-reviewer` tests.

**Migration hazard (architect finding 8).** Once findings carry ids, the parser renders each as `[id] summary` (`gate-reviewer.ts:548-560`), changing blocker text — which churns `condonedFindingTexts`, the FNV `buildReviewerFindingId` hashes, and `mergeReviewerFindings`' substring retention (`base2.ts:5214-5221`). Handle sessions mid-loop across the change: either clear `condonedFindingTexts`/`openReviewerFindings` on shape mismatch, or make the matcher strip a leading `[id] ` token. Rollback must not leave `[id] `-prefixed condone keys that can never match.

Acceptance: severity/dimension appear in telemetry and the advisory list; gate decisions byte-identical; legacy bare-string findings still parse and still **block** (never silently downgraded to advisory).

## T1.4 — Fix the guidelines

### T1.4a — the rubric barely reaches the model

`progressivePromptDisclosure` defaults ON, so `base2.ts:516` emits only `preReviewSelfCheckPointer`, and that pointer (`:154-155`) uniquely targets a TypeScript module while every sibling targets `agents/guides/*.md` (`:146-153`).

- Create `agents/guides/pre-review-self-check.md` with the full rubric (T1.4b content).
- Repoint to that guide.
- Extend the pointer/guide pairs at `agents/__tests__/base2-progressive-disclosure.test.ts:186-192`.
- Leave `agents/editor/editor.ts:220` interpolating the section in full.

### T1.4b — mirror what actually blocks

Add to `preReviewSelfCheckSection`: requirement coverage (`uncertain` blocks like `missing` — subject to T0.1 making that true); file attestation (every pending file read and accounted for; changed tests are first-class targets); coverage naming (name the exact test file and case; `coverage: "missing"` auto-blocks); advisory vs blocking (cosmetic observations do not hold the turn; do not pre-emptively refactor for style).

Keep the existing 7 bullets. The section is explicitly not byte-frozen (`agents/__tests__/quality-prompt-snapshot.test.ts:59-72`); extend those topic assertions. **Do not edit `qualitySection`** — byte-frozen with a snapshot test and duplicated into `agents/guides/code-craftsmanship.md`.

### T1.4c — stop rubric/reviewer drift

Add `agents/__tests__/review-rubric-parity.test.ts` asserting every blocking rule in `code-reviewer.ts` has a matching topic in `preReviewSelfCheckSection` (keyword table: `requirementCoverage`, `uncertain`, `coverage: missing`, `reviewedFiles`, the five dimensions). Follows the `gate-helpers-freshness` / `gate-reviewer-parity` precedent.

### T1.4d — inline fallback for guide pointers in external workspaces (open)

Progressive prompt disclosure defaults ON, and every guide pointer names a path under `agents/guides/` that `read_files` resolves against the user's workspace root. Inside the openbuff repo that resolves; in any embedder workspace the read fails and the model silently loses all five relocated sections. Resolution options, not yet chosen: gate the default to workspaces that actually contain `agents/guides/`, or have `disclose()` emit the pointer plus an inline copy of the section when the guide is unreachable. Partially mitigated: every pointer now carries an explicit "if that guide is unavailable" clause with the compact inline rules, so an embedder degrades to summarized guidance instead of a failed read; emitting the full section bodies on an unreachable guide remains open. The guide-pointer comment block in `agents/base2/base2.ts` references this item.

## T1.5 — Re-key condoning on finding id (H2's identity half, restored)

Rev 2 dropped this claiming it "adds another persisted structure with its own migration and desync modes." **That was false.** `openReviewerFindings` (`gate-state.ts:111-122`) already carries `id`, `gateId`, `text`, `status: 'open' | 'resolved' | 'condoned'`, `files[]`, `snapshotFingerprint`, `reviewer`; rehydration is wired at `base2.ts:904`; `mergeReviewerFindings` already sets `condoned` (`:5192-5206`); repair reconciliation is already id-keyed (`:4493-4511`). This is a refactor of existing state, not new state.

Changes:
- Condone by `openReviewerFindings[].id` instead of raw text, in both the filter (`:4090-4101`) and `mergeReviewerFindings` (`:5197-5206`).
- **Key on (verdict class, id), not prefix-stripped text** (architect finding 6). Today both prefixes map to one key, so a NON_BLOCKING finding escalated to BLOCKING with identical text is silently suppressed and can trigger the all-condoned pass.
- Keep reading legacy `condonedFindingTexts` on resume so an in-flight session does not lose convergence progress and restart the loop.
- Unblocks T1.2(c).

**Still dropped: the changed-files admissibility rule.** Rev 2's reason was imprecise (architect finding 10) — the repair side is structured `{ path: string }[]` (`base2.ts:4500-4503`) and `files[]` exists on every finding (`gate-state.ts:117`); the real defect is that it is populated with the entire pending set (`:4183`, `:4224`), so it carries no per-finding attribution. That makes admissibility a *field-semantics* problem, not an impossibility. Revisit only if T1.1 shows persistent `newFindingCount > 0` on untouched files after T1.2 — and if so, populate `files[]` from the finding's cited path first.

## T1.6 — Fingerprint cycle detection (new; missed by rev 1 and rev 2)

The no-progress guard compares only against the **immediately preceding** fingerprint (`base2.ts:4551-4575`), so an A→B→A oscillation changes the fingerprint every round and never trips it. Keep a `Set<string>` of snapshot fingerprints seen this turn in `handleSteps` **loop scope** — no persisted state — and fail closed on a repeat.

This is strictly stronger than a round cap and is **not** a re-litigation of `933dd440e`/`ff2ff4e24`: it fires on demonstrated non-progress, not a guessed budget. Apply the same treatment to the specialist loop (`:2962-2995`).

Acceptance: a synthetic A→B→A repair sequence terminates with a `reviewer-repair-cycle` skip reason instead of looping.

---

# Tier 2 — evidence-gated (needs T1.1 data)

## T2.1 — Severity thresholding

Unresolved design problem to answer first: **severity is self-reported by the finding's author.** Dimension-binding does not fix it — the reviewer picks the dimension too, so a correctness bug labeled `hygiene` is capped automatically. And severity is a property of finding × context, not of the finding: "unnecessary try/catch" is cosmetic in a script and a swallowed auth error in a permission path, which the reviewer's own security checklist says to flag.

Candidates, not yet chosen: derive severity from dimension plus the file's risk class (reuse `matchesSecuritySensitiveGlob`) rather than trusting the label; or have a second cheap pass classify severity independently of the finder.

Needs a kill switch on the `createBase2` option + `OPENBUFF_*` env pattern (`base2.ts:100-123`), surfaced in `/context`. Trap: for a default-ON flag resolve with `??` on an explicit boolean — `envFlag || DEFAULT` is the documented dead canary at `:87-94`.

**Thresholding may not touch the runaway loop at all** — that loop is driven by findings new each round; if those are medium-or-above, a threshold changes nothing. Rev 1 wrongly presented this as the top fix for both symptoms.

## T2.2 — Scope re-review to what changed

After a repair, pass the full pending set for *attestation* but direct deep review only at the repair receipt's `changedFiles`, citing the prior verdict for the rest. Attacks the "runs for a while" cost. Keep `collectReviewerAttestationIssues` unchanged so coverage gaps still fail closed. Promote if T1.1 shows reviewer wall-clock dominates.

## T2.3 — Requirement ledger through the editor handoff

Carry verbatim acceptance criteria in the editor handoff `Requirements` field, have the editor self-score each in its receipt, and pass that to the reviewer as *claimed* coverage. Reviewer contradicting a claim is a real finding; silence is not.

## T2.4 — Nit-ratchet on the no-progress guard

Requires T1.5's id ledger plus T1.1 data. Revisit only if T1.2 + T1.6 prove insufficient.

---

# Tier 3 — after re-measurement

- **T3.1** Normalize/dedupe finding text: `dedupeExactStringsPreserveOrder` is exact-match; reuse T1.5's key. (Rev 2 conditioned this on the evidence-gated T2.1, which was incoherent — architect finding 11. It depends on T1.5, which is Tier 1.)
- **T3.2** Docs: `docs/agents-and-tools.md:587` (`LOOKS_GOOD`-only paragraph, budget table) and the repair-loop table in `agents/guides/editor-writers-and-repair.md`.
- **T3.3 / T3.4** Advisory surface: render advisories distinctly in `cli/src/components/renderers/gate-state-box.tsx`; require them in the completion summary and offer a "fix the N nits" followup so the channel is not a silent dumping ground. **Partially pulled forward** — T1.2(a) cannot ship without the minimal version of these.
- **T3.5** Tests for whatever lands.

---

# Sequencing

1. **T0.1, T0.2** — live authority holes; independent of everything else
2. **T1.1** telemetry + shadow mode (durability resolved per above)
3. **T1.4** guidelines — fully independent, can run parallel with 1–2
4. **T1.6** cycle detection — small, self-contained, no persisted state
5. **T1.3** optional id/severity + code-reviewer id correlation, with the `[id] ` migration handled
6. **T1.5** id-keyed condoning — unblocks T1.2(c)
7. **T1.2** generator fix: (b) any time after 1; (a) after T1.3 + minimal advisory surface; (c) after T1.5
8. **Re-measure.** Real decision point: if `newFindingCount` collapses, Tier 2 may be unnecessary
9. Tier 2 individually gated on that data; Tier 3 last

## Falsification criteria

- **Escaped-defect rate** — a finding raised in a later turn on a file whose earlier-turn finding was suppressed or downgraded. Rising ⇒ suppression is too loose. Measurable only because T1.1 records suppression decisions.
- **Blocked-turn rate** — share of turns ending in `currentPhase = 'blocked'` (protocol failure, incomplete receipt, no-progress, cycle). Any change that raises this is a regression even if round counts fall.
- **Rejected condone claims** (T0.2) — a nonzero rate is direct evidence the repair-editor was over-claiming, and retroactively justifies T0.1/T0.2.

## Implementation traps

- The condone/merge logic (`base2.ts:4084-4148`, `:4521-4540`, `:5187-5229`) lives inside the serialized `handleSteps` generator and **cannot import** from `gate-reviewer.ts` — reconstructed functions lose their module closure. Any id-keying change must be duplicated by hand or moved into the `<gate-helpers-generated>` region; `scripts/generate-gate-helpers.ts` is the source of truth and `gate-*-parity.test.ts` enforces it.
- New `gate-state.ts` fields need a `??=` default at `base2.ts:889-917`, must stay plain JSON (three explicit "never a Set" / "never a Map" comments), and must handle sessions updating mid-loop.
- `createReviewer` is referenced from `agents/__tests__/code-reviewer.test.ts` and `agents/__tests__/base2-writer-spawn-rules.test.ts`; `docs/agents-and-tools.md` documents a bare-string text-mode contract that persisted sessions and third-party reviewers still emit. Any schema change needs dual-shape fixtures.

## Missing runtime evidence to collect before Tier 2

1. Per-round finding text/id sets from real turns — how often is a re-raise verbatim vs reworded?
2. How often the condoned-pass branch (`base2.ts:4121`) fires, and whether any such pass carried `coverage: "missing"` or an in-scope `uncertain` requirement. That single number decides whether T0.1 is an authority hole in practice or only in theory.

## Validation per slice

`agents` typecheck plus `agents/__tests__/gate-reviewer*.test.ts`, `agents/__tests__/base2*.test.ts`, `agents/__tests__/quality-prompt-snapshot.test.ts`. T1.4 additionally `agents/__tests__/base2-progressive-disclosure.test.ts`. T0.1, T0.2, T1.2, T1.3, T1.5, T1.6 additionally `agents/e2e/gate-lifecycle.e2e.test.ts`.
