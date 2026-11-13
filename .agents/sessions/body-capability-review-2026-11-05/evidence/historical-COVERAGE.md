# Coverage of the body review

Started2026-11-05; final source scope2026-11-06.

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

Every auditor considered all eight domains. The source/test/doc receipt union contains 555 files and 147,721 unique read-window lines; searches and located adjacent files are separately recorded in picks and source reports. No claim of every source line, live provider/model task quality, or every platform was made.

Supplemental current source outside the native inventory: cli/release/index.js, cli/release/package.json; selected public ACP dependency code. Full SHA256 hashes of inspected files are in INSPECTED-FILE-HASHES.json.

The native structural check has invalidReceipts=[] and uncoveredSubsystems=[]; 13 actual paired shards satisfy the minimum7. The feature gate remains false for heuristic records and cannot certify assessed absence; it also permits false completeness in probes. Actual capability maturity and assurance are in CAPABILITIES.md and source records.

See SCOPE.md for every filesystem top-level directory, including ignored/local/private/artifact directories and exclusion reasons. Private environment/provider values and historical raw logs were excluded; new diagnostic probes used owned temp fixtures.
