# Independent review of the publication memory-drift guard fix

Reviewer: `/root/b04_lock_cas`. Implementation owner: `/root`.

Approve the exact four-file exclusion and regression test. No actionable correctness finding remains in this small fix. This review does not approve B01/B36 implementation, renew their acceptance, approve package-knowledge content, or authorize changes to their frozen receipts.

The guard now excludes four exact repository-relative Markdown paths from its shared/direct traversal. The existing prefix exclusions are unchanged. The new rule does not exclude the enclosing RWEB directories or the active researcher roadmap. The remaining diff outside the new rule/test is formatting only.

Reviewed source identities:

- `scripts/memory-drift-guard.ts`: `546da641fa97462b7bfbf96d8483c40087f836841c4c84fc9c034e3828111e89`.
- `scripts/__tests__/memory-drift-guard.test.ts`: `a89cb63cfc91a36c4b416c60c7cb4344e5f86da180a7e99699755725fbf1071e`.

The root-recorded guard suite exited 0 with 69 passing tests, zero failures and 158 expectations. The actual receipt/log hashes, pinned Bun executable and all 187 before/after inputs were independently checked against current files. The negative output near the end of that log is an intentional test of Git lookup failure handling; the suite result is successful.

An independent probe created four archived-path fixtures and eight active neighboring, suffix and unrelated same-basename documents in an owned temporary directory. Four checkers were exercised both directly and through the shared snapshot. The committed guard failed the new exclusion expectation with exit 1; the repaired guard passed with exit 0. All active documents remained visible to the path, cross-file, broken-link and TODO checkers. This establishes both regression sensitivity and the bounded exclusion scope. `guard-fix-controls.json` preserves the exact observations and has SHA-256 `b0e137d999ed78706f87a08839b07234c1868d88cda8b13baafc176d0c00dae0`.

All four frozen RWEB snapshots still match their committed bytes. Reviewed guard/test bytes remained unchanged during the controls. No source, ledger, frozen receipt or Git staging was edited by this reviewer.

`RENEWAL-SCOPE.md` and `effective-command-map-analysis.json` describe the separate acceptance consequence: only B01 and B36's currently credited shared workspace-typecheck command has these guard files in its effective original inputs, among 54 active accepted command receipts. One fresh actual typecheck and new independent command/review/acceptance envelopes can renew that context. Existing wide historical maps must remain unchanged. That renewal is pending separate authority and is not granted by this guard approval.

The initial live-validation receipt records a transient unrelated generated-local-mirror mismatch before root restored its committed reviewed bytes. It is retained as history; it is not attributed to this guard repair or presented as the final ledger result.
