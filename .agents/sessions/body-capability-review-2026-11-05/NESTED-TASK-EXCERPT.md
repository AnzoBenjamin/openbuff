# Nested old-task declarations

Source .agents/sessions/polyglot-roadmap-v2/PLAN.md; parent declarations remain in OLD-TASK-INVENTORY.json.

## P0-T7 (old PLAN line40)

41:   - [x] derive the language-family maps from the registry and parse `.c` with tree-sitter-c (LI-11) — shared getLanguageFamily committed 6da95613a; dedicated tree-sitter-c grammar routing (.c/.h) committed b30dcfd2d

42:   - [x] registry ToolSpec argv/transport (LI-13) — committed 6da95613a (optional LanguageToolSpec + getLanguageToolSpecs)

43:   - [x] MCP client name `openbuff` (S4) — committed ba6522502

44:   - [x] dedupe the MCP config merge (EXT-3) — committed 398a77a2c (shared processMcpConfigFile)

45:   - [x] move CLI `getDiffStats` off execSync (EV-6) — committed 398a77a2c (getDiffStatsAsync + AbortController)

46:   - [x] aggregate background-agent cost into the parent (ORCH-5) — committed 398a77a2c

47:   - [x] rename sandbox-generator.test.ts or make it assert isolation (ORCH-2) — committed 6da95613a (honest in-host-realm naming + non-isolation test)

48:   - [x] rewrite evals/README for buffbench (EL-14) — committed 398a77a2c

50:   lang TS.

## P6-T6 (old PLAN line160)

161:   - notify-driven live watching and external-edit SDK events (old W5-2)

162:   - in-process ripgrep crates behind code_search, with `CODEBUFF_RG_PATH` still honored (old W2-1)

163:   - tantivy BM25/fuzzy/phrase tier behind queryIndex (old W2-2)

164:   - transactional redb/SQLite store (old W2-3)

166:   lang Rust. gate: MRR suites ≥ baseline; index-store lock/CAS semantics preserved or superseded by daemon tests.

## P8-T4 (old PLAN line189)

190:   - scipy/statsmodels paired and mixed-effects gates with power analysis

191:   - judge calibration: krippendorff, Bradley-Terry pairwise tournament, Dawid-Skene

192:   - failure mining: lightgbm+SHAP, HDBSCAN

193:   - optuna BO over pruner/compaction caps

195:   (EL-1 full, EL-5, EL-6, EL-10) lang Python offline only (D38/D34: a uv batch CLI over stats/failure-mining/optuna; never a runtime sidecar).
