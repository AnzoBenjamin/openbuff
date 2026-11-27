# Openbuff body — executable replacement plan

Recovery-qualified planner revision 2, 2026-11-06, after [Architect round 1](01-ARCHITECT.md) and [Critic round 1](01-CRITIC.md), both REVISE. The previously frozen revision was reconstructed before the source-assurance correction below. A subsequent dedicated Architect then independent Critic review must assess this recovery-qualified revision; independent approval is pending. All thirteen durable paired reports are incorporated. This document replaces future ordering in the historical polyglot roadmap; it does not transfer checkboxes or authorize implementation. Canonical publication will rename this draft to PLAN.md under `.agents/sessions/body-capability-review-2026-11-05/`; SPEC.md and OLD-TASK-MIGRATION.md are companions. One `.omx/plans/` launcher may reference that canonical plan.

## Requirements and evidence basis

Give the configured model a dependable CLI body: meaningful observations and effects, truthful outcome/lifecycle, resource ownership, safe continuation, useful retained knowledge, interoperable language capabilities, human controls and evidence of improvement. Preserve local/BYOK and explicit full-access choices. The model chooses reasoning and actions; common host guarantees work for custom strategies and base2. The [specification](../SPEC.md) fixes R1–R12, F1–F10, coverage matrices and fixture/measurement envelopes.

The review's durable pair reports provide current source claims; their diagnostic passes demonstrate defects, rather than repaired acceptance. HEAD `e65c06c0ae783130998bd9ab18c8d35320e40ea8` and native snapshot `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0` identify the assessed source with the inventory limitations recorded in SCOPE.md. All thirteen pairs yield 118 findings/144 capability records; root validates 555 unique inspected files and 147,555 reconstructed unique read-window lines in REVIEW-VALIDATION.json. COVERAGE-RESULT.json reports structural coverage true and minimum pair count satisfied, while nativeComplete remains false for heuristic feature readiness. Neither inspection nor keyword completeness proves a usable feature. Source/publication and independent review gates remain distinct from product readiness.

This source-assurance note is an explicit new correction to the recovered draft. [PLAN-RECOVERY-MANIFEST.json](../PLAN-RECOVERY-MANIFEST.json) records the matching original frozen document hashes and the current qualified hashes separately. The original map of 558 whole-file source hashes was not captured; the historical unchanged-hash checkpoint remains past evidence and cannot be rerun or credited as a fresh comparison. Current HEAD, exact-anchor checks and the new source binding are reported with their limits in [SOURCE-STABILITY.md](../SOURCE-STABILITY.md). Restoring the plan bytes does not restore that missing source baseline or certify repaired, installed or live product behavior.

The 36 cards are sized by concrete producer→consumer boundaries and overlapping ownership. B36 is the justified split of an immediate diagnostic false-success repair from B27's deeper language integration. B22 has three separately verified milestone nodes; the graph therefore has 39 completion nodes. Most cards repair current TS behavior; Rust earns specific OS ownership/enforcement/daemon primitives. Browser/media B33 and 3D B35 have separate owners/oracles; a separate conditional register retains absent frontier abilities. No percentage/time/speedup estimate substitutes for their evidence.

## RALPLAN-DR deliberate summary

**Principles**

1. Preserve working capabilities and the user's strategic/access choices. Model reasoning and action selection remain model owned; host contracts carry truthful observations and effects.
2. Confirm bytes, resource lifetime and source identity at their authority boundary. A local status, schema, prompt or library export cannot stand in for the observed result.
3. Recover from verified state; keep failures and uncertainty visible. A task can succeed after a failed action without rewriting the failure.
4. Pick implementation language for a concrete capability or measured correct-workload benefit. Share explicit contracts and consume mature ecosystem tools.
5. Attach positive/adverse, installed/native and outcome evidence to the affected task. Historical checked lines and structural inspection are not graduation.

**Decision drivers:** (1) prevent foreign overwrite, false success and unbounded cleanup/retry; (2) make the existing everyday CLI's task families work with useful memory and continuation; (3) obtain independent source/result/install evidence within four concurrent slots and bounded integration scope.

| Viable option | Approach | Fair benefits | Costs and risks |
|---|---|---|---|
| A: repair existing authorities, integrate native slices early | Ship independent TS truth/data repairs; integrate actual Rust exec when the execution context is ready; start the minimal rusqlite daemon immediately after that adapter and relevant lock/journal contracts | Current defects have short producer/consumer fixes; preserves tested machinery; native responsibility is explicit; useful results do not wait for a new daemon | Transitional TS lock/journal adapters need carefully fenced migration; some process guarantees remain cooperative until native graduation; two languages require contract/install checks |
| B: prioritize a small native authority in parallel | Keep immediate TS outcome/byte/CAS/evaluator fixes, but allocate a persistent lane to exec→minimal daemon before deeper ACP/memory/language integration, then consume its authoritative store/lease/job APIs | Reduces the duration of provisional ownership primitives; centralizes daemon state before clients multiply it; aligns D50/D51 and shared warm-service intent | Four-slot staffing reduces throughput on observed CLI/memory gaps; migration and platform/packaging work can dominate; native APIs can solidify before producer/consumer semantics are understood |

**Recommendation:** A's immediate truth repairs plus B's bounded ownership milestone: B21→M22-CORE is the direct exec→minimal-daemon edge. M22-TXN imports corrected transaction/recovery data only after B05/B07; M22-CHILD migrates production child ownership only after B16. B22 completes only after all three milestones. B remains preferable when interruption/concurrency makes fail-closed TS liveness costs dominant. Neither option waits for a complete Rust rewrite before repairing existing data/result defects. A permanent TS-only authoritative daemon would require a dated revision of D50/D51; it is not silently substituted. A native-first whole-loop rewrite lacks a measured capability case.

The most important tradeoff is how soon to migrate ownership state versus how many current CLI defects can be repaired concurrently. B04/B07/B15/B16 establish truthful transitional semantics in either option; B22 then has a bounded import/fencing proof rather than inheriting flawed meaning.

The strongest counterargument to A is that B04's safe fail-closed tier can strand a killed owner's mutation/indexing work, and every additional TS client lengthens the eventual cutover surface. A persistent native lane can restore ownership liveness sooner. The synthesis reserves that lane after B19/B20 and accepted B21. Those full execution/enforcement gates still cost work: “early” means direct adjacency after their proof, not a claimed wall-clock date or permission to accept a partial B21. The minimal daemon does not wait for all memory/language/evaluation work, but transaction/child migrations do wait for their specific producers.

## Shared contracts, ownership and task evidence

The leader owns public/shared schemas and cross-package SDK `run.ts` integration; workers propose additions and serialize edits to that file. Each assignment names files, declares that agents share the workspace and must preserve others' edits, and reports producer→consumer evidence. Work is grouped by file/authority, not by language count.

| Lane code | Responsibility / likely role |
|---|---|
| C | Leader: session/action/result/schema and shared integration; system-architect or native default acting as architect |
| R | Runtime/generator/journal/child owner; worker/executor |
| E | Read/edit/broker/recovery owner; worker/executor |
| P | Provider resolver/transport/accounting owner; worker/executor |
| U | CLI admission/artifacts/history/attach owner; worker/executor |
| M | Memory/archives/procedures owner; worker/executor |
| X | Execution/policy/native adapter/daemon owner; worker/executor with security-engineer review |
| L | Language/LSP/index/build-target owner; worker/executor |
| T | Extension/schema/module owner; worker/executor |
| Q | Evaluator/release/measurement owner; worker/test-engineer |
| V | Independent verifier/critic; no ownership of the change being approved |

Outcome contracts separate action result, run terminal reason, resource liveness and task acceptance. Data contracts separate exact raw bytes, normalized observation text, document version, full symbol identity, source/retrieval generation, artifact identity and host provenance. Required effect records have durable pre-dispatch identity and adapter-specific confirmation/reconciliation; arbitrary uncertain effects stop automatic replay. SPEC.md defines their finite fixtures and honest enforcement/retention envelopes.

**Commands:** execute only during later authorized implementation, from the repository root unless a card says otherwise. Use the reviewed Bun pin, avoiding the known OpenTUI mismatch on PATH Bun. Test additions belong to the named card, and proposed new runners are explicitly marked. No command listed here has been run as implementation acceptance by this planning work.

```sh
export BODY_BUN="${BODY_BUN:-bun}"
export BODY_EVIDENCE="${BODY_EVIDENCE:-/tmp/openbuff-body-execution}"
export BODY_TOOLCHAIN_MANIFEST="${BODY_TOOLCHAIN_MANIFEST:-test/fixtures/body/toolchain-manifest.json}"
if [ "$("$BODY_BUN" --version)" != "1.3.5" ]; then
  printf '%s\n' 'Resolve Bun 1.3.5 from the approved toolchain manifest before acceptance.'
  exit 1
fi
mkdir -p "$BODY_EVIDENCE"
```

BODY_BUN is the executable actually resolved on that host, not a hardcoded home-cache path. The audited cache path remains historical evidence. The planned toolchain manifest and acquisition/invocation section below define bootstrap for selected native/installed/real-tool cells; they are not prerequisites for immediate key-free TS tests beyond resolving the pinned Bun. BODY_EVIDENCE and the manifest are exported, and every proposed runner also receives explicit `--manifest`/`--evidence-dir` arguments.

Every card emits `$BODY_EVIDENCE/Bxx/` containing: source/config/toolchain manifest and changed-file hashes; test/fixture commands and exits; asserted behavior including an adverse and happy control; action/run/task/limit states as applicable; artifact references/hashes; platform/client/language coverage, unavailable cells and unresolved risks. Stdout tests.log alone is insufficient where an action/job/effect/artifact oracle is required. Capture actual start/end/exit/usage values; do not fill skipped paths with invented observations. Test runners may emit JSON fixtures via BODY_EVIDENCE; the leader assembles and independently verifies the receipt. Existing diagnostic probes stay separate from prospective acceptance tests.

**Completion rule:** a card is accepted only when its owned producer and actual consumer satisfy the stated oracle, required checks exit zero, artifacts are current/inspectable, and relevant installed/native paths run. A resource still alive after its selected enforced deadline fails the card. Failed/refused actions can contribute to an accepted recovery scenario only with unchanged failure receipts and a passing task oracle. Milestone acceptance is recorded under its exact M22-* node and coverage tier; it never marks the B22 rollup accepted. Stops block that node, rather than unrelated ready work.

## Immediate ready queue and dependency graph

Start three independent lanes with **B02 runtime outcome/stop**, **B03 mutation evidence**, and **B04 TS ownership/CAS**. The leader prepares shared contracts and source/evidence scope (B01). **B36 diagnostic outcome repair is independently ready with no prerequisites** and is the first rotation when a worker slot frees; B30 evaluator isolation follows or uses another freed slot, then B08/B18. B05/B06/B09 are dependent work. Native/parser/LSP/index/refactor breadth never gates B36's current false-success correction.

Dependencies are completion-node IDs: 36 B-cards plus M22-CORE/M22-TXN/M22-CHILD. Conditional demand gates are additional predicates. The validator and future ledger must recognize both node kinds, reject unknown IDs/cycles and verify queue eligibility. B21→M22-CORE is direct. B22 is a rollup over its three accepted nodes and cannot begin an ungated import or become complete on daemon boot. B32 current-baseline measurement can begin independently; meaningful promotion waits for its specific correctness/outcome oracle.

| Card | Prerequisites | Outcome milestone |
|---|---|---|
| B01 | none | Source/maturity/evidence truth |
| B02 | none | Run termination and task truth |
| B03 | none | Mutation truth |
| B04 | none | Exclusive TS ownership and CAS |
| B05 | B03 | Exact observation/edit bytes |
| B06 | B03, B04, B05, B07 | Complete preflight and guarded sequential semantic changes |
| B07 | B03, B04, B05 | Durable ownership-bound recovery |
| B08 | none | Request/error/retry fidelity |
| B09 | B02, B08 | Usage/spend/admission fidelity |
| B10 | B02 | Accepted/rejected CLI input transaction |
| B11 | none | Contained and discoverable local controls |
| B12 | B02 | Useful cross-turn memory |
| B13 | B12 | Original results and durable transcript |
| B14 | B12 | Applicable active procedures and feedback |
| B15 | B02, B03, B04 | Original identity and replay-supported journal prefix |
| B16 | B04, B15 | Child-aware journal and renewed leases |
| B17 | B02, B15 | Canonical ACP state and control |
| B18 | none | Exact complete approval identity |
| B19 | B02, B18 | Effective context across launchers |
| B20 | B02, B19 | Observed scope termination/resource cleanup |
| B21 | B19, B20 | Actual native exec and selected enforcement |
| B22 | M22-CORE, M22-TXN, M22-CHILD | Verified native baseline plus corrected production migrations |
| B23 | none | Honest language operations and identities |
| B24 | B23 | Packed parser/query/toolchain availability |
| B25 | B05, B19, B20, B23 | Fresh versioned LSP observations |
| B26 | B04, B23 | Coherent bounded retrieval generations |
| B27 | B06, B19, B23, B24, B25, B26, B36 | Per-root validation and joined target contracts |
| B28 | none | Faithful extension outcome/schema/origin |
| B29 | B15, B19, B28 | Trusted bundles and explicit extension tiers |
| B30 | none | Safe complete evaluation evidence |
| B31 | B02, B09, B12, B13, B14, B27, B30 | Held-out candidate application and rollback |
| B32 | none | Baselines and actual release/installed evidence |
| B33 | B03, B05, B19, B20, B28 | Browser/media action and observation truth |
| B34 | B06, B07, B16, B17, B22, B27 | Isolated concurrent work and verified landing |
| B35 | B03, B05, B19, B20 | Immutable 3D source/artifact truth |
| B36 | none | Immediate diagnostic outcome/coverage truth |

| Milestone node | Prerequisites | Independently accepted scope |
|---|---|---|
| M22-CORE | B04, B15, B21 | Native admission/backend-epoch baseline, new job/journal/lease store and fenced commit API on eligible fresh namespaces; no legacy transaction/child import |
| M22-TXN | M22-CORE, B05, B07 | Corrected-byte legacy transaction/recovery import and production recovery/commit consumption |
| M22-CHILD | M22-CORE, M22-TXN, B16 | Production detached/supervised child journal/job/lease migration, commits and reconnect ownership |

Ledger records have `nodeId`, `parentCardId` (B22 for milestones), accepted prerequisites, source/contract hashes, repository/backend epoch, coverage tier and evidence manifest. M22-CORE has its own receipt and can be checkpointed as that baseline. M22-TXN and M22-CHILD must not be omitted or treated as implicit follow-ups. B22 rollup acceptance requires all three receipts current for the same supported authority contract and the production cutover matrix; a fresh-empty namespace result cannot stand in for populated transaction/child migration. Full-access external/unaware writer coverage stays outside the admitted-fence guarantee.

<!-- body-completion-graph:v2 -->
```json
{
  "schemaVersion": 2,
  "cardCount": 36,
  "nodeCount": 39,
  "dependencySemantics": "all-of",
  "initialDispatchQueue": [
    "B02",
    "B03",
    "B04"
  ],
  "readyRotationQueue": [
    "B36",
    "B30"
  ],
  "rollups": {
    "B22": [
      "M22-CORE",
      "M22-TXN",
      "M22-CHILD"
    ]
  },
  "ledgerRequiredFields": [
    "nodeId",
    "parentCardId",
    "acceptedPrerequisites",
    "sourceContractHashes",
    "repositoryId",
    "backend",
    "epoch",
    "coverageTier",
    "evidenceManifest"
  ],
  "nodes": [
    {
      "id": "B01",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B02",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B03",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B04",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B05",
      "kind": "card",
      "prerequisites": [
        "B03"
      ]
    },
    {
      "id": "B06",
      "kind": "card",
      "prerequisites": [
        "B03",
        "B04",
        "B05",
        "B07"
      ]
    },
    {
      "id": "B07",
      "kind": "card",
      "prerequisites": [
        "B03",
        "B04",
        "B05"
      ]
    },
    {
      "id": "B08",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B09",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B08"
      ]
    },
    {
      "id": "B10",
      "kind": "card",
      "prerequisites": [
        "B02"
      ]
    },
    {
      "id": "B11",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B12",
      "kind": "card",
      "prerequisites": [
        "B02"
      ]
    },
    {
      "id": "B13",
      "kind": "card",
      "prerequisites": [
        "B12"
      ]
    },
    {
      "id": "B14",
      "kind": "card",
      "prerequisites": [
        "B12"
      ]
    },
    {
      "id": "B15",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B03",
        "B04"
      ]
    },
    {
      "id": "B16",
      "kind": "card",
      "prerequisites": [
        "B04",
        "B15"
      ]
    },
    {
      "id": "B17",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B15"
      ]
    },
    {
      "id": "B18",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B19",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B18"
      ]
    },
    {
      "id": "B20",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B19"
      ]
    },
    {
      "id": "B21",
      "kind": "card",
      "prerequisites": [
        "B19",
        "B20"
      ]
    },
    {
      "id": "B22",
      "kind": "card",
      "prerequisites": [
        "M22-CORE",
        "M22-TXN",
        "M22-CHILD"
      ]
    },
    {
      "id": "B23",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B24",
      "kind": "card",
      "prerequisites": [
        "B23"
      ]
    },
    {
      "id": "B25",
      "kind": "card",
      "prerequisites": [
        "B05",
        "B19",
        "B20",
        "B23"
      ]
    },
    {
      "id": "B26",
      "kind": "card",
      "prerequisites": [
        "B04",
        "B23"
      ]
    },
    {
      "id": "B27",
      "kind": "card",
      "prerequisites": [
        "B06",
        "B19",
        "B23",
        "B24",
        "B25",
        "B26",
        "B36"
      ]
    },
    {
      "id": "B28",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B29",
      "kind": "card",
      "prerequisites": [
        "B15",
        "B19",
        "B28"
      ]
    },
    {
      "id": "B30",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B31",
      "kind": "card",
      "prerequisites": [
        "B02",
        "B09",
        "B12",
        "B13",
        "B14",
        "B27",
        "B30"
      ]
    },
    {
      "id": "B32",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "B33",
      "kind": "card",
      "prerequisites": [
        "B03",
        "B05",
        "B19",
        "B20",
        "B28"
      ]
    },
    {
      "id": "B34",
      "kind": "card",
      "prerequisites": [
        "B06",
        "B07",
        "B16",
        "B17",
        "B22",
        "B27"
      ]
    },
    {
      "id": "B35",
      "kind": "card",
      "prerequisites": [
        "B03",
        "B05",
        "B19",
        "B20"
      ]
    },
    {
      "id": "B36",
      "kind": "card",
      "prerequisites": []
    },
    {
      "id": "M22-CORE",
      "kind": "milestone",
      "prerequisites": [
        "B04",
        "B15",
        "B21"
      ],
      "parentCardId": "B22"
    },
    {
      "id": "M22-TXN",
      "kind": "milestone",
      "prerequisites": [
        "M22-CORE",
        "B05",
        "B07"
      ],
      "parentCardId": "B22"
    },
    {
      "id": "M22-CHILD",
      "kind": "milestone",
      "prerequisites": [
        "M22-CORE",
        "M22-TXN",
        "B16"
      ],
      "parentCardId": "B22"
    }
  ]
}
```

The JSON dependency/ledger form is canonical for machine validation; the human card/milestone tables must match it exactly or validation fails. It records future completion semantics, not active goals or accepted work.

## Task cards

### [ ] B01 — Make coverage, capability maturity and source evidence independent

**Trace:** R1/R8/R12; `native-audit-inventory`, `audit-coverage-readiness`, `durable-audit-sink`, `review-evidence-gate`, `task-workspace-evidence`; 12-F1, 12-F2, 12-F3, 12-F4, 12-F6, 12-F7, 12-F8 plus root completeness/snapshot probes. Nested feature snapshots are dropped at `sdk/src/tools/audit-intelligence.ts:137`; cached inventory suppresses source reattestation at `:116`; readiness is conflated at `sdk/src/services/audit-intelligence.ts:431`. Foreign reviewer fingerprints are tolerated (`agents/base2/gate-reviewer.ts:292`), dimensions may be empty (`agents/reviewer/code-reviewer.ts:117`), untracked tail identity is incomplete (`sdk/src/tools/get-change-review-bundle.ts:393`) and corruption diagnostics are dropped (`:882`).

**Owner/scope/deps/language:** C, TS; common audit/reviewer schemas, SDK audit wrappers/service, exact source/review-bundle identity and persistent store diagnostics; none. Keep existing exclusive artifact sink and ordinary/reduced reviewer eligibility distinction. Full incremental hashes and supplemental shipped-source membership are needed for source attestation; heuristics stay discovery hints.

**Accept:** A matching complete inspection can report partial/unwired/absent/unknown capabilities while readiness remains incomplete. An unimplemented command+empty test+docs cannot become usable. Foreign nested snapshot, source-tail drift and omitted shipped release source yield specific incomplete/identity states; findings-only churn remains harmless. Same-path obsolete review cannot receive credit under the expected current basis; ordinary empty dimensions/requirements fail and eligible reduced review remains explicit. Equal-length untracked tail changes alter full identity and invalidate mid-validation evidence; quarantined open findings retain unavailable/corrupt state on subsequent reads. Every body responsibility/task family and directory disposition is represented.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/audit-intelligence.test.ts common/src/tools/params/__tests__/write-audit-findings.test.ts sdk/src/__tests__/write-audit-findings.test.ts sdk/src/__tests__/get-change-review-bundle.test.ts sdk/src/__tests__/local-harness-store.test.ts agents/__tests__/gate-reviewer.test.ts`; add the root/reviewer/tail/corruption counterexamples as behavior tests. Emit separate inspection/maturity/assurance/source-binding/reviewer-dimension results. Stop promotion supported only by keywords, path lists, incomplete identity or an unassessed/mismatched review. This fixes product evidence tooling; it does not repeat this completed review as the first execution task.

### [ ] B02 — Propagate authoritative action/run/task outcomes and terminal stops

**Trace:** R1/R2; programmatic lifecycle, typed receipts, cancellation, cost/step budgets; 03-F1, 03-F2 and 05-F8. Cost correction revives a stop at `packages/agent-runtime/src/run-agent-step.ts:3348`; caught generator errors become normal end at `packages/agent-runtime/src/run-programmatic-step.ts:749,794`; normal finalization writes completed at `run-agent-step.ts:3664,3678`; child receipts default complete at `spawn-agent-utils.ts:2772`. Workflow helper injection disagrees at `run-programmatic-step.ts:476`/`agents/base2/base2.ts:8536`.

**Owner/scope/deps/language:** R with C owning shared outcome schemas; runtime loop/generator/spawn settlement and SDK/headless/CLI projections; none; TS now. Align the typed advisory helper without moving task intelligence into a host workflow.

**Accept:** Zero-cost and exhausted-step fixtures return naturally once with zero new provider calls and bounded correction; a fatal generator/unhandled rejected awaited tool/abort yields failed/cancelled journal, child receipt, SDK and CLI/headless result. Happy generator still completes. A failed tool followed by verified recovery can produce completed run/accepted task while its failure remains. A completed-but-task-rejected control remains distinct. Illegal workflow transition emits its structured durable error through the real shipped generator.

**Verify/evidence/stop:** `"$BODY_BUN" test packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts packages/agent-runtime/src/__tests__/loop-agent-steps-abort.test.ts packages/agent-runtime/src/__tests__/run-programmatic-step.test.ts packages/agent-runtime/src/tools/handlers/tool/__tests__/spawn-agent-utils-output.test.ts`; add a DI SDK→headless/child outcome fixture. Receipt includes three outcome levels and one natural stop, rather than a probe-triggered abort. Stop on any fatal/cancel/hard-stop→completed path or recovered-task false rejection.

### [ ] B03 — Confirm mutation evidence only from observed forward effects

**Trace:** R1/R3; cooperative-mutation-broker/edit-transaction; 06-F3. Attempt recording precedes adapter call (`sdk/src/tools/change-file.ts:687`), but rollback_failed maps to confirmed applied (`common/src/tools/results/filesystem.ts:1105,1130`); SDK journal/LSP observers consume that selection (`sdk/src/run.ts:3184`).

**Owner/scope/deps/language:** E; filesystem result schema/coordinator/authority selectors with C serializing SDK observer integration; none; TS. Retain attempted/partial/uncertain observations and actual successful forward evidence separately.

**Accept:** Rejected forward plus rejected rollback yields zero confirmed actions and preserved foreign bytes. Genuine partial forward work remains identified even if rollback fails. Successful conditional edit still yields exact receipt/hash and correct mutation observers. SDK/CLI/headless never show unapplied work as confirmed; an overall task can later recover without deleting these receipts.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/change-file.test.ts sdk/src/__tests__/run-mutation-dispatch.test.ts sdk/src/__tests__/mutation-capabilities.test.ts`; attach before/after bytes, adapter returns and client/journal projections. Stop if a rollback status alone grants applied authority, or if an uncertain action is silently dropped.

### [ ] B04 — Repair TS lock ownership and snapshot/index CAS immediately

**Trace:** R3/R4; cooperative-mutation-broker, 08-C5, 05-C9; 06-F1/08-F8/05-F9. Stale breaker unconditionally removes current broker lock (`sdk/src/services/workspace-mutation-broker.ts:601`); index reclaim verifies then renames (`packages/indexer/src/index-store.ts:1164,1193`); snapshots use unconditional publication (`cli/src/utils/turn-snapshots.ts:461,488`).

**Owner/scope/deps/language:** E/C; known-live broker/index exclusivity and serialized per-repository snapshot capture/CAS; none; existing TS safeguards first. The immediate selected tier is fail-closed: disable automatic ambiguous stale takeover and preserve live/unknown owner records. It may report recovery-needed rather than reclaiming a dead lock. A stronger TS takeover is acceptable only if a concrete ownership protocol survives the actual adversarial barriers; read/recheck→unlink/rename alone is insufficient. Rust OS locking/fencing and authoritative crash reclamation belong to B22, not this prerequisite.

**Accept:** Controlled competing stale breakers cannot remove a replacement: under the immediate tier ambiguous/stale ownership produces explicit refusal with zero writes; ordinary known-live ownership permits exactly one writer from the same preimage. Across cooperative real child processes there is at most one active writer. Two concurrent snapshot producers retain both correctly attributed recovery points in one chain or return explicit retry/refusal; a queued mutation cannot be assigned to the wrong turn. Crashed/unknown lock ownership remains inspectable recovery-needed until a proven primitive or explicit evidence-backed resolution exists. No automatic-recovery liveness guarantee is required to accept this transitional safety fix.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/workspace-mutation-broker.test.ts packages/indexer/src/index-store.test.ts cli/src/utils/__tests__/turn-snapshots.test.ts`; add barriers at the actual reclaim/publication seams and real-process controls. Record owner generations/tips/CAS outcomes and the declared fail-closed tier. Stop if a timer, post-rename repair or read/recheck→unlink/rename remains the exclusion proof, or if ambiguous ownership is reported recovered. No native dependency delays this safety fix; B22 is required to claim authoritative crash reclamation.

### [ ] B05 — Preserve raw bytes and bound reads at the allocation boundary

**Trace:** R3/R5; read-authority, byte-preservation; 06-F7, 06-F8, 06-F11. BOM is stripped (`sdk/src/tools/read-files.ts:297`; `sdk/src/tools/change-file.ts:958`), range/symbol output uses normalized whole text (`packages/agent-runtime/src/process-edit-transaction.ts:1241,1319`), long lines accumulate before the output budget (`sdk/src/tools/node-filesystem.ts:147,162`).

**Owner/scope/deps/language:** E; shared D30 byte/text/basis codec, read adapters and localized render/splice paths; B03; TS first. Raw hash, normalized text hash, BOM/EOL metadata and UTF-16/UTF-8 coordinate conversions remain separate.

**Accept:** Read/edit/delete/move/rollback cases cover UTF-8 BOM, LF/CRLF/mixed EOL, astral text, final empty line/no final newline and file modes; unrelated bytes are identical. Whole/scoped authority uses its real basis. A 24 MiB unbroken line under a 1 KiB result budget buffers only budget+declared fixed chunk overhead, reports incomplete metadata and mints no full-read grant. Abort closes the stream.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/read-files.test.ts sdk/src/__tests__/change-file.test.ts packages/agent-runtime/src/__tests__/process-str-replace.test.ts packages/agent-runtime/src/__tests__/rewrite-symbol.test.ts`; add read allocation instrumentation and byte fixtures. Receipt gives exact hex/hash diffs and peak buffered bytes; RSS is separately measured, not inferred. Stop on unrelated-byte changes or a returned-byte cap masking unbounded allocation.

### [ ] B06 — Apply complete, versioned semantic/refactor transactions

**Trace:** R3/R9; semantic-workspace-edit/structural-rewrite; 06-F2, 06-F6, 06-F9. Version/basis is dropped (`sdk/src/services/lsp-multiplexer.ts:1057,1318`; `sdk/src/tools/semantic-edit-apply.ts:136`); failed consumer splices are omitted (`language-intelligence.ts:418`); malformed positions reach offsets (`:262`; `lsp-multiplexer.ts:1095`).

**Owner/scope/deps/language:** E with L producing complete WorkspaceEdit intents; semantic normalize/splice/apply, complete preflight and guarded sequential coordinator/recovery; B03/B04/B05/B07. TS plus consumed ecosystem refactor tools. Complete zero-write refusal is the preflight guarantee; successful multi-file execution is sequential and externally visible between commits. Future fix-it/codemod adapters use the same contract.

**Accept:** Unsupported/malformed/stale members anywhere in the complete intent refuse before the first write. A supported definition+consumer+resource change performs guarded sequential commits and is whole-intent successful only after every requested operation and the consumer oracle passes. Failure/crash during application retains each confirmed/partial/uncertain effect and B07 recovery-required/conflict state; it cannot claim all files stayed untouched or the whole intent applied. External append/BOM/EOL-only drift and version mismatch reject at the relevant conditional basis. Negative/fractional/reversed/out-of-line positions refuse; valid UTF-16/negotiated UTF-8 positions preserve bytes. No instantaneous filesystem-wide visibility to external writers is promised.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/language-intelligence.test.ts sdk/src/__tests__/lsp-multiplexer.test.ts packages/agent-runtime/src/__tests__/edit-transaction-multi-file-recovery.e2e.test.ts`; create/run the proposed `workspace-edit-sequential.ts` runner below. Cases distinguish zero-write preflight refusal, full sequential success and failed/crashed intermediate application with foreign divergence. Receipt lists requested/observed/confirmed/uncertain operations, hashes and recovery outcome. Stop a subset being mislabeled whole-intent success, recovery before its B07 producer or a basis captured after planning.

The initial supported-operation manifest is finite. Additional operations require an explicit adapter and the same complete preflight:

| WorkspaceEdit form | Supported initial behavior or complete-intent refusal |
|---|---|
| TextDocumentEdit with integer version | Require the captured raw basis and matching document version; validate every TextEdit before effects |
| Unversioned `changes` map or null version | Require the request's captured per-document raw basis; no later read can silently become the plan basis. Conflicting simultaneous `changes`/`documentChanges` forms refuse |
| CreateFile | Support contained file creation with overwrite/ignoreIfExists false; stage new-file text edits against the generated empty basis. Unsupported overwrite/ignore semantics refuse the complete intent |
| RenameFile/DeleteFile | Support contained file rename/delete with explicit source/destination identity; initial overwrite/ignore/recursive true and directory operations refuse unless an implemented adapter declares them |
| Options/annotations | Preserve supported labels/metadata; unknown options, missing annotation IDs or needsConfirmation without a real host acknowledgement refuse before writes |
| Conflicting/ordered resource operations | Simulate the complete staged file-state graph; cycles, duplicate destinations, overlapping edits, references to deleted files and unsupported repeated document-version sequences refuse |
| Position encodings | UTF-16 and explicitly negotiated/converted UTF-8 are supported; unsafe/noninteger/out-of-range/reversed coordinates or other undeclared encodings refuse |

### [ ] B07 — Admit durable intents and recover only transaction-owned contained state

**Trace:** R3/R4; transaction-recovery; 06-F4, 06-F5, 06-F10, 06-F12. Recovery lacks expected after-state and uses unconditional restoration (`sdk/src/tools/transaction-intent-log.ts:161,1249,1367`); failed rollback records terminal abort (`:1263`); begin failure proceeds (`sdk/src/tools/change-file.ts:658`); receipt recovery follows replaced parent (`workspace-mutation-broker.ts:918`).

**Owner/scope/deps/language:** E; intent log, coordinator admission/startup and broker recovery; B03/B04/B05; TS now, M22-TXN consumes the accepted corrected contract. Align actual-byte log limits with accepted transactions or refuse before effects; do not silently downgrade durable mode. Legacy records lacking ownership/after-state remain explicitly uncertain; migration must preserve that uncertainty rather than inventing proof.

**Accept:** Fault at each group commit boundary, replace a parent symlink, inject read/write/fsync/capacity failure and add foreign divergence. Only proven transaction-owned bytes restore; foreign/outside bytes remain untouched. Unresolved paths persist as recovery-required, failure is visible, and a later retry completes. Accepted >8 MiB fixture either stores recoverable intent under declared capacity or commits zero files; no unjournalled accepted group.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/tools/__tests__/transaction-intent-log.test.ts sdk/src/__tests__/workspace-mutation-broker.test.ts packages/agent-runtime/src/__tests__/edit-transaction-multi-file-recovery.e2e.test.ts`; add a killed temporary helper, rather than only synthetic crash state. Emit intent/receipt transitions and contained path/before/after identity. Stop if uncertainty becomes tx_abort or recovery ownership is inferred from any difference from the preimage.

### [ ] B08 — Unify provider errors, retry ownership, route metadata and settings

**Trace:** R1/R2/R12; providers.retry-failover/context-limit-adaptation/oauth-subscription/capability-resolution; 02-F1, 02-F2, 02-F4, 02-F5, 02-F6, 02-F7. SDK wrappers hide status (`sdk/src/error-utils.ts:189`), SSE turns status into prose (`packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:122`), context scans backup credentials (`sdk/src/impl/model-provider.ts:439`), reasoning namespace differs (`:243`; adapter `:207`), configured OAuth ignores skip (`:302`) and stream retry bypasses shared policy (`sdk/src/impl/llm.ts:1977`).

**Owner/scope/deps/language:** P; error contract/resolver/streaming and nonstreaming retry policy/internal compatible adapter; none; TS. Disable hidden SDK retries where Openbuff owns attempts; metadata resolution does not construct credentials for unselected routes.

**Accept:** The precommitted fault fixture selects three primary attempts including the first, one backup attempt, four total, exponential delay capped at 200 ms, Retry-After capped at 250 ms and total retry-wait allowance 600 ms. Fake HTTP/SSE 503 follows that exact attempt ledger then backup. Policy 503 and abort do not retry; cancellation during backoff admits no further request and settles within the fixture's 250-ms wait allowance plus observation grace. Delivered content/tools are never replayed. Healthy primary works without dormant backup keys; arbitrary provider IDs transmit selected reasoning settings; OAuth skip never reselects excluded OAuth. These are fixture/policy values, not universal billing or latency guarantees.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/retry-config.test.ts sdk/src/__tests__/model-provider.test.ts sdk/src/impl/__tests__/llm-chatgpt-oauth-policy.test.ts sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts`; convert real configured-adapter HTTP/SSE probes to desired controls. Stop on hidden attempts, prose-only metadata or a backup config failure blocking healthy primary.

### [ ] B09 — Preserve usage/cost provenance and bound request admission

**Trace:** R2/R11; providers.usage-and-cost/output-ceilings-and-truncation; 02-F3/03-F1. Production includeUsage is unset (`sdk/src/impl/model-provider.ts:696`), tool finish ends before late usage (`openai-compatible-chat-language-model.ts:939`), response accounting is inside request-metadata stripping (`sdk/src/impl/llm.ts:1844,1876`), runtime consumes totals (`run-agent-step.ts:734,797`).

**Owner/scope/deps/language:** P/C; response accounting, compatibility negotiation, run/child admission and usage receipts; B02/B08; TS with D41 calibration. Retain exact local counts where feasible; unknown remote cost and possible in-flight overshoot remain explicit.

**Accept:** Both 20k/10k fake streams at $3/$15 per million report 21 cents once with stripping on/off and late usage. Missing usage remains incomplete. A selected finite cap defaults to SPEC's strict-capped admission: refuse a new request when pricing or a justified reservation bound is unavailable; hold incomplete-attempt reservations until verified reconciliation. Explicit estimated-capped mode has a predeclared conservative estimate/reservation and is labeled degraded, while uncapped mode remains usable. Failed/late/missing usage, two concurrent children and restart cannot reset outstanding spend or obtain unlimited retry admission. Observed overshoot stops new capped admissions. Output ceiling/truncation states retain their actual enforcement scope.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/impl/__tests__/llm-cost.test.ts packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts packages/agent-runtime/src/__tests__/budget-enforcement.test.ts`; add resolver→runtime aggregates and durable shared-admission interleavings. Record strict/estimated/uncapped policy, initial/held/reconciled reservations, currency/precision/unknowns and possible in-flight overshoot. Stop missing-as-zero accounting, unknown price resetting spend, uncapped retries under a cap or exact remote billing claims.

### [ ] B10 — Make CLI prompt/context admission one owned transaction

**Trace:** R1/R3/R7; interactive-chat-routing, attachments-live-source, cancel-queue-run-ownership; 01-F2, 01-F4, 01-F5, 01-F6. Registered commands precede preflight (`cli/src/commands/router.ts:488,526`); nonready files are drained (`hooks/helpers/send-message.ts:263,290`); client initialization is outside cleanup (`hooks/use-send-message.ts:598,890`); empty validation failure resolves (`hooks/use-agent-validation.ts:187`; use-send-message `:561`).

**Owner/scope/deps/language:** U; router/shared send helper, attachment reservation, queue and initialization ownership; B02; TS/OpenTUI. Return accepted/rejected/not-started separately from run completion; keep draft/context available for explicit recovery.

**Accept:** Ordinary, slash, mode argument, plan picker, execution action and queue use the same bisection/attachment preflight. Processing/failed input is retained; ready/approved metadata context is delivered exactly once. Factory/validator failure displays a reason, releases only its own occupancy and allows retry; an old failure cannot release a newer owner. Bisection stop/list remain local and reachable. Mounted ask-user request identity/abort/unmount cleanup works without losing draft input.

**Verify/evidence/stop:** from `cli/`: `"$BODY_BUN" test --preload ./scripts/preload-opentui.ts --isolate src/commands/__tests__/prompt-dispatch.test.ts src/components/__tests__/attachment-recovery.test.tsx src/hooks/__tests__/use-send-message-ownership.test.ts src/hooks/__tests__/use-ask-user-bridge.test.ts`; add real-hook/mounted queue cases rather than duplicate helper bodies. Record admission/attachment identity and retained draft. Stop any unstarted submission being removed as accepted or bisection-concurrent mutation admission.

### [ ] B11 — Contain artifact reads and unify command discovery

**Trace:** R3/R7/R12; durable-plan-ui, command-palette-skills-presets; 01-F1, 01-F8. Plan reads follow lexical paths (`cli/src/commands/plan-artifacts.ts:96,397,476`); executable plans/plan-use exist (`command-registry.ts:1359,1410`) but menu omits them (`data/slash-commands.ts:124`).

**Owner/scope/deps/language:** U; physical artifact read/open checks, list failure isolation and command metadata; none; TS. Apply policy to actual opened targets while preserving intentionally selected external general attachments, which have a separate policy.

**Accept:** Session/artifact symlinks to harmless outside/sensitive targets are rejected by prefix/page/resume; normal contained UTF-8 paging works. A replaced path between validation/open cannot disclose outside bytes. One unreadable plan row yields a partial catalog, not total failure. Intended discoverable commands/aliases appear in palette/suggestions and retain local dispatch; insertion-only/hidden entries have explicit exemptions.

**Verify/evidence/stop:** from `cli/`: `"$BODY_BUN" test --preload ./scripts/preload-opentui.ts --isolate src/commands/__tests__/prompt-dispatch.test.ts src/components/__tests__/session-route-recovery.test.tsx`; add open-boundary symlink/race and discoverability matrix fixtures. Receipt includes actual target/bounded read status and catalog roster. Stop a lexical-only containment proof or menu parity inferred from names without dispatch.

### [ ] B12 — Repair canonical memory lifecycle, facts and next-turn selection

**Trace:** R5/R11; memory-v2-roundtrip/memory-retention-and-relevance; 04-F1, 04-F2, 04-F3, 04-F5, 04-F9. Terminal/start identities collide (`sdk/src/services/memory-v2/coordinator.ts:1130,2145`; event-factory `:27`); new task is an exact recall filter (`coordinator.ts:1173`; repository `:5235`); decision body is summarized away (`coordinator.ts:1623`); compiler sorts ranked arrays (`packages/agent-runtime/src/util/memory-v2-context.ts:277`); degraded injection disagrees (`run-agent-step.ts:2534`).

**Owner/scope/deps/language:** M; coordinator/event factory/repository query/compiler/request-authority integration; B02; TS/SQLite first. Separate lifecycle phase identity, task provenance versus selection scope, and ranked complete records versus canonical nested metadata.

**Accept:** Prepare/capture/finish/reopen/restore/next-turn works for completed/failed/cancelled states; repeated event append is idempotent and parked checkpoints reconcile. Task B receives an applicable task-A fact/decision/rationale without A's internal ID; unrelated records stay excluded. Highest-ranked complete fact survives the 12k prompt bound. V1/V2 unavailable/throwing/empty cases emit source/authority metadata matching actual messages.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/services/memory-v2/__tests__/coordinator.test.ts packages/agent-runtime/src/util/__tests__/memory-v2-context.test.ts`; from `cli/` run the cold-start fixture with the supported preload if needed. Add actual handler→capture→SQLite→next-prompt tests. Receipt includes stable event IDs, emitted facts and authority; stop missing facts hidden behind degradation:none or a direct repository query standing in for the next decision.

### [ ] B13 — Retain original results and page durable CLI history within policy

**Trace:** R5/R12; archive-recall/context-compaction/history-restore-retention; 04-F4/01-F7/11-F7. New pointer copy shadows original (`packages/agent-runtime/src/util/context-archive.ts:525`); CLI truncates before save (`cli/src/hooks/helpers/send-message.ts:350`; `utils/run-state-storage.ts:847,897`); fidelity counts identifiers rather than values (`evals/compaction-fidelity/scenario.test.ts:153`).

**Owner/scope/deps/language:** M/U; original/fullness-aware archive selection, immutable result refs/range reads, persisted transcript paging and explicit restore failure; B12; TS/FTS5 (D54). Keep hot rendering bounded without silent durable deletion.

**Accept:** SPEC's 200-message/30-result fixture survives three real compactions and a fresh process with critical values/negations/blockers, original body hashes and first retained-by-policy transcript page. Exceed quota/expiry: disclose cutoff and retain no misleading dangling body references. Identifier-correct but value-wrong content fails the factual oracle. Missing/corrupt selected session has visible retry/cancel state; SDK model continuity is tested separately from CLI transcript.

**Verify/evidence/stop:** `"$BODY_BUN" test packages/agent-runtime/src/util/__tests__/context-archive.test.ts evals/compaction-retention/scenario.test.ts evals/compaction-fidelity/scenario.test.ts`; CLI context-archive-sync/session-route cases plus a planned `test/fixtures/body/memory-restart.ts` runner. Emit prompt/storage/SQLite-overhead bounds, recall values and retained cutoff. Stop on pointer-as-original, indefinite full retention under a fixed quota or a substring/ID score mislabeled factual recall.

### [ ] B14 — Keep verified procedures active, scoped and honestly attributed

**Trace:** R5/R11; procedural-learning-feedback; 04-F6, 04-F7, 04-F8. verified is excluded from runtime loading (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1601`; lifecycle `:142`); unrelated full read penalizes all memories (`sdk/src/services/memory-v2/usage-observer.ts:119`); playbook gate lacks applicability (`packages/agent-runtime/src/memory/playbook-gate.ts:288`).

**Owner/scope/deps/language:** M; shared applicability/activation/compiler/gate and actual emitted observation usage; B12; TS. Separate quality verification from enabled state; avoid manufactured negative learning.

**Accept:** Verify→reopen retains enabled instructions/gate behavior; retired/expired disables. Vary repository, globs and agent type independently; another-language/project rule never applies outside scope. Reading B does not penalize A; an actual same-source reread creates only the declared efficiency signal, with necessary refresh/unknown use distinguished. Newly inject-only procedures do not receive invented firing counters.

**Verify/evidence/stop:** `"$BODY_BUN" test packages/agent-runtime/src/memory/playbook-context.test.ts sdk/src/services/memory-v2/__tests__/usage-observer.test.ts sdk/src/__tests__/agent-runtime-impl-playbook-outcome.test.ts`; add operator lifecycle→real gate→repository reopen fixture. Receipt lists applicable/emitted/fired evidence. Stop if verification removes useful procedure, scope is unsupported but ignored, or seeded counters are described as measured improvement.

### [ ] B15 — Preserve journal identity and put effect replay at common dispatch

**Trace:** R1/R4/R10; 05-C1–C5; 05-F1, 05-F2. Interrupted run overwrites its ID (`packages/agent-runtime/src/run-agent-step.ts:1963`); model dispatch bypasses programmatic journal (`tools/stream-parser.ts:706`; `run-programmatic-step.ts:1042`); SDK handleToolCall lacks journal consumer (05-F2).

**Owner/scope/deps/language:** R/C; session/run/action identity and shared model/programmatic/custom/MCP dispatch journal; B02/B03/B04; TS, explicit D35/D55 replay. Accept the cooperative identity/shared-dispatch and recorded-prefix tier here. Transaction restoration consumes accepted B07 or remains recovery-required; native epoch/fencing graduation belongs to B22 milestones. Input/bundle/artifact hashes and attempt identity persist before dispatch; no heap snapshots.

**Accept:** A replay-supported bundle reconstructs the maximal contiguous verified durable prefix from immutable configuration and recorded STEP/STEP_ALL/GENERATE_N/model/tool/host callback inputs and outputs; canonical yields/occurrence/order must match before live continuation. Original IDs and confirmed counter stay unchanged after a killed helper. Changed bundle/runtime/contract, missing record, mutable module/external state or unrecorded clock/random/I/O makes automatic continuation unavailable unless a proven reconstruction adapter covers it. Arbitrary trusted/full-access execution still works; its automatic replay assurance can be unavailable. All four effect crash points retain uncertain shell/custom/MCP outcomes; broker recovery requires B07. Recovered task acceptance retains failures; new turn/fork remains distinct.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/run-journal-wiring.test.ts packages/agent-runtime/src/util/__tests__/run-journal.test.ts packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts`; create/run proposed effect-crash.ts and replay-prefix.ts below. A positive recorded-clock/random/input replay is paired with changed-bundle, unrecorded mutable-module/nondeterministic state and prefix-divergence refusals. Receipt records the exact supported prefix, replay eligibility/basis and uncertainty. Stop no-result→execute-live, automatic replay without eligibility/evidence, unavailable B07 restoration or a bundle treated as a live heap snapshot.

### [ ] B16 — Keep child journal ownership and leases alive through settlement

**Trace:** R2/R4/R6; 05-C4/C14/C15 plus supervised delegation; 05-F3, 05-F7 and verified D56 subset. Parent closes inherited journal (`cli/src/hooks/use-send-message.ts:923`; `packages/agent-runtime/src/util/run-journal.ts:1418`); path TTL sweeps without heartbeat (`workspace-path-leases.ts:45`; spawn `:470`). Pair 03 proves current process/parent-proxy settlement; old D56 PRE-spawn/abort claims are verification cases, not assumed new defects.

**Owner/scope/deps/language:** R; journal connection/session ownership, cooperative lease renewal/generation handoff and child receipts/bridge; B04/B15; TS supervision now, M22-CHILD native ownership migration later. Journal handle closes only after its owner's live children settle or transfer to another owned connection. Any transaction-recovery continuation invokes B07 or refuses that recovery tier.

**Accept:** Hold a detached child beyond actual parent cleanup, then finish/reopen: full child result/terminal tail remains. Child lives across multiple shortened TTLs: cooperative overlap is refused until verified release. Parent abort and replay-supported restart preserve final state/signal propagation across compiled POSIX self-exec; unsupported Node/Windows fallback is honest. This card proves participating cooperative generation/renewal and supported replay, not cross-backend native fencing; production child cutover/old-epoch refusal must pass M22-CHILD.

**Verify/evidence/stop:** `"$BODY_BUN" test packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts packages/agent-runtime/src/util/__tests__/background-resume.test.ts packages/agent-runtime/src/util/__tests__/workspace-path-leases.test.ts packages/agent-runtime/src/supervision/__tests__/supervised-bridge-e2e.test.ts`; add parent-cleanup/fresh-store and live-TTL controls. Receipt preserves journal owner generation/lease renewals and returned child state. Stop orphaned ownership, silent no-op append or replay-fence absence; verify old allegations before repairing them.

### [ ] B17 — Persist canonical ACP sessions and retain live-turn controls on reconnect

**Trace:** R1/R4/R7/R12; 05-C10–C13, attach-detach-ui; 05-F4, 05-F5, 05-F6, 05-F10/01-F3. Bridge ignores prior RunState (`sdk/src/serve/bridge.ts:754`); connection-local controller loses cancellation (`services/acp/acp-agent.ts:886`); anonymous socket lock strands restart (`serve/socket-listener.ts:129`); replay reads text instead of fullResponse (`cli/src/commands/replay-command.ts:87`); attach uses local provider preflight (`hooks/use-send-message.ts:679`).

**Owner/scope/deps/language:** U/C; service-wide session owner, durable executable state, atomic acknowledged ACP projections, socket ownership recovery, backend readiness and replay response schema; B02/B15; TS. Existing auth/redaction/same-connection guards remain.

**Accept:** Turn A constraint survives service restart into turn B's core prompt. Missing/corrupt session fails distinctly. Detach while live, load through a new socket, cancel the original turn and refuse a second prompt until settlement. Kill temporary socket owner and restart same path; live foreign owner stays protected. Ready remote backend runs with empty client-local providers; auth/connection/server readiness remains visible. JSON replay exports ordered nonempty assistant text without effects.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/serve-bridge.test.ts sdk/src/__tests__/serve-socket.test.ts sdk/src/__tests__/acp-session-data.test.ts sdk/src/__tests__/acp-client.test.ts`; add real local socket/restart fixture and CLI attach/replay controls. Emit canonical session/run/controller IDs and source response schema. Stop receipt-only reload being called conversation resume or connection loss removing original cancel/admission authority.

### [ ] B18 — Hash exact executable actions and govern every compound effect

**Trace:** R6/R7; high-impact-approvals/terminal-authority; 09-F1, 09-F2, 09-F3. Whitespace is collapsed before scanner/hash (`sdk/src/services/harness-enforcement.ts:153,162,649`); classifier returns first effect (`:425`); push flags lose destructive meaning (`:174,719`).

**Owner/scope/deps/language:** X/C; immutable exact-command identity, complete parsed action roster, approval tokens and policy explanations; none; immediate TS repair with D40 native parser authority when available. Preserve full-access/allow-all deliberate choices and profile-preserving one-shot reruns.

**Accept:** Quoted-space/newline/substitution forms retain exact distinct identity. Routine first effect cannot mask later destructive/deploy effect. Force/delete/refspec push cases retain risk across policy modes; ordinary feature work remains usable. Approval applies once only to the exact captured action/profile/basis; reordered/changed bytes or stale scope require new decision. Malformed/unsupported parsing is explicit, not confident authorization.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/run-terminal-command.test.ts`; add production policy fixtures and harmless real shell traces, plus differential adversarial parser corpus (`bash -n` only where syntactic validation is relevant). Emit the full effect roster and exact approval hash. Stop hash collisions, first-effect-only policy or a prompt/profile label being described as OS enforcement.

### [ ] B19 — Thread one effective execution context through present launchers

**Trace:** R6/R7/R10; child-env-and-output, validation-effects, file-change-validation-hooks; 09-F4, 09-F8/12-F5 and current full-access choice. Diagnostics inherit/merge host env (`sdk/src/services/diagnostic-delta-runner.ts:122`); LSP/Chrome/SCIP omit explicit env (`language-intelligence.ts:615`; `tools/browser-logs.ts:1484`; `services/scip-runner.ts:322`); hooks lack authorizer/profile (`tools/file-change-hooks.ts:1585`); undefined auto inference is enabled (`:1538`; `sdk/src/provider-config.ts:514`).

**Owner/scope/deps/language:** X/C; effective owner/environment/profile/approval/deadline/signal/result context across SPEC's finite launcher matrix; B02/B18; TS adapters. Merge then scrub canonical/configured credential references while preserving ordinary project variables and explicit delegated server credentials. Native B21 consumes this contract; it is not its prerequisite.

**Accept:** Each current production launcher has actual env/profile/owner/signal/admission evidence. Sentinel provider keys are absent unless delegated; overrides cannot reintroduce stripped keys. Hooks preserve trust/authorizer outcomes and effective profile; omitted/false inference is disabled, explicit true enables it, actual timeout matches documentation. A custom strategy performs ordinary full-access read/edit/command work through the real SDK consumer; a required unavailable profile returns unavailable without false enforcement. A selected user/model route wins over recommendation. Lifecycle evidence does not prescribe the strategy's next task action. Wrapper/SDK receipts reflect actual full access.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/env.test.ts sdk/src/__tests__/file-change-hooks.test.ts sdk/src/__tests__/run-terminal-command.test.ts sdk/src/__tests__/browser-logs-sandbox.test.ts`; add an injected capture matrix for every launcher, with real key-free terminal/diagnostic/hook controls. Emit requested/available/active/enforced context independently. Stop implicit host inheritance, an unused context parameter, or unavailable authorizer becoming approval.

### [ ] B20 — Settle owned process scopes and cached transports after actual cleanup

**Trace:** R2/R6; sync-process-lifetime/owned-background-jobs/mcp-process-effects/generic-sidecar-supervision; 09-F5, 09-F6, 09-F7, 09-F10 and 11-F2. Leader close cancels KILL escalation (`sdk/src/tools/run-terminal-command.ts:1663`; background-jobs `:497`); quota terminal error removes kill authority (`:798,1257`); MCP cap deletes without close (`common/src/mcp/client.ts:51`); sidecar reuse retains old stop promise (`sdk/src/services/sidecar-supervisor.ts:190,255`); evaluator exec settles on abort (`evals/buffbench/agent-runner.ts:422`).

**Owner/scope/deps/language:** X with Q consuming the process primitive; common process-scope lifetime, terminal/background jobs, transport leases/eviction and supervisor generations; B02/B19; TS cooperative process groups first, native OS-scoped tiers B21/B22. Failure reason and cleanup liveness are separate.

**Accept:** SPEC's deadline/TERM/KILL/reap fixture covers redirected/background/TERM-resistant descendants, abort, quota and normal exit. A living covered descendant fails selected enforcement acceptance and retains kill authority; logs remain bounded/drained. Cached idle MCP eviction closes exactly its resource; active leases survive until release. Repeated start→stop uses the current generation. Evaluator cancel produces no late marker write or owned living scope. Deliberate detach transfers an explicit owner rather than masquerading as termination.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/run-terminal-command.test.ts sdk/src/__tests__/kill-job.test.ts sdk/src/__tests__/sidecar-supervisor.test.ts common/src/mcp/__tests__/client.test.ts evals/buffbench/__tests__/agent-runner.test.ts`; add real Linux grandchildren and resource leases. Run an installed SDK cancel fixture in an isolated package host as an affected-path check. Receipt shows PIDs/scope/exit/cleanup timing and output bounds. Stop timeout/stopped/error labels used as proof of process death or a living descendant graded as pass.

### [ ] B21 — Integrate the actual Rust exec role and selected OS enforcement

**Trace:** R2/R6/R7/R9/R12; native-exec-standalone/native-host-adoption; 09-F9 and native envelope probe. Actual exec accepts raw ExecPlan then replaces itself (`rust/crates/openbuff-native/src/exec/mod.rs:138`); generic supervisor uses correlated method/params, with no consumer (`sdk/src/services/sidecar-supervisor.ts:147`); smoke still expects a stub (`rust/scripts/smoke-test-sidecar.sh:45`). Current protocol advertises lexical/unrestricted/no sidecars (`common/src/protocol/acp-ext-v1.ts:293`).

**Owner/scope/deps/language:** X/C; one-shot TS exec adapter, verified executable artifact lookup, versioned control/enforcement contract, Rust exec and native CI/smoke; B19/B20. Keep D48/D49: one multi-call artifact, Linux bubblewrap+seccomp with Landlock layering; macOS Seatbelt; Windows restricted token/user/ACL/firewall. Unimplemented platform/network cells remain unavailable.

**Accept:** Authored fixture A passes using the actual checksummed installed binary without Python. Control/handshake traffic is distinct from target stdout/stderr; JSON-RPC-shaped target output remains ordinary output. Version mismatch, nonexecutable/corrupt/missing artifact, partial/unavailable enforcement and required-vs-optional profile selection are truthful. Allowlisted fixture access succeeds and excluded access fails under selected enforced Linux mode; actual covered process scope terminates on selected hard limit. cwd/env/basis/owner/usage/result reach the TS/CLI consumer. Native smoke and boolean matrix guards demonstrate executed host-native jobs; skip cannot count as native assurance.

**Verify/evidence/stop:** after the selected locked bootstrap below, from the repository root run `cargo build --manifest-path rust/Cargo.toml --workspace --locked --offline --target-dir "$BODY_EVIDENCE/B21/rust-target"`, then `cargo test --manifest-path rust/Cargo.toml --workspace --locked --offline --target-dir "$BODY_EVIDENCE/B21/rust-target"`, then `bash rust/scripts/smoke-test-sidecar.sh "$BODY_EVIDENCE/B21/rust-target/debug/openbuff-native"`. Run authored fixture A with the concrete native-binary argument below. Use a dedicated control channel or explicit pre-exec phase, not persistent RPC for one-shot exec. Emit actual checksum/mode/version/enforcement. Missing tool/OS mode stays unavailable; no skipped path or handshake alone graduates native adoption. B19/B20/full B21 gates retain their scheduling cost; M22-CORE follows accepted B21, not a partial boot.

### [ ] B22 — Start the minimal rusqlite daemon after native exec

**Trace:** R2/R3/R4/R6; 05-C15/C17, native-host-adoption, owned index/leases; D50/D51/D56 current subset. No durable run-owner daemon/lane authority is currently wired (pair 05/09); current lock/replay/lease defects are at `sdk/src/services/workspace-mutation-broker.ts:601`, `packages/indexer/src/index-store.ts:1164`, `packages/agent-runtime/src/util/workspace-path-leases.ts:45`, `run-agent-step.ts:1963`.

**Owner/scope/deps/language:** X/C; native admission/store/job/journal/lease/commit primitives and participating TS adapters; rollup prerequisites M22-CORE/M22-TXN/M22-CHILD. M22-CORE starts after B04/B15/B21; transaction import waits B05/B07; production child migration waits B16 and the native transaction milestone when child commits consume it. Rust/rusqlite owns OS-held resources and persistence; the C-owned SessionAuthority supplies identity/run semantics, while the model still chooses reasoning/actions.

**Accept:** Each M22-* scope below has its own real SDK/runtime/native receipt. The baseline proves one admitted repository backend/epoch, common identity registration, live/expired ownership, fenced new commit API and truthful outage/version handling. M22-TXN proves corrected populated intent/recovery import with foreign divergence/replaced parent/once-failing restoration; M22-CHILD proves real detached/supervised ownership/state migration. Unsupported families refuse rather than keep writing via TS. B22 rollup requires the mixed-client/cutover/outage/rollback matrix and all three milestones; two new native clients or an empty store do not establish full migration.

**Verify/evidence/stop:** add daemon/store tests and run root-relative `cargo build --manifest-path rust/Cargo.toml --workspace --locked --offline --target-dir "$BODY_EVIDENCE/B22/rust-target"` and the corresponding `cargo test`. Run daemon-two-client.ts separately for M22-CORE/M22-TXN/M22-CHILD with exact flags below, then the rollup matrix. Emit repository/backend/epoch/phase/protocol/identity/fence/import hashes/cleanup and conflict receipts. Stop two admitted authorities, stale ticket success, silent TS fallback, ungated import or post-native restoration of stale TS state. TS is available only as an explicitly selected pre-activation backend, not an outage fallback from native.

#### B22 repository authority and transition contract

This is a proposed versioned implementation contract, not a claim that it already ships. Its scope is **participating Openbuff operations**, grounded in the current independent broker/index/snapshot/child paths (`sdk/src/services/workspace-mutation-broker.ts:601`; `packages/indexer/src/index-store.ts:1164`; `cli/src/utils/turn-snapshots.ts:461`; `packages/agent-runtime/src/util/workspace-path-leases.ts:45`, 06-F1/08-F8/05-F9/05-F7).

1. **One identity issuer and semantic owner.** The C-owned SessionAuthority is the sole identity issuer/registrar and run-terminal transition owner. It returns durable session/run/turn/task/action/attempt tickets using the injected IdGen and original registered namespace; interrupted IDs are imported unchanged. In native mode the daemon transactionally stores/adopts those tickets and validates their owner/epoch, not a second run/task-success state machine. OS results become observations for the SessionAuthority's typed run transition; task acceptance remains its separate oracle. Clients/children cannot remint interrupted IDs or invent authority from serialized labels.
2. **One repository control backend and epoch.** An owner-private, physically root-bound `RepositoryAuthorityRecord` schema 1 names `repositoryId`, active backend (`ts` or `native`), monotonic `epoch`, migration phase/id, identity namespace, store schema and supported writer protocol. Filesystem hints are discovery only; the admitted authority validates current epoch at the operation boundary. Initial proposed authority protocol/store schema are 1, with explicit min=max=1 compatibility; real package/binary versions/digests are frozen in the execution manifest. Old-wire compatibility adapters participate only when they implement that admission protocol. An incompatible protocol receives typed version refusal; readers may get declared read-only projections, never implicit TS write compatibility.
3. **Participating writer set.** Upgraded SDK/CLI mutation broker/filesystem-authority/changeFiles and semantic edits; startup/transaction recovery scanners; snapshot capture/private-ref publication; index/cache/graph publication; run/checkpoint/journal and task-state publishers; and supervised/inline/background child-mediated commits register with the same repository admission gate. The migration manifest enumerates each concrete adapter and operation readiness. Computation/index parsing remains TS; final publication invokes the selected authority. Unsupported writer families in an active native epoch return unavailable/recovery-required. Configured shell/hooks/custom/MCP tools and arbitrary user/full-access writes that do not call mediated primitives remain **external effects**; they retain journal/reconciliation and captured-basis conflict limits.
4. **Admission and fences.** A request carries repository/epoch, registered identity, owner generation, action, captured basis and operation scope. Participating TS-backend writes hold a live admitted operation lease through effect and acknowledgement; they cannot release it before detached work ends. During migration they enroll/drain under the native OS-held repository gate. Native-active mutations/publications are performed by the authority's fenced primitive, which validates epoch/generation in the same guarded operation; clients do not validate once and then write independently. Unknown/living/unreconciled holders block cutover rather than being expired as proof of death. B04 remains fail-closed for ambiguous pre-native locks.
5. **Quiesce/import/activate.** Acquire the verified OS-held repository/migration gate, publish `ts-quiescing` for the expected old epoch, stop new participating write admission and drain/cancel acknowledged old operations with the declared finite manifest deadline. Failure to prove quiescence returns recovery-required and preserves originals. Capture immutable copies/checksums of the selected stores; import into staging while production effects remain barred. M22-CORE may activate only eligible fresh namespaces without unresolved legacy transactions/production child state; populated imports require their M22-TXN/M22-CHILD gates. After schema/hash/identity/conflict validation, atomically CAS/fsync the authority selection to native epoch e+1. No per-writer mixed TS/native exclusion domains remain. A killed process before/after pointer publication is recovered from the authoritative record under the same OS gate, not a possibly stale hint.
6. **Outage and protocol skew.** Once native selection is active, disconnect, daemon death, unknown schema or version mismatch preserves IDs/reservations/receipts and returns authority-unavailable/recovery-required for mediated writes. No catch path silently selects TS. Recovery reacquires the same physical repository gate and validates WAL/epoch/in-flight effects before admission. Every supported packed compatibility adapter discovers selection and validates its ticket at dispatch. An **unaware unmodified old binary** can still write as the user; it is outside the fence guarantee, even if its output resembles a supported old-wire request. The mixed-version fixture states this boundary and requires observed divergence/conflicts rather than claiming universal prevention.
7. **Abandonment versus rollback.** Before native activation and before native production effects, staging import may be abandoned only after confirming the old epoch/backend/original stores and resolving in-flight operations; resume the selected TS backend under its declared B04 tier. Ambiguous activation state refuses abandonment. After activation or any native production write, this baseline **refuses an in-place downgrade/restoration of the old TS snapshot**. Recover the authoritative native epoch. A later explicit reverse migration would need its own quiescence, current-native export/conflict/uncertain-state proof and a new epoch; it is not an automatic rollback implemented by this card.

OS fences govern admitted operations, not every same-user filesystem writer. Native basis checks preserve observed foreign divergence and retain incomplete/conflict evidence; they do not promise universal exclusion or instantaneous multi-file visibility against arbitrary full-access external races.

| Milestone | Required real acceptance cases |
|---|---|
| M22-CORE | Actual transition-aware TS-backend SDK/CLI client, native client and stale live/detached participating operation holder; common tickets/epoch, quiescence or explicit refusal, version-0/incompatible request refusal, eligible fresh activation, fenced commit/publication, daemon outage and no TS fallback. An unaware old binary/external writer is tested as outside fencing with observed basis conflict |
| M22-TXN | After B05/B07: populated legacy intent with exact raw hashes, expected after-state or explicit missing-proof uncertainty, foreign divergence, moved parent symlink and once-failing restoration; import/restart retains foreign/outside bytes, originals, unresolved/retryable records and IDs. Production recovery invokes the imported corrected contract |
| M22-CHILD | After B16 (and M22-TXN for child commits): real detached/supervised child journals/final state, live TTL renewal and owner transfer/reconnect; old admitted child ticket refuses after cutover, cancellation ownership survives, unknown children block activation. No PRE-spawn/abort allegation is assumed without current fixture evidence |

The combined matrix kills before import, during import, just after activation and after a native commit; injects old/new protocol skew, a daemon outage and attempted stale-TS rollback; and proves the specified refusal/recovery path through actual adapters. It never credits a token-only store test as cross-backend exclusion.

### [ ] B23 — Make language registry and graph identities operation specific

**Trace:** R8/R9; target-language-profiles/structural-language-semantics/precise-cross-language-reference-contract; 07-F2, 07-F3, 07-F8, 07-F10, 07-F11. Bare ext families collapse (`common/src/util/language-profiles.ts:163`; code-map parse `:891`); SCIP symbol truncation corrupts identity (`packages/indexer/src/scip-ingest.ts:367`); profile ID is document ID (`sdk/src/services/lsp-multiplexer.ts:1040`); Rust/Go import resolvers select wrong scopes (`packages/indexer/src/import-resolution.ts:275,359`).

**Owner/scope/deps/language:** L/C; open D29 registry with explicit generic tier, versioned operation availability and exact path/ext/document/symbol IDs; none; TS plus consumed resolvers. Retain display labels separately from full bounded opaque IDs/digests; update wire/golden contracts compatibly.

**Accept:** Full paths/bare/dotted extensions select identical correct families for the finite grammar list; JavaScript/JSX/TSX/C have correct document IDs. Same-language call/import positives survive; false Python→Rust and Go→TS edges are absent. Rust crate/self/super resolves owning crate. Two long SCIP descriptors sharing display prefix retain distinct definitions/references; ambiguous definitions report ambiguity. Unknown language supports generic operations with unavailable higher cells.

**Verify/evidence/stop:** `"$BODY_BUN" test common/src/util/__tests__/language-profiles.test.ts common/src/util/__tests__/language-capability-manifest.test.ts packages/indexer/src/call-navigation.test.ts packages/indexer/src/scip-ingest.test.ts`; add path/ext and actual graph fixtures. Record identity/availability/version manifests and opaque collision results. Stop grammar membership becoming semantic capability or a cross-language edge lacking explicit interface evidence.

### [ ] B24 — Ship parser/query assets and exercise packed language consumers

**Trace:** R8/R12; grammar-query-packaging/sdk-node-packaged-consumer/cli-and-native-installed-validation; 07-F1. Builder creates queries but archive lists omit them (`cli/scripts/build-binary.ts:658`; `.github/workflows/cli-release-build.yml:460,644`); SDK copies only WASM (`sdk/scripts/build.ts:147,508`); lookup depends on checkout package resolution (`packages/code-map/src/utils.ts:25`). Fresh pinned PHP/Swift/Kotlin/GDScript assets do parse; blanket grammar absence is not supported (pair 07).

**Owner/scope/deps/language:** L/Q; SDK builds/package contents, both CLI archive lanes/wrapper resources and runtime asset lookup; B23; existing web-tree-sitter/WASM/query assets. Native parse is a conditional measured tier, not a packaging prerequisite.

**Accept:** Every fifteen-variant grammar/query fixture yields nonempty expected symbol/import/call evidence from source, packed CJS/ESM SDK and installed CLI with checkout unavailable. Overrides work deliberately; default installed lookup works without forced checkout paths. Missing/corrupt/ABI-wrong assets produce explicit unavailable state rather than successful empty semantics. Package lists/checksums include queries in both release lanes. Public SDK package host runs observe/edit/validate/cancel cells as their B05/B19/B20/B27 contracts graduate.

**Verify/evidence/stop:** `"$BODY_BUN" test packages/code-map/__tests__/all-language-wasm.test.ts packages/code-map/src/__tests__/structure.test.ts sdk/src/__tests__/build-esm-fixup.test.ts`; planned `test/fixtures/body/packed-language-assets.ts` builds/packs through current package scripts and tests isolated installs. Emit tarball members/checksums, tool/runtime versions and actual semantic output. Stop tests that succeed only through repository ancestry, warnings about missing tokens or skipped parser rows. Installed mutation/control cells cannot be claimed before their own oracle runs.

### [ ] B25 — Own LSP document versions, roots, protocol requests and server life

**Trace:** R2/R3/R6/R8; lsp-navigation-lifecycle/lsp-document-sync; 07-F4, 07-F5, 07-F6, 07-F8, 07-F9. didOpen/post-edit counters duplicate (`sdk/src/services/lsp-multiplexer.ts:1040`; `language-intelligence.ts:979`), eviction/skipped dirty state stays stale (`:593`), gone/restart can orphan (`lsp-multiplexer.ts:572,961,1443`), nearest marker is overwritten (`:668`), requests with method are ignored (`:539`).

**Owner/scope/deps/language:** L; multiplexer document/server authority and language-intelligence observer integration; B05/B19/B20/B23; TS plus installed ecosystem servers. Document bytes/versions share the mutation basis and negotiated encoding; restart publication is generation owned.

**Accept:** Strict peer query→edit→query sees fresh disk bytes with increasing versions. More than 64 documents, 33-file edit, oversized/deleted/dirty files reopen/invalidate truthfully. Nearest root/document IDs match fixtures; supported client requests receive replies and unsupported ones typed errors. Malformed framing and dispose-during-restart leave zero covered living server generations. Real selected TS/pyright/rust-analyzer/clangd cells execute their capability fixtures; absence is unavailable and blocks claims for that cell.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/lsp-multiplexer.test.ts sdk/src/__tests__/language-intelligence.test.ts sdk/src/__tests__/lsp-real-server.test.ts`; add strict peer and real installed-server fixtures from a precommitted toolchain manifest. Emit observed versions/roots/protocol/error/liveness. Stop pool-count-zero as proof of death, stale opened docs or skip-gated mocks being promoted to per-language certification.

### [ ] B26 — Publish coherent retrieval generations, bounded caches and fair coverage

**Trace:** R5/R8/R9/R12; 08-C1–C8; 08-F1, 08-F2, 08-F3, 08-F4, 08-F5, 08-F6, 08-F7, 08-F9. Metadata precedes failed vector replacement (`packages/indexer/src/index-manager.ts:663,779,1086`); cache write/read caps disagree (`index-store.ts:432,584`); scope follows global posting cap (`query-data.ts:139`; `query.ts:275`); walker discards under-budget files (`file-walker.ts:458`); unchanged refresh drops precise edges (`metadata-indexer.ts:741`); graph isn't snapshot fence (`index-store.ts:658`); same-stat hints reuse hash (`metadata-indexer.ts:572`); deltas reset full-sweep age (`index-manager.ts:1112`).

**Owner/scope/deps/language:** L; manager/store/walker/metadata/query/SCIP generation and client projection; B04/B23; TS corrections and existing SQLite/partitioning where warranted. Source, retrieval/config/graph and embedding-input identities remain separate; native service tier waits for a measured need.

**Accept:** Held/failed embedding batches after change/delete/add never serve ghost/stale vectors as current; lexical fallback is truthful. Realistic 1536-dimensional/CJK/emoji caches roundtrip under symmetric actual-byte limits. Sole scoped result beyond 4096 global candidates survives; all 91 eligible uneven-bucket files fit maxFiles100. Precise edges survive unchanged reopen and invalidate on changed basis; a stale graph merge cannot overwrite newer enrichment. Explicit same-stat hint rehashes; continuous precise edits cannot starve declared full reconciliation. SDK/MCP/CLI preserve indexedHash, relatedFiles and immutable chunk/artifact IDs.

**Verify/evidence/stop:** `"$BODY_BUN" test --isolate packages/indexer/src/index-manager.test.ts packages/indexer/src/index-manager-semantic.test.ts packages/indexer/src/index-store.test.ts packages/indexer/src/query-data.test.ts packages/indexer/src/retrieval-quality.test.ts`; add real uneven-tree/vector-size/generation fixtures and an edit→query consumer. Emit bytes/fingerprints/scope truncation/last-full-sweep and lexical-vs-semantic results. Stop newer provenance attached to stale semantics or porting an engine before correctness/coverage parity.

### [ ] B27 — Integrate observed per-root validation and joined component contracts

**Trace:** R3/R6/R8/R9; diagnostic-delta/compiler-build-test-discovery/cross-language-interface-validation/environment-target-languages; consumes B36's immediate 07-F7 repair, plus absent graph/coverage tiers and 06-F6. Current outcome loss is at `sdk/src/services/diagnostic-delta.ts:232,463`/`file-change-hooks.ts:1691`; affected-test graph tier is unwired (pair 12). B36 fixes false passed evidence independently; this card graduates deeper coverage/consumer integration.

**Owner/scope/deps/language:** L/C; fair per-root/language diagnostic/build/test coverage, actual index reverse-dependency consumer, joined schema/ABI receipts and consumed fix-it/codemod adapters; B06/B19/B23/B24/B25/B26/B36. TS orchestrates mature ecosystem tools. No current timeout/127 false-success repair waits for these prerequisites.

**Accept:** Preserve B36's truthful outcomes while fair per-language/per-root selection executes intended targets with B19 context and scoped basis/coverage. SPEC B (TS/Rust/Python required sourceRevision), C (C/Python ABI) and D (unknown generic) execute real producer/consumer checks; stale schema, failed consumer or missing tool prevents joined acceptance. A failure/crash in sequential refactor is partial/recovery-required until B06/B07 and the consumer oracle conclude, not atomic all-files success. Explicit interface edges/artifact versions/hashes and observed diagnostics join the result.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/diagnostic-delta.test.ts sdk/src/__tests__/harness-intelligence.test.ts`; run proposed order-contract, c-python-abi and unknown-generic runners with exact commands below after selected-tool bootstrap. Emit each actual command/exit/root/coverage and joined contract oracle. Stop candidates/grammar counts substituting for validation, unsupported/partial refactor promoted as whole-contract pass, or target Python becoming mandatory body authorship.

### [ ] B28 — Preserve MCP/custom schema, result, catalog and origin semantics

**Trace:** R1/R8/R10; mcp-tool-schema-and-result-interoperability/mcp-config-trust-and-discovery/sdk-custom-tools-and-host-callbacks; 10-F1, 10-F2, 10-F4, 10-F6, 10-F7, 10-F8, 10-F9. MCP projection discards failure/structured content (`common/src/mcp/client.ts:862`); JSON loses WeakMap origin and registry relabels (`sdk/src/run.ts:1075`; `agent-registry.ts:185`); first-page/stale discovery (`run.ts:1594`; mcp client `:830`); schema broadening/sentinel check (`common/src/templates/agent-validation.ts:500,331`); all strings treated as paths and delimiters misdecode (`tool-executor.ts:4201,4288`).

**Owner/scope/deps/language:** T/C; canonical tool descriptor/result/schema validator, discovery generations/pagination/identity and host-authoritative provenance references; none for immediate fidelity; TS/MCP/JSON Schema. Retain original async custom schema refinements/transforms and healthy-server isolation; later execution/journal context is consumed through B15/B19 rather than blocking the immediate fix.

**Accept:** Empty failure, structured-only output, text/resource/media error and success survive adapter→SDK→runtime→CLI/MCP projections. JSON continuation and supervised RPC preserve per-server host origin without trusting peer labels. Pagination/cursor loop/list-change/reconnect report generation/incomplete state. Constraint acceptance matrices, defaults/transforms and never/additionalProperties/prompt enum/minLength survive or refuse unsupported forms. `/api/v1`, regex/separator data stay data; declared path effects remain governed. Difficult server/tool/custom names dispatch reversibly.

**Verify/evidence/stop:** `"$BODY_BUN" test common/src/mcp/__tests__/client.test.ts sdk/src/__tests__/custom-tool-dispatch.test.ts sdk/src/__tests__/run-mcp-tool-filter.test.ts sdk/src/__tests__/mcp-server.test.ts packages/agent-runtime/src/__tests__/mcp-tool-schema.test.ts`; add full-result/JSON/RPC/schema/pagination fixtures. Emit catalog/schema/origin generations and unchanged failure receipts. Stop authority upgrading after serialization, unrepresentable:any silently widening validation or metadata-only success projection. Immediate TS fidelity waits for no native/context phase.

### [ ] B29 — Load explicit agents and transport trusted modules without stringification loss

**Trace:** R4/R7/R10; local-agent-loading-and-provenance/programmatic-agent-extension-abi/declarative-agents-lifecycle-hooks-and-plugin-host; 10-F3, 10-F5, 10-F10, 10-F11. Discovery imports before validation (`sdk/src/agents/load-agents.ts:66,193`); handleSteps stringifies (`:221`; `sdk/src/run-state.ts:146`; `cli/scripts/prebuild-agents.ts:87`); runtime host global reconstruction (`run-programmatic-step.ts:401`); wrapper claims tmux-test but runtime forces full-access (`.agents/lib/cli-agent-schemas.ts:10`; runtime terminal handler `:38`).

**Owner/scope/deps/language:** T/C; explicit entrypoints/import diagnostics, trusted references and content-addressed Bun.build dependency bundles, small declarative config parity, truthful receipts and D53 host lifecycle consumer; B15/B19/B28. Automatic continuation uses B15's declared recorded-prefix contract; arbitrary trusted full-access modules remain executable even when replay eligibility is unavailable. QuickJS/WIT is separate; no heap snapshots.

**Accept:** Immutable constants/imported helpers/captured configuration work identically in local, compiled and supervised paths. A replay-safe manifest declares all reconstruction-relevant host inputs; positive recorded-input prefix replays, while changed bundle/runtime, unrecorded mutable module state or nondeterministic/direct I/O refuses automatic original continuation. The host does not claim to detect every arbitrary JS state dependency; unknown eligibility stays unavailable. Entry-point/import/config tests retain their original guarantees. A custom strategy's normal full-access action and explicit route override work through the real consumer; unavailable required enforcement is truthful. The host statechart owns lifecycle, not the model's task strategy.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/load-agents.test.ts packages/agent-runtime/src/__tests__/run-programmatic-step.test.ts packages/agent-runtime/src/__tests__/sandbox-generator.test.ts agents/__tests__/spawn-contract.test.ts`; run proposed trusted-bundle.ts and replay-prefix.ts below. Emit hashes, recorded-prefix/eligibility/refusal and actual profile/route. Stop unexecutable closures, auxiliary imports, bundle-as-heap claims, silently assumed nondeterminism safety, strategy restrictions or unconsumed statechart adoption.

### [ ] B30 — Isolate evaluator state and retain complete typed attempt evidence

**Trace:** R1/R2/R11/R12; evaluation-orchestration-and-oracles/paired-polyglot-evidence/trace-artifact-hygiene; 11-F1, 11-F3, 11-F4, 11-F5, 11-F6, 11-F8, 11-F9, 11-F10. SDK error returns ordinary runner (`evals/buffbench/runners/codebuff.ts:125,198`); tests delete hardcoded lessons (`run-buffbench.ts:314`; `__tests__/run-buffbench.test.ts:1091`); comparisons overwrite repeats/drop low scores (`scripts/compare-buffbench-runs.ts:35,66`); strata are omitted (`run-buffbench.ts:333`); NaN passes significance (`proposals.ts:437`); final checks inherit controller env (`agent-runner.ts:426`); minute directory collision (`run-buffbench.ts:859`).

**Owner/scope/deps/language:** Q; injected lesson/artifact sinks, typed runner outcomes, immutable run/repeat/experiment metadata, key-free ephemeral evaluation context and shared finite statistics/score eligibility; none for isolation/fixture repairs. Use existing resolved SDK error shapes; integrate B02/B09 outcomes/cost when available without making safe measurement wait for whole groups. TS first; optional offline Python only after correct populations.

**Accept:** Unrelated sentinel lessons and simultaneous fixtures survive cleanup. Traversal IDs cannot escape run artifact root; fixed-clock runs have disjoint manifests/atomic outputs. Resolved SDK error/cancel/incomplete remains unsuccessful regardless of high judge score, with paid/error/artifact data retained. Repeat order cannot reverse 8→4.75 into improvement; measured zero/low scores remain eligible by typed status. Mixed language/routes are reconstructible from artifacts alone. Nonfinite/invalid/insufficient paired statistics reject. Key-free mode hides controller sentinels and uses ephemeral home; weaker trusted-task mode is labeled separately.

**Verify/evidence/stop:** first `"$BODY_BUN" test evals/buffbench/__tests__/statistics.test.ts evals/buffbench/__tests__/proposals.test.ts evals/buffbench/__tests__/agent-runner.test.ts`; **do not run run-buffbench.test.ts until the injected-sink repair and sentinel check are in place**. Then run that isolated suite and a planned `test/fixtures/body/evaluation-artifacts.ts` with real comparison CLI. Emit complete attempt population/cost/sinks/strata/finite rejection results. Stop any cleanup touching shared lessons, paid attempt exclusion from accounting, incomparable populations or temporary cwd being called OS isolation.

### [ ] B31 — Wire held-out candidate trials, explicit application and rollback

**Trace:** R5/R9/R11; learning-proposal-promotion/procedural-learning-feedback; current proposal adoption is unwired (pair 11), procedures have consumer defects (04-F6–F8), language strata vanish (`evals/buffbench/run-buffbench.ts:333`) and gate lacks finite safety (`proposals.ts:437`).

**Owner/scope/deps/language:** Q/M/C; versioned lesson/prompt/router candidate channel and actual baseline/candidate runner→consumer pointer→rollback; B02/B09/B12/B13/B14/B27/B30. TS policies/small routers; optional Python offline statistical oracle/training/export and Rust ORT/consumed llama-server only after a recorded data/benefit gate.

**Accept:** Before trial, commit task/repo/train/held-out split, resolved model/provider/config/budget/seed/repeats/language manifests, B09 admission policy and finite comparison/confidence/margin/minimum-powered-pairs rule. No held-out leakage. Plumbing mode proves reject/insufficient/qualifying synthetic control/application/rollback without claiming empirical improvement; a real held-out claim requires eligible complete paired attempts. Degraded candidate restores exact baseline behavior. Deterministic regressions are zero; stochastic language quality uses declared uncertainty. A real consumer preserves explicit user/model route over recommendation and full-access task choice; paid/failed/incomplete attempts remain accounted.

**Verify/evidence/stop:** `"$BODY_BUN" test evals/buffbench/__tests__/statistics.test.ts evals/buffbench/__tests__/proposals.test.ts sdk/src/__tests__/agent-runtime-impl-playbook-outcome.test.ts`; run proposed candidate-promotion.ts in explicit plumbing or locked BYOK mode below. Plumbing can be developed after B30 with a narrower recorded receipt; it does not accept the full B31 card before its language/outcome/admission prerequisites. Emit policy/split/raw comparison/application/rollback. Stop post-hoc thresholds, missing strata/cost, insufficient power, failed rollback or synthetic plumbing described as empirical learning.

### [ ] B32 — Repair CI/release oracles and record comparable performance baselines

**Trace:** R1/R12; ci-guards-and-performance/cli-and-native-installed-validation/sdk-node-packaged-consumer; 11-F11, 11-F12, 09-F9 context and historical X-2 rows. Provenance modifications have no prescribed passing gate (`.github/workflows/ci.yml:125`); smoke accepts success markers plus fatal output (`cli/scripts/smoke-binary.ts:273,339`). Current measurement script separates deterministic structural rows from timing, while cold start/input/manual rows lack a completed baseline (pair 11/PLAN-NOTES).

**Owner/scope/deps/language:** Q/C; source/provenance workflow policy, fatal/drain-aware binary smoke, nonempty integration discovery/artifact retention and baseline harness/manifest; none. This starts with current baseline and safe harness fixtures. Actual install/native graduation remains attached to B05/B20/B21/B24/B25/B27/B29/B33/B35, not postponed to a final evidence phase.

**Accept:** Approved new per-release provenance entry passes while identity rewrite/deletion fails over correct PR/push ranges. Smoke rejects success+fatal, missing marker, nonzero, timeout and late/split fatal in every mode. Native/installed CI records which executable/asset tests actually ran; empty/skipped jobs are not success. Comparable correct-workload baseline covers token/stream/index byte/parse/query, cold/warm install/CLI startup, long rendering and cancel/failure cases with machine/config/version/repeats/failure accounting. Thresholds are chosen from recorded baseline/invariant before optimization; structural checks are not timing wins.

**Verify/evidence/stop:** `"$BODY_BUN" test scripts/__tests__/ci-workflow.test.ts scripts/__tests__/release-workflow.test.ts scripts/__tests__/measure-perf-guards-baseline.test.ts cli/src/__tests__/release-wrapper.test.ts`; run existing `scripts/measure-perf-guards-baseline.ts` under pinned Bun and add actual startup/input/installed cells, with model/key-free correct fixtures first. Emit before/after raw rows and uncertainty, fatal negative controls, artifact/job manifests and approved provenance cases. Stop invented performance percentages/10× targets, paid failures hidden in comparisons, or marker-only fake binary acceptance.

### [ ] B33 — Make browser/image/render observations and action ownership truthful

**Trace:** R1/R2/R5/R6/R7/R10/R12; browser-actions-and-policy/browser-observations-and-media/read-image-media/cli-image-attachments/render-ui-link-widget; 13-F1, 13-F2, 13-F3, 13-F4, 13-F8, 13-F9. Omitted/read-only policy diverges (`common/src/tools/browser-policy.ts:46`; runtime browser handler `:39,68`); trusted child becomes main owner (`sdk/src/run.ts:1097,2847,2851`); diagnose drops media/echoes conditions (`sdk/src/tools/browser-logs.ts:570,583`); diff crops extents (`:3338`); failed image retry sends old capture (`cli/src/utils/image-processor.ts:51,89`); render acknowledges without host (`packages/agent-runtime/src/tools/handlers/tool/render-ui.ts:14`).

**Owner/scope/deps/language:** U/X/C; structural browser policy/authenticated child ownership, diagnose/media/artifact/condition/diff outcome, image retry/read admission/cancellation and host render acknowledgement; B03/B05/B19/B20/B28; TS/current CDP/media tooling. Preserve pipe/fallback, private profiles, capture identity and original-byte image paths.

**Accept:** Omitted/read-only/interaction/plan-only cases agree through actual dispatch, including allowed scroll/design_tokens/tab-list and denied mutation. Two children/two roots have isolated sessions and exact cleanup while spoofed owner remains rejected. Diagnose preserves retrievable screenshot/PDF/APNG evidence, actual condition outcomes and failed aggregate status; extent mismatch is explicit. DOM/text caps expose coverage limits. Failed image retry requires explicit labeled reuse or omits/rejects stale bytes; read fan-out and post-I/O cancellation are bounded. Headless render is unavailable/submitted; actual CLI button delivery is acknowledged without claiming arbitrary HTML rendering. Run actual local Chrome fixture for the claimed browser cells.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/browser-logs.test.ts sdk/src/__tests__/cdp-pipe-transport.test.ts sdk/src/__tests__/read-image.test.ts packages/agent-runtime/src/__tests__/browser-logs-policy.test.ts sdk/src/__tests__/run-session-job-ownership.test.ts`; CLI attachment-retry/image-processor/render-ui tests use supported preload. Create `test/fixtures/body/local-browser.ts` with harmless local HTML and installed-CLI/SDK consumers. Emit delivered artifact hashes, owner/policy/condition/cancel states and real image dimensions. Stop declared success without delivered observation or sibling-wide cleanup.

### [ ] B34 — Add isolated concurrent workspaces and verified landing

**Trace:** R3/R4/R6/R9; 05-C14/C15/C16 and foreground/background delegation. Lane operations are explicitly absent (pair 05); current live leases expire (`packages/agent-runtime/src/util/workspace-path-leases.ts:45`); snapshot/mutation/partial-refactor defects are `cli/src/utils/turn-snapshots.ts:461`, `workspace-mutation-broker.ts:601`, `language-intelligence.ts:418`. Shared services need an owner that outlives one CLI (D42/D50/D51).

**Owner/scope/deps/language:** R/X/C; versioned lane identity, isolated per-agent workspaces/tests, daemon ownership and land/abort/conflict UI; B06/B07/B16/B17/B22/B27. Start with consumed Git worktrees and existing merge-tree contracts; gix/COW/reflink/semantic merge is a dated measured capability choice, not a prerequisite. Native daemon owns fenced primitives, TS model chooses lanes/selection.

**Accept:** Two live lanes cannot overwrite each other or the user's base workspace; per-lane tests and receipts bind to exact lane/base/contract versions. User/parent-selected landing uses an observed merge result; conflict/stale base is structured and preserves all inputs. Cancel/restart releases or renews actual ownership without lost work; child state/journal remain inspectable. Warm service use is measured across two sessions and declared memory/lifetime limits; no speed target is invented. Best-of-N remains opt-in and budgeted with complete attempt accounting.

**Verify/evidence/stop:** create `test/fixtures/body/two-lane-work.ts` using real temporary Git worktrees, two supervised children, killed/restarted daemon and actual build/test/merge commands; run with `"$BODY_BUN"`, plus B04/B16/B22 regressions. Emit lane/base/fence/merge/conflict/attempt receipts and installed-daemon client proof. Stop shared writable cwd being called isolation, blind stale landing or an N-lane quality claim without comparable task evidence.

### [ ] B35 — Bind 3D previews to immutable sources and observed artifacts

**Trace:** R1/R3/R5/R6/R8/R12; native-3d-inspection/blender-3d-inspection-preview/3d-declarative-edit/game-engine-workflow-helpers; 13-F5, 13-F6, 13-F7. Advertised formats lack import branches (`common/src/util/file.ts:24`; `sdk/src/tools/3d-assets.ts:154,183,816`); preview hashes then reopens live input (`:617,825,837,865`); error JSON counts rendered (`:888,1318,1384`). Engine job guidance lacks a found production consumer (pair 13).

**Owner/scope/deps/language:** E/X/L/C; per-format operation registry, immutable verified render input, observed PNG/artifact metadata, applied-edit+preview result fidelity and actual engine guidance consumer or corrected claim; B03/B05/B19/B20; TS orchestration/fixed Blender operators, native existing metadata parsers. No second mutation authority.

**Accept:** Actual selected Blender version inspects/previews glTF/GLB/OBJ and every additional advertised format/operation, or that cell is explicitly unavailable before effects. Editor replacement between hash/render uses original staged bytes or reports stale basis. PNG dimensions/hash come from decoded output. Commit followed by preview failure/cancel preserves applied artifact and returns previewRendered:false; unknown commits retain reconciliation copy. Artifact expiry/cutoff is inspectable. Engine recipes are labeled recipes until a real detected target/job/asset consumer exists.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/3d-assets.test.ts packages/indexer/src/3d-asset-indexing.test.ts common/src/util/__tests__/engine-profiles.test.ts`; create `test/fixtures/body/3d-render-basis.ts` with tiny committed assets, replace-source barriers, real fixed Blender render and installed CLI/SDK result projection. Emit source snapshot/artifact hashes, decoded dimensions, format/tool version and commit/preview/cancel states. Stop preview provenance based on an earlier live-path hash, error JSON treated as rendered or optional missing-Blender tests counted as real preview assurance.

### [ ] B36 — Repair diagnostic outcome and coverage truth immediately

**Trace:** R1/R6/R8; diagnostic-delta, targeted-validation-execution, file-change-validation-hooks; 07-F7. Capture discards execution status (`sdk/src/services/diagnostic-delta.ts:232`), empty failed observations are accepted (`:463`) and the hook calls them diagnostic_delta_passed (`sdk/src/tools/file-change-hooks.ts:1691`). The durable timeout/127 counterexample needs no new parser/server/index/refactor/native machinery.

**Owner/scope/deps/language:** L/C; current diagnostic command capture/delta result, file-change-hook projection and actual SDK/client result fields; **none**. Keep additive command/coverage outcomes compatible with existing consumers; B02/B19 later integrate shared run/context semantics, and B27 owns deeper per-root/language/contract coverage. TS-only current producer→consumer repair.

**Accept:** Through actual delta→hook→SDK/client projection, timeout, exit127, cancellation, missing command/language, partial/capped output and unknown observation are failed/unavailable/incomplete with reduced/no assurance, never passed diagnostic evidence. A complete normal check with no new errors passes; pre-existing/shifted harmless errors and genuine observed empty diagnostics stay distinct. An optional fail-open check may permit work while retaining its unsuccessful observation. This card reports cancellation truth; actual descendant-death enforcement is B20's separate proof.

**Verify/evidence/stop:** `"$BODY_BUN" test sdk/src/__tests__/diagnostic-delta.test.ts sdk/src/__tests__/file-change-hooks.test.ts sdk/src/__tests__/run-mutation-dispatch.test.ts`; create/run proposed diagnostic-outcomes.ts below with injected bounded command failures and real SDK projection, zero keys/model/network. Emit command exit/cancel/coverage/basis and hook/client states. Stop any failed/missing observation producing diagnostic_delta_passed, or any parser/LSP/index/native prerequisite being added to this immediate truth repair.

## Conditional capability register

These are explicit missing/deferred abilities, not implemented cards or hidden prerequisites. Each gate has an owner and a concrete trigger, viable approach, dependency set and proof required before converting it into a new bounded card. OLD-TASK-MIGRATION.md assigns every deferred old task a gate/reason. Gate review preserves assessed absence/unknowns and never changes product maturity from a declaration.

| Gate | Capability / trigger / approach | Prerequisites and graduation evidence |
|---|---|---|
| G-PTY | Interactive stdin/resize/screen/attach tasks cannot be served by SYNC/BACKGROUND; add Rust portable-pty/vt100 or consumed equivalent inside the native daemon | B20/B21/B22; actual awaiting-input task, resize/attach/cancel/restart, screen assertions and exact process owner; no prompt/tmux recipe counted as PTY |
| G-CLIENT | Demand for editor/desktop/mobile/generated-client workflow beyond working ACP clients | B17/B24/B28/B32; first existing-client conformance, then selected client's real approval/fs/custom-tool/session/cancel/install task. D43 mobile Noise/libsodium+Rust relay, D44 existing ACP adoption, D47 OpenTUI; no new Kotlin/Lua/Elisp/Zig authorship by default |
| G-DESKTOP | A concrete screen/app action needs native a11y/capture rather than browser CDP | B19/B20/B21/B28/B33; selected OS Rust API adapter, version/capabilities, image/UI provenance, app/owner choice, action acknowledgement, cancellation and actual host fixture. Current native a11y role is absent/stub |
| G-VOICE | A user workflow needs voice input/output with measurable task benefit | B19/B20/B28/B31; consumed whisper/VAD/TTS pipeline, actual audio/device/permission/cancel/resource proof and bounded task oracle. Provider audio metadata is not a working loop |
| G-ISOLATION | Untrusted guests/repositories, egress delegation or host-level provenance require a stronger selected boundary | B18–B22/B28/B29/B30; exact QuickJS/WIT/microVM/egress/secret-broker/syscall fixture and explicit unavailable modes, artifact/schema/effect identity. No heap snapshots or generic sandbox claims |
| G-ML | Correct dataset/feedback loop shows a specific offline-oracle/training/inference need | B09/B12–B14/B30/B31; paired held-out language/cost comparison plus rollback; TS tiny policy first, Python optional offline, Rust ORT or consumed llama-server, custom KV only measured demand |
| G-PERF | A recorded correct workload crosses an observed bottleneck or needs an absent kernel capability | B05/B20/B23–B27/B32 and affected correctness task; same workload/machine/config/versions, parity/failure/cold cases and before/after uncertainty. No port from extension/keyword counts or universal 10×/sub100ms goals |
| G-REMOTE | A concrete multi-machine/coediting workflow exceeds local lanes/ACP | B17/B22/B27/B34; SSH/ACP or existing CRDT transport with fenced owner/base/artifacts, conflict, disconnect/cancel/retry and installed client proof. No unowned remote work |
| G-LANGUAGE-DEPTH | A project needs an unwired analyzer/build/test/codemod/inlay/coverage tier | B05/B06/B19/B23–B27/B28; consume mature ecosystem tool, actual per-root/schema/ABI fixture, version/encoding/basis/cancel/error evidence and declared unavailable state. New authored language needs dated net-benefit decision |
| G-PROVIDER | A configured gateway lacks a required vendor protocol/setting/accounting feature | B08/B09/B28/B30/B32; explicit native Gemini/specialized-adapter capability case and real configured-adapter conformance/usage/error/cancel fixture. Current gateway Gemini remains usable; an unconsumed specialized adapter is not default accounting |

## Pre-mortem — three plausible failures

1. **The plan repairs helpers but still publishes false successful tasks.** Generator error, rollback conflict, MCP failure or a missing diagnostic crosses an untested client/evaluator projection. Mitigation: B02/B03/B28/B30/B36 keep separate action/run/task/observation oracles; fatal and failed-action→recovery controls use actual consumers; V rejects helper-only credit. Stop any negative fixture labeled completed/confirmed/scored/diagnostic_delta_passed without its evidence.
2. **A crash or timeout causes foreign overwrite, duplicate external work or a hidden living process.** Provisional locks, sequential partial commits or stale TS/native epochs are mistaken for authority. Mitigation: B04 safety, B06/B07 guarded sequential recovery, B15/B16 recorded replay, B20 real cleanup and M22-* quiescence/import/cutover gates. Kill before/during/after import and native commit with old/new clients, held children, daemon outage and stale-TS rollback attempts. Stop stale admitted ticket success, silent fallback, false whole-intent atomicity, replayed uncertainty or covered living work after a hard limit; preserve conflicts/cleanup and continue independent ready work.
3. **Polyglot/learning expansion hides regressions and consumes the delivery budget.** More grammars/ports, statistically invalid scores, unavailable tools or candidate training are labeled quality gains. Mitigation: B23–B27 actual assets/toolchains/consumer contracts, B30/B31 complete paired strata and rollback, B32 equivalent correct baseline, conditional gates for ML/clients/kernels. Trigger/stop: packed/real-tool cells are skipped, lower scores/cost failures disappear, or a new language lacks a capability/measurement case. Keep baseline behavior and report insufficient evidence.

## Expanded verification plan

| Layer | Required discriminating work | Evidence and limits |
|---|---|---|
| Unit/property | Outcome state transitions; exact bytes/positions/basis; opaque IDs/schema constraints; finite stats; policy compound actions; version/generation/retention invariants | Required positive and adverse controls in affected existing modules; property/differential corpus only where it distinguishes real ambiguity. Helper passes never certify full feature |
| Offline integration | Real configured HTTP/SSE transport with injected responses; SQLite next-turn/reopen; actual SDK/runtime/CLI/child projection; broker interleavings; MCP schema/origin/result/RPC; strict LSP peer | No keys/model/network required; emit durable IDs/result/usage/artifact receipts. Observe current source/config; do not reuse private logs or shared lessons |
| Process/filesystem integration | Four effect crashes, TERM-resistant descendants, concurrent CAS/leases/snapshots, real socket restart, sequential refactor partial effects; mixed backend/epoch/client import/cutover/outage/rollback and held child | Observed cleanup and finite grace; still-alive fails hard limits. M22-* accepts exact scope only; unaware/external writers remain observed basis/conflict boundary |
| Installed/native | Tarball-only Node CJS/ESM/Bun SDK; installed CLI parser/query/edit/validate/cancel/browser/media; actual executable Rust exec/daemon; selected platform/toolchain cells | Checkout inaccessible, no forced checkout paths; checksums/modes/versions/assets/jobs recorded. Missing native/server/Blender/client cannot be filled by mocks |
| Target-language e2e | JSON-schema TS/Rust/Python contract and C/Python ABI; declaration/consumer/resource refactor; unknown generic control; owning builds/tests; actual real-server cells | Required producers/consumers/toolchains/encodings and joined hashes; unavailable or incomplete coverage prevents whole-task acceptance |
| Long-session/evaluation e2e | Three compactions/fresh process/retention cutoff; useful task-A fact at task-B decision; canonical reconnect; full attempt populations; candidate/no-promotion/promotion/rollback | Independent factual/negation/task oracles, complete paid/failure data, held-out split and predeclared uncertainty. No live/model quality gain claimed until that evidence exists |
| Observability | Action/run/task/owner/attempt/basis/generation/usage/admission/limit/enforcement/cleanup/retention, backend/epoch/import phase/milestone and protocol fields; corruption/unavailable/empty distinct | Inspectable scoped machine receipts; no B22 rollup on baseline boot. Local opt-in telemetry/bounded storage; OTel/Parquet/DuckDB are conditional |
| Regression/performance | Existing package tests appropriate to each change; actual correct cold/warm/read/query/parse/render/cancel/restart workload with baseline/config lock | Broaden tests only for new changes/failures/unresolved concern. Structural completion is not latency; record repeats/noise/failure costs rather than invent targets |

Unit/DI fixtures are always key-free. Installed/real-tool tests add explicit assurance; they do not retrospectively increase this review's assurance. Model task-quality experiments need the locked BYOK/provider/budget setup, and untrusted evaluation tasks need a selected actual isolation boundary or a truthful weaker trusted mode. Core source changes do not start in this planning deliverable.

## Portable bootstrap and proposed runner invocations

These files and command-line contracts are **proposed implementation resources to create**, not existing tests claimed executed. Q/C owns `scripts/body-bootstrap.ts` and `test/fixtures/body/{toolchain-manifest.json,.mise.toml}` as a small independent B32 intake deliverable; other owners create their named runners. Immediate B02/B03/B04/B36 unit/DI work needs only the actual pinned Bun and its local dependencies, not acceptance of the full bootstrap or any native/language matrix.

Before selected-tool acceptance, freeze manifest schema 1 containing actual executable paths/versions/checksums, package/lockfile/source hashes, platform/kernel capabilities, installed SDK/CLI/native artifacts and per-cell available/unavailable state. Preserve Bun 1.3.5 and reviewed Rust 1.87.0 unless a dated compatible toolchain change is explicitly selected. New rusqlite/OS dependencies are first declared with compatible pinned versions and an updated reviewed Cargo.lock; only then can locked/offline proof run. Node minimum comes from the SDK manifest; selected LSP/Chrome/Blender/C/Python versions come from the committed fixture manifest, never an invented installed version.

The acquisition phase may use these concrete commands under the later execution's authorized dependency/network scope, with command/exit/artifact receipts. It does not count as offline or native capability evidence:

```sh
rustup toolchain install 1.87.0 --profile minimal
cargo generate-lockfile --manifest-path rust/Cargo.toml
cargo fetch --manifest-path rust/Cargo.toml --locked
```

Generate-lockfile applies only when introducing reviewed dependency changes; ordinary verification uses the existing lock. For manifest-selected extra tools, run `mise install` from the proposed `test/fixtures/body/` directory; package install/build actions are pinned in the same manifest. If Bun 1.3.5 is absent, resolve it through the environment's authorized installer or `bunx --bun bun@1.3.5 --version`, record the resulting actual executable path and set BODY_BUN to it. Acquisition failure leaves that cell unavailable and does not silently run a mismatched Bun or download another version during offline tests.

After the helper exists, resolve/check selected cells explicitly:

```sh
"$BODY_BUN" run scripts/body-bootstrap.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --require bun --evidence-dir "$BODY_EVIDENCE/bootstrap"
"$BODY_BUN" run scripts/body-bootstrap.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --require bun,rust,native-linux --evidence-dir "$BODY_EVIDENCE/B21/bootstrap"
```

The first invocation verifies key-free TS inputs. The second verifies already acquired native cells; other cards select only their manifest-required tools. The helper never invents successful availability or changes authority selection. Real server/Chrome/Blender/target-language and installed cells are recorded separately from source/DI cells. Python is absent for authored A; target B/C and optional offline oracles have explicit Python tool requirements.

Every runner writes `receipt.json` and its artifact/test manifest to the explicit evidence directory, accepts the same `--manifest` argument, propagates exported BODY_EVIDENCE to children, and records actual subordinate commands/versions/exits. M22 receipts live under B22/M22-* and name that milestone, not an accepted B22 rollup. Native artifact paths below are concrete build outputs from B21/B22, while SDK/CLI install paths are resolved from the pinned manifest inside the packed runner. Selected unavailable tools fail positive-cell graduation and can still pass a separately labeled unavailable-state control.

| Owner/card | Proposed runner and concrete invocation |
|---|---|
| E/B06 | `"$BODY_BUN" run test/fixtures/body/workspace-edit-sequential.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --evidence-dir "$BODY_EVIDENCE/B06"` |
| M/U/B13 | `"$BODY_BUN" run test/fixtures/body/memory-restart.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --evidence-dir "$BODY_EVIDENCE/B13"` |
| R/C/B15 | `"$BODY_BUN" run test/fixtures/body/effect-crash.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --evidence-dir "$BODY_EVIDENCE/B15/effects"` |
| R/T/B15/B29 | `"$BODY_BUN" run test/fixtures/body/replay-prefix.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --evidence-dir "$BODY_EVIDENCE/B15/replay"` |
| X/C/B21 | `"$BODY_BUN" run test/fixtures/body/ts-rust-boundary/verify.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B21/rust-target/debug/openbuff-native" --without-python --evidence-dir "$BODY_EVIDENCE/B21"` |
| X/C/M22-CORE | `"$BODY_BUN" run test/fixtures/body/daemon-two-client.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B22/rust-target/debug/openbuff-native" --milestone M22-CORE --evidence-dir "$BODY_EVIDENCE/B22/M22-CORE"` |
| E/X/M22-TXN | `"$BODY_BUN" run test/fixtures/body/daemon-two-client.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B22/rust-target/debug/openbuff-native" --milestone M22-TXN --prerequisite-receipts "$BODY_EVIDENCE/B05/receipt.json,$BODY_EVIDENCE/B07/receipt.json,$BODY_EVIDENCE/B22/M22-CORE/receipt.json" --evidence-dir "$BODY_EVIDENCE/B22/M22-TXN"` |
| R/X/M22-CHILD | `"$BODY_BUN" run test/fixtures/body/daemon-two-client.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B22/rust-target/debug/openbuff-native" --milestone M22-CHILD --prerequisite-receipts "$BODY_EVIDENCE/B16/receipt.json,$BODY_EVIDENCE/B22/M22-TXN/receipt.json" --evidence-dir "$BODY_EVIDENCE/B22/M22-CHILD"` |
| C/B22 rollup | `"$BODY_BUN" run test/fixtures/body/daemon-two-client.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B22/rust-target/debug/openbuff-native" --milestone B22 --prerequisite-receipts "$BODY_EVIDENCE/B22/M22-CORE/receipt.json,$BODY_EVIDENCE/B22/M22-TXN/receipt.json,$BODY_EVIDENCE/B22/M22-CHILD/receipt.json" --evidence-dir "$BODY_EVIDENCE/B22/rollup"` |
| L/Q/B24 | `"$BODY_BUN" run test/fixtures/body/packed-language-assets.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --build-and-pack --checkout-unavailable --evidence-dir "$BODY_EVIDENCE/B24"` |
| L/C/B27 schema | `"$BODY_BUN" run test/fixtures/polyglot/order-contract/verify.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --scenario schema-v2 --evidence-dir "$BODY_EVIDENCE/B27/order-contract"` |
| L/C/B27 ABI | `"$BODY_BUN" run test/fixtures/polyglot/c-python-abi/verify.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --scenario abi-v2 --evidence-dir "$BODY_EVIDENCE/B27/c-python-abi"` |
| L/C/B27 generic | `"$BODY_BUN" run test/fixtures/polyglot/unknown-generic/verify.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --evidence-dir "$BODY_EVIDENCE/B27/unknown-generic"` |
| T/C/B29 | `"$BODY_BUN" run test/fixtures/body/trusted-bundle.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --include-custom-strategy-choice --evidence-dir "$BODY_EVIDENCE/B29"` |
| Q/B30 | `"$BODY_BUN" run test/fixtures/body/evaluation-artifacts.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --isolated-sinks --evidence-dir "$BODY_EVIDENCE/B30"` |
| Q/M/B31 plumbing | `"$BODY_BUN" run test/fixtures/body/candidate-promotion.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --mode plumbing --evidence-dir "$BODY_EVIDENCE/B31/plumbing"` |
| Q/M/B31 real trial | `"$BODY_BUN" run test/fixtures/body/candidate-promotion.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --mode byok --experiment "$BODY_EVIDENCE/B31/experiment.json" --evidence-dir "$BODY_EVIDENCE/B31/held-out"` |
| U/X/B33 | `"$BODY_BUN" run test/fixtures/body/local-browser.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --local-fixture-only --evidence-dir "$BODY_EVIDENCE/B33"` |
| R/X/B34 | `"$BODY_BUN" run test/fixtures/body/two-lane-work.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --native-binary "$BODY_EVIDENCE/B22/rust-target/debug/openbuff-native" --evidence-dir "$BODY_EVIDENCE/B34"` |
| E/X/B35 | `"$BODY_BUN" run test/fixtures/body/3d-render-basis.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --scenario inspect-preview-edit-failure --evidence-dir "$BODY_EVIDENCE/B35"` |
| L/C/B36 | `"$BODY_BUN" run test/fixtures/body/diagnostic-outcomes.ts --manifest "$BODY_TOOLCHAIN_MANIFEST" --key-free --evidence-dir "$BODY_EVIDENCE/B36"` |

The target runners create their documented fixture files/build targets, then execute actual `cargo test --manifest-path test/fixtures/polyglot/order-contract/rust/Cargo.toml --locked --offline`, manifest-selected TS checks and `python3 -m unittest discover -s test/fixtures/polyglot/order-contract/python/tests`. The Linux C/Python fixture creates codec.h/codec.c and its ctypes tests, runs `cc -shared -fPIC test/fixtures/polyglot/c-python-abi/codec.c -o "$BODY_EVIDENCE/B27/c-python-abi/libfixture.so"`, then `python3 -m unittest discover -s test/fixtures/polyglot/c-python-abi/tests`. Runners resolve actual manifest executables/flags and keep subordinate commands. Other platforms remain separate declared cells. Python never belongs to authored A. Installed runners execute actual packed artifacts, not source-copy or marker-only replacements.

## Staffing and future execution hints

The known catalog advertises default, worker/executor, explorer/explore, planner, architect, critic, system-architect/backend-architect/frontend-architect, requirements-analyst, security-engineer, test-engineer/quality-engineer, verifier/code-reviewer and writer/technical-writer roles. Use only currently callable roles. Fixed planner/architect/critic model configurations were unavailable in this review surface, so native inherited-model agents supply those dedicated responsibilities; this is a role adaptation, not a claim that the unavailable configuration ran. No model override is inferred from a role name.

Current limit: leader plus three child slots. Initial allocation: R/B02, E/B03, E/L/B04, with C integrating contracts. Rotate a freed lane to independently ready B36, then B30, and rotate V within the same four slots. Suggested effort: high for runtime/bytes/ownership/native/verification; medium-to-high for provider/client/schema; low-to-medium for bounded discovery. Shared `sdk/src/run.ts` and schemas stay leader-owned/serialized. Reserve native work after B19/B20/full B21; M22-CORE follows directly while other lanes complete B05/B07/B16 for the later native milestones. Full B22 needs all three, so no partial boot is a completed ownership migration.

**Default durable follow-up:** after an explicitly requested execution handoff, use `$ultragoal` with canonical PLAN.md, this roster, ready queue, evidence/stop contracts and OLD-TASK-MIGRATION.md. The leader owns one durable goal/ledger; workers return checkpoint-ready evidence and never mutate goal state. Parallel durable delivery is **Team + Ultragoal** only when the user selects/starts the tmux runtime. On the current Codex/native outside-tmux surface, stay with bounded native collaboration; `$team`/`omx team` cannot be launched directly here. No goal or Team is started by this document.

Future app-safe intent hint: `$ultragoal execute .agents/sessions/body-capability-review-2026-11-05/PLAN.md; begin B02/B03/B04, preserve all user edits, leader owns ledger and shared contracts, rotate independent verifier.` It is a request form, not a shell command or automatic launch.

If the user deliberately moves to an attached OMX CLI/tmux session, the conditional Team launch hint is:

```sh
omx team 3:executor "Execute .agents/sessions/body-capability-review-2026-11-05/PLAN.md: B02 runtime, B03 mutation evidence, B04 CAS; leader owns shared contracts; rotate one worker to independent verification; return per-task receipts before checkpoint."
```

Equivalent selected skill hint: `$team 3:executor "Execute the canonical body PLAN with the same three lanes and independent verification rotation"`. Team preconditions, real pane/ACK/task-state evidence and shutdown lifecycle follow the Team skill; native subagents are not relabeled durable tmux workers.

**Team verification path:** before shutdown, each task has a scoped diff/commit, concrete positive/adverse tests, actual required installed/native/client proof, owned resource cleanup and evidence receipt. Leader independently checks current hashes/dependencies, unresolved failures and task state; no active worker is shut down as complete. Ultragoal uses a fresh leader goal snapshot to checkpoint only terminal accepted task evidence, preserving uncertainty/recovery-required state. Task success never comes from stdout prose or a historical checkbox. No broad `git add -A` is needed in the shared checkout; scope commits to owned files and preserve user changes.

`$performance-goal` is appropriate only for a later G-PERF workload with its locked evaluator/baseline; `$autoresearch-goal` only for an explicitly selected G-ML/offline research deliverable with a validator. Neither becomes a required architecture component. A separate `$ralph` fallback is reserved for an explicitly selected persistent single-owner verification/fix lane; it is not the default follow-up.

## ADR — proposed for independent review

**Decision:** retain TS/Bun model coordination and immediate truth/data/diagnostic repairs; integrate the one-shot Rust exec adapter then M22-CORE's minimal rusqlite authority. Stage corrected transaction import at M22-TXN after B05/B07, child production migration at M22-CHILD after B16/transaction gate, and accept B22 only on their rollup. Consume ecosystem tools, keep optional offline Python and publish one canonical source-bound plan with complete historical dispositions/assurance.

**Drivers:** data/identity/result correctness; broad everyday task coverage and meaningful recovery/memory; verified consumer/install paths and controlled integration cost within four slots.

**Alternatives considered:** A incremental repaired authorities with early native slices; B earlier parallel native ownership before deeper client/memory/language integration. B has a credible ownership/lifetime advantage and remains selectable when the workload justifies its reduced immediate TS throughput. Whole-loop native rewrite and permanent TS authoritative-daemon substitution lack a current benefit case or conflict with latest decisions; they require a dated revision rather than silent adoption.

**Why chosen:** the audits identify directly repairable producer/consumer losses in existing TS (`run-programmatic-step.ts:749`, `language-intelligence.ts:350`, `memory-v2/coordinator.ts:1173`, `mcp/client.ts:862`) and an actual standalone Rust Linux enforcement capability with an incompatible/unwired adapter (pair 09). Correct semantics are needed regardless of language; OS ownership is a concrete Rust capability. A short ready queue yields useful fixes while native adoption/store authority grows from tested boundaries.

**Consequences:** fail-closed TS safety can strand unknown owners; native liveness needs verified OS ownership and a single participating backend/epoch. Native outage never silently enables TS writes, and this baseline refuses stale-TS rollback after activation. Unaware/full-access external writers remain a captured-basis/conflict boundary. Complete preflight is zero-write refusal; successful multi-file commits are guarded/sequential, with partial/recovery state on failure. Replay supports verified recorded prefixes, not arbitrary heaps; strict capped unknown-cost admission refuses without a justified reservation. Full B19/B20/B21 work still constrains when the early baseline can start. D29–D56 precedence remains, including D48/D49/D50/D51/D52/D53/D54 and reverified D56.

**Follow-ups:** subsequent dedicated Architect then independent Critic review of this revision; validate all 39 completion nodes/milestone receipts/migration links. Future execution is separately requested through its surface. G-PTY/G-CLIENT/G-DESKTOP/G-VOICE/G-ISOLATION/G-ML/G-PERF/G-REMOTE/G-LANGUAGE-DEPTH/G-PROVIDER require recorded demand and bounded acceptance before new cards.

## Review-deliverable gate and improvements log

Delivery requires all thirteen durable pair reports/current digests; current every-directory dispositions; original capability/finding identities, strengths, gaps and source-snapshot limits; one explicit row for each of 120 old tasks; complete card/graph/ready-queue/command/evidence checks; independent review with resolutions; safe data-only evidence staging and scoped publication. Do not equate this artifact gate with repaired product readiness or live learning/performance gains. Parent publication preserves the historical plan and user/source edits.

The original requirement-review corrections remain: independent outcomes/recovery; hard-limit living-descendant failure; adapter-specific uncertain-effect stop; finite coverage/retention/measurement; independent language proofs; held-out/power/strata/rollback; immediate TS work; safe evaluator; historical dispositions; source/inspection/readiness distinction; separate browser/media and 3D repairs. Revision 2 adds one diagnostic card and three exact native milestones. Applied draft changes are recorded below; independent approval remains pending.

| Feedback | Exact draft change / check | Status |
|---|---|---|
| ARCH-1 + CRIT-1 | B22 protocol: one repository backend/epoch and SessionAuthority issuer; enumerated participating adapters; leases/fenced admission; quiescence/import/activation; version-1/skew/outage refusal; no native→TS fallback; pre-activation abandonment versus post-activation downgrade refusal; unaware/external boundary; real mixed-client/four-crash matrix | Applied to draft; re-review required |
| ARCH-2 + CRIT-2, native prerequisite gap | M22-CORE/TXN/CHILD graph/ledger; B05/B07 required for transaction import, B16 and transaction milestone for child commits; B22 requires all three; exact migration references and populated imports | Applied; mechanically validate node prerequisites/rollup |
| ARCH-2 + CRIT-2, atomicity gap | B06 depends on B04/B07 and enumerates TextDocumentEdit/resource/options/annotations/encoding/conflicts; zero-write complete preflight, guarded sequential success and partial/recovery failure; SPEC R3 corrected | Applied; no universal all-file atomicity claim |
| CRIT-3 | B36 has no prerequisites and original 07-F7 lineage; actual delta→hook→SDK/client failure/coverage controls; B27 consumes it later; R1/R6/R8 and old task mappings updated; 36 cards/39 nodes | Applied; ready-queue/lineage checks required |
| ARCH bounded 1 + CRIT clarification 2 | B15/B29/SPEC state recorded-prefix/immutable inputs and reconstruction manifest; changed bundle, missing prefix, mutable/unrecorded state refuses automatic continuation; arbitrary trusted full access still executes, no universal JS detection/heap promise | Applied; paired positive/refusal fixture specified |
| ARCH bounded 2 + CRIT clarification 3 | Real custom-strategy full-access, required-unavailable profile and explicit route-over-recommendation controls in B19/B29/B31; host statechart remains lifecycle | Applied; current user choices preserved |
| ARCH bounded 3 + CRIT clarification 1 | B08 predeclared finite attempt/delay/cancel fixture; B09/SPEC strict/estimated/uncapped reservation policy and failure/late-usage/concurrent-child/restart controls; unknowns never reset spend | Applied; no exact remote-billing claim |
| ARCH bounded 4 + CRIT learning clarification | B31 labels plumbing versus empirical held-out evidence and full-card prerequisites; retains complete costs/strata/power/rollback and optional offline Python | Applied; no synthetic gain claim |
| ARCH bounded 5 + CRIT clarification 4 | Portable actual Bun resolution; exported evidence/manifest; selected locked dependency/tool acquisition separate from offline proof; concrete build/smoke/new-runner arguments and receipts | Applied; existing/new/optional paths remain distinct |
| ARCH bounded 5 + CRIT clarification 5 | SPEC uses G-PTY rather than B35; ADR includes G-PROVIDER; authored A remains no-Python and target B/C has explicit Python tooling | Applied; cross-reference check required |
| ARCH synthesis / CRIT scheduling | Retain A immediate truth plus B bounded ownership benefit; state fail-closed liveness and full B19/B20/B21 scheduling cost; accept only exact milestone scope, never partial B22 | Applied; subsequent reviewers decide adequacy |

Mechanical validation reports document structure/dependencies/lineage and path metadata only. It does not execute unsafe lesson tests or implementation acceptance, approve this revision or prove native/installed/live quality.
