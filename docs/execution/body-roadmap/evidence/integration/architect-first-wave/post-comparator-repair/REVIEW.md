# Independent B30 finding resolution — integration remains pending

Reviewer `/root/first_wave_architect` independently inspected the six-file repair by `/root/b03_mutation_evidence`. All six final source hashes match `integration/evaluator-comparison-regression/settled-source-hashes.json`. The two demonstrated findings in the immutable parent `PROVISIONAL.md` are **resolved**. This closes those findings only; it is not final eight-card approval or ledger acceptance.

The independent original counterexample script was replayed in this new directory. Only its two relative import prefixes changed to account for the deeper directory; fixture values and actual selector/comparator calls are unchanged. `probe-adaptation.json` binds original and replay script hashes. Under pinned Bun 1.3.5 and a replacement environment:

| Original control | Current result |
|---|---|
| Healthy pair, two finite cost-1 attempts per side | Succeeds; two eligible pairs and total cost 2 per side |
| Explicit `error: ''`, with legacy absent runOutcome | Direct measured selector returns false; actual comparison reports zero eligible scores and rejects insufficient eligible pairs |
| Two individually finite `Number.MAX_VALUE` costs | Throws `Aggregate monetary cost must be finite`; no successful nonfinite/null cost population is emitted |

`replay-command.json` binds all six changed files, probe, lock/package context, command/environment/toolchain, timestamps, source stability, log and observations. All three independently checked expectations passed. The healthy two-pair comparison still reports insufficient statistical sample size; comparator success is not significance or promotion acceptance.

The implementation uses one execution-eligibility predicate in both measured-score and run-summary consumers. Absent/null errors remain compatible, while every present string, including empty, excludes execution. Measured zero/low scores remain valid. Synthetic all-judges-failed rows stay distinct from execution failures. One checked finite monetary sum now serves comparator totals and the named per-agent, agent-rollup, auxiliary, and unsettled-task totals in runBuffBench; average cost reuses its verified total. Permanent tests exercise actual consumers and retained paid/unknown attempts, including both comparison sides and all named aggregate paths. No broader runner accumulator or legacy comparison module claim is added.

The supplied final repair receipts verify 73/0 focused, 365/0 full evals and 367/0 full scripts tests, both package typechecks, six-file format and lint with zero errors. Each original invocation has stable 2,080-input before/after maps and a verified log. At inspection, those broad maps differ from current files only at the subsequently rebuilt `cli/src/agents/bundled-agents.generated.ts` and `sdk/dist/index.d.ts`. Their recorded past invocation remains valid history; it must not be represented as an entirely current broad map. The planned fresh contextual/card approvals remain necessary.

The real-Blender fixture correction was rechecked: only a comment and the existing 180-second integration case ceiling were added; production 3D code and assertions remain unchanged. All 27 SDK repair manifest references verify. The exact full SDK receipt reports 2,613 pass, zero fail, 11,868 assertions across 142 files at a stable recorded source state. Its broader map predates the subsequent B30 repair and generated rebuild, which the supporting inspection records explicitly. This does not graduate B35 or certify native/installed 3D behavior.

`review.json` and `supporting-evidence-inspection.json` preserve the binding and explicit limits. No production/test/validator/ledger or earlier evidence was changed by this reviewer. Final integration approval still awaits the current B30 authority, root typecheck, CLI build/install/CI evidence and the actual new candidate ledger validated under the reviewed strict gate. All original eight-card scope limits and deferred B15/B17/B22/OS/native/empirical risks remain unchanged.
