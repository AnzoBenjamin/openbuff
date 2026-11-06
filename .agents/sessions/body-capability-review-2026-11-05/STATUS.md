# Body capability review and replacement plan status

Updated 2026-11-06T06:59:40.187398+00:00. Recovery, source review and independent plan review are complete. Final artifact delivery is recorded separately from implementation acceptance. All implementation cards remain prospective.

| Deliverable or gate | State | Evidence |
|---|---|---|
| Macro capability review | Complete: 45 capabilities from 144 vertical records, with present/missing maturity and operation-level language coverage | [CAPABILITIES.md](CAPABILITIES.md), [CAPABILITY-RECORDS.json](CAPABILITY-RECORDS.json) |
| Micro implementation review | Complete: 118 findings across 13 paired audits and 555 source/test/doc receipt files | [AUDIT-REPORT.md](AUDIT-REPORT.md), [findings](findings) |
| Replacement plan and specification | 36 cards, 39 all-of completion nodes, explicit positive/adverse consumers and verification; independently APPROVED for planning | [PLAN.md](PLAN.md), [SPEC.md](SPEC.md) |
| Historical roadmap migration | Complete: 120 declarations mapped once; 58 historical checkmarks preserved without transferring readiness | [OLD-TASK-MIGRATION.md](OLD-TASK-MIGRATION.md), [OLD-TASK-INVENTORY.json](OLD-TASK-INVENTORY.json) |
| Dedicated Architect | APPROVED for planning architecture | [ARCHITECT-REVIEW.md](ARCHITECT-REVIEW.md), [review resolutions](REVIEW-RESOLUTIONS.md) |
| Independent Critic | APPROVED against the final frozen plan/spec hashes | [CRITIC-REVIEW.md](CRITIC-REVIEW.md), [review resolutions](REVIEW-RESOLUTIONS.md) |
| Mechanical graph, lineage and source-binding checks | Pass; no validator errors | [PLAN-VALIDATION.json](PLAN-VALIDATION.json), [REVIEW-VALIDATION.json](REVIEW-VALIDATION.json) |
| Structural coverage | Covered; 13 pairs exceed seven required; no invalid receipt or uncovered native subsystem | [COVERAGE-RESULT.json](COVERAGE-RESULT.json), [SCOPE.md](SCOPE.md) |
| Native feature readiness | complete=false retained; heuristic inventory cannot certify partial/absent capabilities | [COVERAGE-RESULT.json](COVERAGE-RESULT.json), [CAPABILITIES.md](CAPABILITIES.md) |
| Final delivery | Data-only package; actual file hashes and copied-byte publication state are recorded separately | [PUBLICATION-MANIFEST.json](PUBLICATION-MANIFEST.json), [evidence guide](evidence/README.md); publisher creates PUBLICATION-RECEIPT.json after verified copying |

## Coverage matrix

| Native subsystem | Inventory files | Inspected receipt files | Paired audits or exclusion |
|---|---:|---:|---|
| .agents | 19 | 13 | 10-extensions |
| .bin | 1 | 0 | Out of scope: Local helper/generated executables; their source and packaging are inspected. |
| . | 29 | 5 | 06-edits, 11-evals-release, 12-audit-docs, 13-perception |
| .commandcode | 2 | 0 | Out of scope: Local integration preferences, not shipped Openbuff product code. |
| .github | 16 | 7 | 04-memory, 07-languages, 09-execution, 11-evals-release |
| .vscode | 1 | 0 | Out of scope: Contributor editor settings. |
| agents-graveyard | 121 | 0 | Out of scope: Archived templates outside active workspace runtime; active loading is inspected. |
| agents | 155 | 20 | 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| cli | 685 | 100 | 01-cli, 02-providers, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| common | 386 | 62 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| docs | 33 | 14 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| evals | 681 | 34 | 04-memory, 11-evals-release, 12-audit-docs |
| openbuff.d.example | 4 | 1 | 12-audit-docs |
| packages | 479 | 133 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| rust | 17 | 10 | 09-execution, 10-extensions, 13-perception |
| scripts | 107 | 12 | 05-durability, 10-extensions, 11-evals-release, 12-audit-docs |
| sdk | 319 | 142 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception |
| test | 1 | 1 | 11-evals-release |

The table renders restored runtime structural receipts. All 30 current filesystem top-level directories have an explicit disposition in [SCOPE.md](SCOPE.md), including local/private/artifact directories omitted by the native inventory. All five active packages are assigned.

| Audit domain | Recorded inspection |
|---|---|
| Security | 13 of 13 paired audit receipts |
| Correctness | 13 of 13 paired audit receipts |
| State mutation | 13 of 13 paired audit receipts |
| Error handling | 13 of 13 paired audit receipts |
| Performance | 13 of 13 paired audit receipts |
| Dependency hygiene | 13 of 13 paired audit receipts |
| Test coverage | 13 of 13 paired audit receipts |
| API/ABI contracts | 13 of 13 paired audit receipts |

## Source and recovery assurance

Source HEAD is `e65c06c0ae783130998bd9ab18c8d35320e40ea8`; native snapshot is `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`. The recovered receipt union has 147,555 unique read-window lines. Historical output records 147,721; the unresolved 166-line difference receives no current credit. Searches, discovery, sampled inspection, source equality and installed/task readiness are separate claims.

The original 558-file whole-byte map is unavailable. Four historical unchanged comparisons survive. Recovered numbered output binds 258 matching windows across 173 files and 38,692 lines; CURRENT-FILE-HASHES.json is a fresh present-file baseline. It does not prove historical equality for uncaptured bytes. [SOURCE-STABILITY.md](SOURCE-STABILITY.md) and its [JSON record](SOURCE-STABILITY.json) retain these limits.

The 47 recovered evidence artifacts and 44 frozen audit artifacts pass their recorded hashes; separately recorded coverage/status/citation edits retain original provenance in [FINALIZATION-CHANGES.json](FINALIZATION-CHANGES.json). [AUDIT-RECOVERY-MANIFEST.json](AUDIT-RECOVERY-MANIFEST.json), [PLAN-RECOVERY-MANIFEST.json](PLAN-RECOVERY-MANIFEST.json) and [EVIDENCE-RECOVERY-MANIFEST.json](EVIDENCE-RECOVERY-MANIFEST.json) describe their recovery-time state, not later editorial publication state.

## Verification and first execution queue

Mechanical validation checks all 39 completion nodes, the three exact M22 milestones and all-three B22 rollup, every historical mapping, all 118 finding references, all 144 catalog lineage records and 97 existing test paths. Artifact hashes and current directory coverage also pass. No product acceptance suite was rerun during recovery/finalization.

Existing recorded observations include CLI help, 413 passing indexer tests, 28 passing audit/control-plane tests and 19 passing Rust tests. Parser discovery failures are preserved alongside explicit pinned-asset parsing controls. Surviving suite excerpts and complete diagnostic JSON are identified by provenance. A passing diagnostic can reproduce a current defect; it does not establish a repaired feature. See the [evidence guide](evidence/README.md).

Future execution starts independent B02 runtime-outcome, B03 confirmed-mutation and B04 ownership/CAS lanes, with leader-owned shared contracts; B36 diagnostic truth and B30 evaluator isolation are the first rotations. Native execution/authority, meaningful memory/continuation and joined language contracts follow their explicit prerequisites. The first queue is not blocked by a new language or a daemon.

Existing knowledge-file edits and the historical root-cause session remain preserved. No production fix, goal activation, commit, push or live-provider request is part of this deliverable. Live model gains, full installed/other-platform readiness, real Chrome/Blender tasks and killed live CLI continuation remain future acceptance obligations.
