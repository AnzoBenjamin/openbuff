# Separate file-explorer binding scope

`agents/e2e/file-explorer.e2e.test.ts` has zero active binding calls in the previously sealed validator observation, no accepted `sourceContractHashes` membership, and no membership in the frozen 2,644-path publication inventory. The file still matches the observer's before/after hash, and the current ledger, validator and inventory match their inspected hashes. `scope.json` records those bindings and the exact derivation; no validator rerun or product test was needed for this extension.

A repair confined to this file therefore needs no accepted-evidence renewal or historical inventory override. This is permission to proceed within the existing binding constraints, not an implementation approval. The root-owned proposed explicit-model correction still requires its own semantic review and fresh test evidence.

The two-gate-fixture review is separately sealed one directory above. This scope extension does not alter that approval or the preserved negative broader-suite observation. No source, ledger, staging or sealed evidence was edited.
