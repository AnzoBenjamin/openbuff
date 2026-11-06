# Independent first-wave candidate consistency review

Decision: **approve for this exact candidate's evidence consistency only**. Reviewer: `/root/b04_lock_cas`; candidate assembler owner: `/root`.

Candidate: `docs/execution/body-roadmap/evidence/integration/first-wave-final-20261107/acceptance/candidate-ledger.json`, SHA-256 `108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758`.

The unchanged validator, SHA-256 `6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c`, independently exits zero with `valid: true` and no errors. The candidate records exactly **B01, B02, B03, B04, B08, B18, B30 and B36 accepted; 31 nodes remain pending**. This review neither updates the live ledger nor accepts additional cards.

## Evidence and authority checked

The independent inspection follows the actual candidate, its assembly inputs, acceptance receipts/manifests, typed reviews, original independent approvals, every credited command's original argv/exit/log selection, and every selected behavior artifact's original approval seal. It also compares current source/configuration hashes, retained scope limits and prerequisite identity. It does not execute the assembler, rerun product tests, or reinterpret historical artifact internals as fresh authority.

| Card | Independent implementation authority retained | Declared source/contract bindings | Command credits | Behavior references |
|---|---|---:|---:|---:|
| B01 | b03 main scope; b04 historical tail/store subset | 30 | 11 | 5 |
| B02 | b03, including the b04 event-bridge cleanup | 57 | 10 | 4 |
| B03 | b02 post-build review | 83 | 6 | 4 |
| B04 | b02 final countersignature | 24 | 2 | 2 |
| B08 | b03 typed independent review | 64 | 6 | 3 |
| B18 | b02 post-route countersignature | 52 | 8 | 3 |
| B30 | b02 post-build review | 62 | 8 | 4 |
| B36 | b03 workspace-typecheck refresh | 15 | 3 | 3 |

Across those rows there are **246 distinct declared source/contract identities, nine reviews, 54 command credits, 53 original invocations and 28 behavior references**. The shared final workspace typecheck is credited by B01 and B36; it remains one original invocation. The inspection verifies **2,543 active source/evidence files** without observed drift. Full identities, original provenance selections and per-card limits are in `inspection.json`; the executed inspection and frozen-validator commands have separate receipts/logs.

The current typed reviews and their original approvals agree on node, reviewer, implementation owners, scope, decision, source contracts and command credit. Every reviewer is outside that review's declared implementation owners. No required rerun is left outstanding in those original approvals. Every selected behavior reference is sealed by an original independent approval, and every reviewed command appears exactly once per card's acceptance checks. Old failed runs, stale internal legacy seals and narrower earlier scopes remain historical context rather than silently receiving new command or prerequisite credit.

## Graph and assembly controls

The graph matches the single frozen PLAN all-of graph: 36 cards and three explicit B22 milestone nodes. All eight accepted nodes have no prerequisites in that graph. All 31 pending node objects are unchanged from the live ledger. The candidate's non-node differences are the assembler's timestamp and explicit migration of `evidenceDirectory` from the old temporary path to repository evidence.

Ready nodes are B05, B09, B10, B11, B12, B15, B19, B23, B28 and B32. In particular, accepted B02/B18 make B19 ready. B20 still requires B19, B21 still requires B19/B20, and B22 still requires M22-CORE, M22-TXN and M22-CHILD. Readiness is not implementation authorization or acceptance.

Four controls against in-memory copies of the actual candidate pass:

1. `require_complete` rejects the partial candidate with outstanding nodes.
2. Starting B20 while B19 is pending rejects.
3. Accepting B22 while its milestone prerequisites are pending rejects.
4. Rebinding a B04 accepted source digest rejects.

The initial inspection harness incorrectly required the old and candidate `evidenceDirectory` to be identical. Its failed expectation and exact script are preserved in `initial-harness-observation.json` and `inspect-candidate.initial.py`. The corrected inspection requires the exact repository evidence path documented by the assembler. This was a review-harness assumption, not a product or validator defect; no candidate field was edited.

## Supporting integration context

`integration-context.json` separately verifies the recorded CLI 4,436/0, agents 1,284/0, all 11 workspace typecheck exits zero, and five installed-binary probes with expected markers. Their logs and stable post-build source maps match. The actual installed binary still hashes to `5597a243d8676c345ba7cece90565705adb2a384d621436482084937a42d6241`.

The successful build truthfully records `sourceUnchangedDuringCommand: false` because it generates source/assets; that fact remains visible. It is supporting build context, not a stable-source acceptance command. Installed probes and these broad checks do not accept B32, native execution, unavailable platforms, full process cleanup, or any additional capability tier. No product command was rerun by this reviewer.

## Independence and limits

This reviewer authored B04 implementation, B36 implementation, the two-line event-bridge cleanup and the 3D test timeout adjustment. This review grants **no independent implementation approval** to those changes: it inspects the other reviewers' current authority and bindings. The historical B01 tail/store approval was genuinely authored by this reviewer and remains limited to that original subset; checking its unchanged identity here does not enlarge it. The 3D test appears in current command-input maps, but its presence does not create B19/B35 or new implementation acceptance.

This is a bounded review of recorded evidence consistency. It is not cryptographic identity attestation, independent reexecution of every behavioral oracle, blanket product approval, OS enforcement, universal JavaScript confinement, remote-provider assurance, or completion of the roadmap. The original typed implementation reviewers remain the authority for their declared tiers. The live ledger, historical candidate, new candidate, validator, assembler, PLAN, SPEC and inspected evidence remain unchanged at the final seal.
