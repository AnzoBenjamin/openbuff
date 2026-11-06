# Independent CI-repair candidate consistency review

Approve exact candidate SHA-256 `64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b` for byte-preserving promotion over the still-unchanged live ledger `108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758`.

Reviewer: `/root/b04_lock_cas`. This decision verifies the evidence transition and binding consistency. It does not independently approve the reviewer's own implementation, grant new product behavior credit, or accept another card. B01-main and B36 implementation renewal authority remains `/root/b03_mutation_evidence`.

The frozen validator independently exited 0 with `valid: true`, no errors, exactly eight accepted nodes and 31 remaining. Its bytes match SHA-256 `6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c`. The independent receipt is `review.json`, SHA-256 `9768f0726c1c5f36f922b337d7d08beb12970d95cc04b0c0f45b06e42b733649`.

The comparison verified:

- Only B01 and B36 changed, and only their `acceptanceReceipt`, `acceptedAt`, `evidenceManifest` and `verification` fields. The other 37 nodes are identical. Outside the node list, only `updatedAt` changed.
- Source contracts, statuses, prerequisites, implementation scope and behavior evidence are identical. The independent reviewers, implementation owners and scope strings are preserved.
- Exactly one workspace-typecheck command was replaced for each affected node. B01 retains ten scoped commands, including the four unchanged tail/store commands; its total remains eleven. B36 retains two scoped commands and totals three. The B03 review's B01-main credit remains seven commands; the separate B01 tail/store authority is unchanged.
- Both new normalized typecheck envelopes bind the same original actual invocation, exact log and exact stable 187-input before/after maps. All inputs match current bytes; the pinned executable matches its receipt; the log records all eleven workspace typechecks exiting 0.
- The recorded guard suite has 69 passes and zero failures. The repository memory-drift guard reports zero findings across twelve checkers. These command receipts and input hashes also match current bytes.
- All 374 independently bound sources, receipts, manifests, reviews, historical artifacts and logs remained stable during the review. The live ledger was not changed.

No original command input map was rewritten. Older typecheck receipts remain historical artifact bytes; they no longer receive the replaced current command credit. This review ran only the frozen candidate validator, not product commands.

The original 2,644-path inventory remains a historical snapshot. The subsequent checkout verification must explicitly bind the approved guard/test/ledger delta. This candidate approval does not itself assert a successful future materialization or publication.

Only new evidence in this review directory was written. Product source, live ledger, frozen receipts and Git staging were untouched.
