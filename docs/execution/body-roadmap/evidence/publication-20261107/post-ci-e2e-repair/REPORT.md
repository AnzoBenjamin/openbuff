# Reviewer fixture CI repair

Changed exactly `agents/e2e/gate-aux-ordering.e2e.test.ts` and
`agents/e2e/gate-lifecycle.e2e.test.ts`, following root's explicit scope
confirmation and B04's read-only zero-current-binding result. No production
gate, shared schema, generated source, existing shared helper or ledger changed.

Synthetic reviewer payloads now supply all five assessments and a concrete
fixture file/snapshot requirement evidence row. Existing parent-owned gaps
retain their statuses and now explicitly carry parent-owned evidence. Typed
findings/verdicts and the existing substantive scenario assertions remain.
Blocking specialist assessments refer to the typed finding without creating
a duplicate dimension blocker. Deliberate coverage gaps remain deliberate.

The accepted final reviewer path calls collectReviewerAttestationIssues with
requireFullEvidence in base2.ts at lines 6375/6429. Its generated helper checks
exact fingerprint equality at line 9725; the source helper does so too.
gate-reviewer.test.ts explicitly rejects complete but obsolete same-path
fingerprints. B01 independent-main-review/README.md describes ordinary full
evidence, current-versus-obsolete basis and blocked foreign-basis specialist
controls. Older drift-tolerated comments are not the current executable rule.

After evidence defaults, two failures remained. The lifecycle case now proves
that a stale fingerprint gets exactly one reviewer-only retry, with pending
files, zero receipts and no gate credit. A corrected matching response then
passes the original finalization assertions and mints one current receipt;
rejected drift receives no tolerated-drift telemetry. The false-attested batch
case now supplies the required evidence refresh/performance-only retry, leaves
that sibling unattested, and preserves all original assertions that only the
valid reliability finding enters the repair handoff/open finding set.

Pinned Bun 1.3.5 controls are retained with original source-before/after maps,
replacement environments, owned empty home/XDG/TMP, empty provider config and
disabled env-file loading. Test preload observations report zero fetches.

- Before: 19 pass, 13 fail, 647 assertions across two exact source files.
- After evidence defaults: 30 pass, 2 fail, 761 assertions; original images kept.
- After protocol sequencing: 32 pass, 0 fail, 787 assertions.
- Final formatted source: 32 pass, 0 fail, 787 assertions; agents typecheck exit 0.
- Final formatting and scoped git diff whitespace checks pass.

The initial formatting check warned only for the aux fixture. Its output and
pre-format images are preserved; only that allowed file was formatted. All
historical command maps/logs, failures and runners remain unmodified. Root's
push-capture.partial.log is explicitly incomplete and receives no authoritative
targeted command credit. The complete before-targeted log supplies that credit.
Root owns the full broader agents suite, publication and final staging.
