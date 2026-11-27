# Coverage of the body review

Started 2026-11-05; final source scope 2026-11-06. Counts below come from the restored structural receipts; source assurance and feature readiness are reported separately.

| Subsystem | Native files | Inspected receipt files | Shards | Disposition |
|---|---:|---:|---|---|
| .agents | 19 | 13 | 10-extensions | audited, bounded ranges |
| .bin | 1 | 0 |  | out of scope: local generated/helper binaries |
| . | 29 | 5 | 06-edits, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| .commandcode | 2 | 0 |  | out of scope: local preferences |
| .github | 16 | 7 | 04-memory, 07-languages, 09-execution, 11-evals-release | audited, bounded ranges |
| .vscode | 1 | 0 |  | out of scope: editor settings |
| agents-graveyard | 121 | 0 |  | out of scope: inactive archived templates |
| agents | 155 | 20 | 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| cli | 685 | 100 | 01-cli, 02-providers, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| common | 386 | 62 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| docs | 33 | 14 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| evals | 681 | 34 | 04-memory, 11-evals-release, 12-audit-docs | audited, bounded ranges |
| openbuff.d.example | 4 | 1 | 12-audit-docs | audited, bounded ranges |
| packages | 479 | 133 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| rust | 17 | 10 | 09-execution, 10-extensions, 13-perception | audited, bounded ranges |
| scripts | 107 | 12 | 05-durability, 10-extensions, 11-evals-release, 12-audit-docs | audited, bounded ranges |
| sdk | 319 | 142 | 02-providers, 03-orchestration, 04-memory, 05-durability, 06-edits, 07-languages, 08-indexer, 09-execution, 10-extensions, 11-evals-release, 12-audit-docs, 13-perception | audited, bounded ranges |
| test | 1 | 1 | 11-evals-release | audited, bounded ranges |

Every auditor considered all eight domains. The restored source/test/doc receipt union contains 555 files and 147,555 reconstructed unique read-window lines; searches and located adjacent files are separately recorded in picks and source reports. The historical validator recorded 147,721 lines. Its unresolved 166-line difference receives no current inspection credit. This is bounded inspection, with no claim of every source line, live provider/model task quality, or every platform.

Supplemental current source outside the native inventory: cli/release/index.js, cli/release/package.json; selected public ACP dependency code. [CURRENT-FILE-HASHES.json](CURRENT-FILE-HASHES.json) binds 558 present inventory and supplemental source paths. The original whole-byte hash map is unavailable; these fresh hashes do not certify historical equality. See [SOURCE-STABILITY.md](SOURCE-STABILITY.md) for the surviving source-window comparison.

The native structural check has invalidReceipts=[] and uncoveredSubsystems=[]; 13 actual paired shards satisfy the minimum seven. Its feature gate remains complete=false for heuristic records. The helper's assessed-absence and false-completeness counterexamples are retained in the audit; no feature is promoted by this structural coverage result. Actual capability maturity and assurance are in [CAPABILITIES.md](CAPABILITIES.md) and source records.

See SCOPE.md for every filesystem top-level directory, including ignored/local/private/artifact directories and exclusion reasons. Private environment/provider values and historical raw logs were excluded; new diagnostic probes used owned temp fixtures.

## Recovery assurance qualification

Recovered on 2026-11-06 from recorded coverage output and restored reports. Historical comparisons reported no source changes, but a fresh whole-file comparison to the missing original map cannot be performed. [SOURCE-STABILITY.json](SOURCE-STABILITY.json) preserves those historical observations and the distinct present-source binding. Original coverage output is retained in [historical-COVERAGE.md](evidence/historical-COVERAGE.md) and [historical-COVERAGE-RESULT.json](evidence/historical-COVERAGE-RESULT.json).

## Reconstructed coverage after recovery

The root validator mechanically checked 13 restored paired reports, 555 unique receipt files and 558 source/supplemental range-file paths. Their reconstructed union contains 147,555 unique read-window lines. The complete historical validation capture records 147,721 lines; its 166-line difference remains unresolved. The recovery retains both figures rather than padding ranges to reproduce the old total. Read-receipt provenance distinguishes recorded interval arguments from captured endpoints, and SOURCE-STABILITY.md records the narrower 173-file/258-window captured-line comparison.
