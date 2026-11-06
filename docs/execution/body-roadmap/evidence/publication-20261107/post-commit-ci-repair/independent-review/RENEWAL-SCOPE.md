# Minimum evidence renewal for the memory-drift guard repair

The proposed edit changes `scripts/memory-drift-guard.ts` and its test. Neither path belongs to any accepted node's `sourceContractHashes`. Both are effective current inputs of the B01 and B36 workspace-typecheck commands: the frozen validator checks their original and normalized before/after maps against current files.

The independent read-only analysis examined all 54 active accepted command receipts, including the validator's original/provenance-map selection. Exactly two command envelopes are affected, both referring to the same actual root typecheck and its exact 182-input maps:

- `evidence/B01/workspace-typecheck-refresh-20261107/command-workspace-typecheck.json`.
- `evidence/B36/workspace-typecheck-refresh-20261107/command-workspace-typecheck.json`.

Older broad B36 maps remain historical artifact bytes. They require preservation, not rewritten hashes. The active scoped B36 commands do not have either guard path in their effective original maps.

The minimum renewal is one actual root typecheck with a new raw receipt, log and stable exact before/after inputs; two new node-specific normalized command envelopes; new B01-main and B36 independent approval/review envelopes replacing only that shared command credit; and new B01/B36 acceptance manifests and receipts, with corresponding live ledger references. The existing implementation source contracts, scopes, six B01 scoped commands, B01 tail/store review, and two B36 scoped commands remain eligible unchanged. All eight accepted nodes have empty prerequisite lists, so there is no prerequisite-receipt cascade.

The B03 reviewer is the existing independent authority for both affected main review envelopes. This analysis does not grant B36 implementation approval from a B36 implementation owner. It also does not permit replacing a historical command's inputs with new hashes, appending a new command while continuing stale command credit, or changing the frozen validator.

The separate incidental `.agents/types/tools.ts` generator delta is not needed for this repair. Its HEAD SHA-256 is `c4121c5fd085f6bf68aa312658a73e3d2d9d4009859ea72e0af73be447e7c53f`, which matches the accepted B01 behavior/parity/whitespace commands. Before root restored that delta, the read-only baseline returned 24 mismatches for that file; `initial-live-impact.json` records this transient, stable observation, not a failure caused by the guard edit. Restoring its committed reviewed bytes avoids six unrelated B01 command renewals.

The cli/sdk/common package knowledge files have no current frozen-validator bindings. Refreshing them does not itself require acceptance renewal. The frozen 2,644-file publication inventory remains a record of the earlier snapshot; a new publication verification must explicitly account for the changed guard/test and renewed ledger/evidence rather than claiming that every old current-source hash still matches. Neither existing restoration archive needs replacement because its selected payload bytes are unchanged.

Evidence: `effective-command-map-analysis.json` records the effective original maps of every active command; `initial-live-impact.json` and its raw logs record the initial read-only validator result. This analysis wrote only new review evidence and did not change source, ledger, receipts, validator or staging.
