# Audit findings: plan-RE

- Subsystems: .agents
- Features: eval-hygiene-statistics-gate, local-learning-log-otel-parquet, duckdb-observatory, eval-fleet, python-stats-sidecar, failure-mining, promotion-wiring-variant-registry, dspy-evolve, learned-router-bandit, lessons-knowledge-store, memory-rerank-nli-semantic-search, local-inference, local-compaction, local-embeddings, lora-adapters, exact-tokenizers, hosted-retention-floor, eviction-archive, indexed-recall, multipass-drift-sweep, eval-isolation, conflict-D28-vs-D34, conflict-D39-go-fleet, conflict-python-runtime, conflict-llama-server-consume
- Files covered: 5
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] test-coverage — PLAN.md:39 — P0-T6 Eval hygiene + statistics gate: KEEP TS (add exact Wilcoxon + scipy-generated oracle fixtures)
- **Risk:** The plan uses TS (evals/buffbench/statistics.ts), which is the right language: it is dependency-free, seeded and imported by proposals.ts. The math has gaps. Wilcoxon always uses the normal approximation, which is unreliable on eval sets of 10-30 tasks, and the bootstrap is percentile-only. A promotion at p<=0.05 can flip either way. Moving this to Python would add IPC and a toolchain for roughly 200 lines of math.
- **Fix:** KEEP TS. NOW: add an exact Wilcoxon null distribution (DP over rank sums) for n<=50, which matches SciPy's method='auto' threshold, with a permutation fallback when there are ties or zeros. Optionally add BCa. Check in a JSON fixture of p-values/CIs generated once with scipy.stats.wilcoxon/bootstrap; CI does not need Python. UNLOCKS NOW: a trustworthy promotion gate on small eval sets. NEXT: the same fixtures act as the parity oracle for any offline Python analysis.
- **Evidence:** PLAN.md:39 (DONE, lang TS). cb-evals-infra statistics.ts:155-213 (normal approximation only), :70-112 (percentile CI). Cost: 0.5-1 day. Confidence: high. Web: SciPy 1.18 wilcoxon auto uses exact when len(d)<=50, and a permutation test when len(d)<=13 with ties or zeros (docs.scipy.org).

## [HIGH] performance — PLAN.md:66 — CQ-T1 Hosted retention floor + selection core: CHANGE→Rust ort sidecar (D34 supersedes D28 serving; Python trains/exports only)
- **Risk:** CQ-T1 still says the LLMLingua-2/summarizer/reranker selection core runs in the D2 Python sidecar (D28). D34, accepted later, says Rust ort serves compaction selection and Python only trains and exports. The plan line was never updated. A Python runtime would put torch (~GBs) on the compaction path, which hosted runs hit every turn. That violates D2's never-on-the-hot-path rule. The TS retention-floor slice itself is correct. There is also an estimator mismatch: the pruner's handleSteps uses CHARS_PER_TOKEN=3 while the runtime trigger uses BPE times a fudge factor, so the two sides disagree about budgets.
- **Fix:** CONFLICT 1 ADJUDICATED: D34 wins. Serving goes to a Rust `ort` + HF `tokenizers` sidecar (X-3b crate `openbuff-ml`, supervised by X-5). Python only exports LLMLingua-2 to ONNX offline (optimum), with int8 quantization. Use the BERT-base multilingual variant (Apache-2.0, ~0.2B params) by default and XLM-R large (MIT, ~2.24GB F32) as opt-in. Run it runtime-side as a pre-pass over stale verbose tool results, because handleSteps is serialized via new Function and cannot import native code. Inject exact token counts into the pruner params. Gate on evals/compaction-fidelity. UNLOCKS NOW: the TS floor is already shipped, and aligning the estimator is small. NEXT: one ML runtime shared by P8-T9, P8-T10 and P9-T7, no Python process at runtime, and GPU EPs (CUDA/CoreML/DirectML) for free.
- **Evidence:** PLAN.md:66 'runs in the D2 Python sidecar'. SPEC D28 vs D34 ('Rust ort serves compaction selection, reranker, NLI and embeddings; Python only trains/exports'). cb-rt-util agents/context-pruner.ts HYBRID finding (ort in daemon, not Python; CHARS_PER_TOKEN=3). Cost: L (ONNX export, model distribution of 0.2-2GB, eval gating); estimator alignment S. Confidence: high on the direction; medium that the ONNX export works unmodified. Web: ort 2.0.0-rc.13 (still RC, targets ONNX Runtime 1.30, cuda/coreml/directml EPs, load-dynamic). LLMLingua-2 checkpoints are AutoModelForTokenClassification (HF model cards); the ONNX export itself was not verified.

## [LOW] test-coverage — PLAN.md:67 — CQ-T2 Evictions as archived records: KEEP TS
- **Risk:** The plan uses TS (context-archive.ts, in memory, persisted on AgentState). The archive is bound to JS object identity (WeakSet dedupe), bounded at 8x200x4k, and already durable through the checkpoint, chat-state and SDK seams. Nothing is gained from another language.
- **Fix:** KEEP. NOW: journal persistence rides P2-T2. NEXT: if the archive becomes cross-session in the daemon, move it together with the recall store (rusqlite), with no semantic change.
- **Evidence:** PLAN.md:67 (DONE). cb-rt-util context-archive.ts:23-27,:62,:94-194 KEEP. Cost: 0. Confidence: high.

## [LOW] performance — PLAN.md:68 — CQ-T3 Indexed recall_context: KEEP TS bun:sqlite FTS5 (Rust tantivy only for cross-session scale)
- **Risk:** The plan uses TS FTS5 now and moves to Rust tantivy via P6-T6. The index is rebuilt in memory on every call over at most ~1600 rows (~6.4MB), which is bounded. Results are ordered newest-first, so BM25 is computed but not used. Tantivy is overkill for an ephemeral 6MB corpus. FTS5 availability in bun:sqlite on Windows/musl is unverified.
- **Fix:** KEEP. NOW: cache the built index keyed by archive identity and length. Add a BM25-ranked mode behind a flag, evaluated against recency ordering. Add a CI check that FTS5 compiles on every Bun release target. LATER: for cross-session recall over many runs, use daemon rusqlite FTS5 first. Use tantivy only when fuzzy/phrase search at more than 100MB is needed.
- **Evidence:** PLAN.md:68. cb-rt-util archive-recall-index.ts:226-325 (per-call CREATE VIRTUAL TABLE, ORDER BY row_index DESC). Cost: S now, M later. Confidence: high.

## [LOW] test-coverage — PLAN.md:69 — CQ-T4 Multi-pass drift sweep: KEEP TS
- **Risk:** The eval must drive the context-pruner handleSteps generator in-process, which only TS can do.
- **Fix:** KEEP. Emit the metrics table as JSON so DuckDB (P8-T2) can track the trend.
- **Evidence:** PLAN.md:69 (DONE, 11/11). cb-evals-infra compaction-retention scenario.test.ts:286-316 KEEP. Cost: 0. Confidence: high.

## [MEDIUM] performance — PLAN.md:108 — P3-T10 Exact tokenizers: CHANGE→Rust tiktoken-rs + HF tokenizers (napi/daemon), plus provider-usage calibration
- **Risk:** The plan puts transformers.js first and a napi kernel only if X-2 shows the need. D41 (proposed) already says Rust. transformers.js is a JS port of HF tokenizers and would not fix the BPE stall. Claude and Gemini have no local tokenizers, so exact counts there are impossible offline. The 1.35/1.1 fudge factors would stay for those providers unless they are calibrated.
- **Fix:** CHANGE: a Rust crate in X-3b wrapping tiktoken-rs (o200k/cl100k) and `tokenizers` (tokenizer.json for open-weight models), exposed via napi now and via the daemon later. Keep the TS IncrementalTokenCounter WeakMap as the cache and batch unseen messages per step. For Claude/Gemini, replace the static factors with an EWMA ratio calibrated from provider usage.input_tokens. Keep gpt-tokenizer as the fallback tier and pin its version. UNLOCKS NOW: no more 100k-char cap or 20k-sample extrapolation, and compaction triggers become exact. NEXT: the same crate is shared with the ort sidecar tokenizers and P9-T6.
- **Evidence:** PLAN.md:108 'lang TS (transformers.js) → napi'. SPEC D41, D12. cb-rt-util token-counter.ts:29-57,:95-115 (the >2min encode on 5MB), and package.json caret range. cb-sdk-core llm.ts request-time budgeting HYBRID. Cost: M (1-2 weeks). Confidence: high. Web: tokenizers 0.23.2 (1.0.0-rc.2); tiktoken-rs maintained with o200k_base and o200k_harmony.

## [MEDIUM] test-coverage — PLAN.md:164 — P8-T0 Eval isolation + artifacts: KEEP TS/YAML (CONSUME podman/docker, later the P5 shim)
- **Risk:** The plan uses a TS docker/podman wrapper plus upload-artifact, which is correct. The workflows also have drift: bun 1.3.5 in CI against 1.3.11 in engines, tag-pinned actions, and toJSON(secrets) passed to runners. That undermines the isolation gate.
- **Fix:** KEEP. NOW: containerize withTestRepo, align the bun version, SHA-pin actions, pass only the named secrets, and use upload-artifact with if: always(). NEXT: swap the container for the P5 Rust shim profile where available, reporting the tier via X-4.
- **Evidence:** PLAN.md:164. cb-evals-infra buffbench.yml:14-17,34-35 and nightly-evals.yml drift finding. Cost: ~1 week. Confidence: high.

## [MEDIUM] dependency-hygiene — PLAN.md:165 — P8-T1 Local learning log OTel→Parquet: CHANGE→TS OTLP-JSONL spans + DuckDB COPY to Parquet; collector CONSUMED, not authored in Go
- **Risk:** The plan is TS with an optional Go OTel collector. Neither OTel JS nor the collector has a Parquet exporter; the contrib file exporter is alpha and writes json/proto only. 'Written as Parquet' therefore has no off-the-shelf path. Authoring Go for this would add a toolchain (D38/D39).
- **Fix:** CHANGE: the TS SDK exports OTLP-JSON lines through a local file span exporter (rotated, opt-in, with outcome labels attached at run end). A nightly or on-demand `openbuff learn compact` runs DuckDB `COPY (SELECT ... FROM read_json_auto(...)) TO ... (FORMAT parquet)`. The upstream otelcol-contrib binary is an optional consumed tool, never authored. UNLOCKS NOW: 100% local traces without the 2MB/1% cap. NEXT: Parquet feeds P8-T2, P8-T4 and P8-T7 training directly.
- **Evidence:** PLAN.md:165. SPEC D38/D39. cb-evals-infra retrieval-analytics-store.ts (JSONL writer + DuckDB CONSUME). Cost: S-M. Confidence: medium-high. Web: OTel JS exporters list OTLP/Console/Prometheus/Zipkin only; the collector fileexporter is alpha, json/proto (opentelemetry.io, contrib README).

## [LOW] dependency-hygiene — PLAN.md:166 — P8-T2 DuckDB observatory: KEEP TS (@duckdb/node-api) with a DuckDB CLI subprocess fallback
- **Risk:** The plan is TS duckdb node plus optional Python notebooks. @duckdb/node-api (Neo) is the current package, but Bun is not officially supported; there was a historical crash (bun#13910) traced to node-api use-after-free. A native addon crash inside the CLI process would take down the TUI.
- **Fix:** KEEP TS, but load @duckdb/node-api only in `openbuff dash` or a learn subprocess, never in the TUI process. Pin the version, and add a CI smoke under Bun. If it is unstable, CONSUME the duckdb CLI binary over stdio. Notebooks stay optional and offline. UNLOCKS NOW: SQL over eval JSON and Parquet. NEXT: longitudinal dashboards and per-language strata (D37).
- **Evidence:** PLAN.md:166. cb-evals-infra retrieval-analytics-store CONSUME DuckDB. Cost: S. Confidence: medium (Bun compatibility unverified). Web: DuckDB docs list Node Neo @duckdb/node-api 1.5.5 as primary and Parquet as native; Bun not documented (bun#13910).

## [HIGH] performance — PLAN.md:167 — P8-T3 Eval fleet: CHANGE→TS orchestration + GH matrix sharding + podman/P5 shim (DROP Go, accept D39)
- **Risk:** The plan is a Go runner plus a TS runTask entry. Throughput is limited by LLM latency (60-minute per-task timeout), taskConcurrency=1 and a single 6h runner, not by orchestrator CPU. The in-process CodebuffRunner needs the TS SDK, so a Go runner would be a second orchestration codebase that fixes no measured bottleneck and adds a toolchain.
- **Fix:** CONFLICT 2 ADJUDICATED: accept D39 and drop authored Go. NOW: shard task ids across a GH Actions matrix, raise taskConcurrency, run each task in a container, and make runs resumable via per-task JSON results merged before the significance gate. Build the cost/quality Pareto front in TS. Mutation oracle: CONSUME StrykerJS with the command runner (bun test), cargo-mutants for rust/, and mutmut for Python. NEXT: use an existing queue (k8s Jobs or Modal) driving the same TS entrypoint, and the P10-T1 microVM tier for untrusted repos.
- **Evidence:** PLAN.md:167 'lang Go runner'. SPEC D18, D38, D39. cb-evals-infra run-buffbench.ts:661-683 and agent-runner.ts:93 (supports D39), and run-mutation-gate.ts:1-18 (no mutation engine). Cost: sharding 1-2 days, containerization ~1 week, versus 3-6 weeks for Go. Confidence: high.

## [HIGH] dependency-hygiene — PLAN.md:168 — P8-T4 Python stats + learn sidecar: CHANGE→Python OFFLINE-only `openbuff learn` batch CLI (no runtime sidecar); failure mining included
- **Risk:** The plan makes a uv-managed Python sidecar for scipy/statsmodels, calibration, failure mining (lightgbm+SHAP, HDBSCAN) and optuna. None of these is interactive. Running them as a supervised sidecar adds X-5 lifecycle, IPC and a runtime Python dependency. The gate depending on Python at promotion time would make CI fragile. D34 already limits Python to train/export.
- **Fix:** CONFLICT 3 ADJUDICATED: Python is not needed at runtime. It is an offline, uv-run batch CLI (`uv run openbuff-learn <job>`). Jobs read Parquet/JSONL, and are mixed-effects/power analysis (statsmodels), Krippendorff alpha, Bradley-Terry, Dawid-Skene, lightgbm+SHAP plus HDBSCAN failure clusters, and optuna over pruner caps. Outputs are versioned JSON reports, proposals and ONNX artifacts that re-enter the TS gate. The blocking promotion gate stays TS (P0-T6/P8-T4a). CI validates with pytest only on the learn package. UNLOCKS NOW: no runtime Python; the ML stack stays available. NEXT: failure clusters feed P8-T5 proposals and P8-T6 train splits.
- **Evidence:** PLAN.md:168-174. SPEC D2 ('never on the hot path'), D34, D38. cb-evals-infra statistics finding ('rescope P8-T4 to offline oracle + reports'). Cost: offline CLI ~1-2 weeks, versus sidecar plus supervisor wiring and cross-platform Python distribution. Confidence: high.

## [MEDIUM] test-coverage — PLAN.md:175 — P8-T4a Statistics hardening in TS: KEEP TS (exact Wilcoxon n<=50, Holm correction, power/MDE)
- **Risk:** The plan is TS, which is correct. The exact-test threshold is written as 'n<10 guard'; matching SciPy's n<=50 exact rule avoids a TS/Python disagreement. Multiple comparisons across agents and proposals are uncontrolled.
- **Fix:** KEEP. Use an exact DP up to n=50 (with a permutation test when there are ties), simulation power/MDE with the seeded RNG to size --repeats, Holm-Bonferroni across agents, and mean±SE in compare-runs. UNLOCKS NOW: the gate rejects underpowered or noise promotions.
- **Evidence:** PLAN.md:175. cb-evals-infra statistics.ts and compare-runs.ts:76-184 (no variance). Cost: ~1 day. Confidence: high. Web: SciPy exact method when len(d)<=50.

## [MEDIUM] test-coverage — PLAN.md:176 — P8-T5 Promotion wiring + variant registry: KEEP TS (default requireSignificance=true, repeats>=3)
- **Risk:** The plan is TS. The default policy gates on totalScoreDelta>=0.25, a sum with no variance; significance is opt-in, and repeats defaults to 1. Wiring promotions into the runner as-is would promote noise.
- **Fix:** KEEP. Make requireSignificance the default, require repeats>=3 and a held-out split, and add a per-language no-regression check (D37). The variant registry is versioned JSON overlays with a candidate channel and rollback. UNLOCKS NOW: safe automated promotions. NEXT: a common target for P8-T6 overlays and P8-T7 bandit arms.
- **Evidence:** PLAN.md:176. cb-evals-infra proposals.ts:379-445, run-buffbench.ts:670-682. Cost: 1-3 days. Confidence: high.

## [MEDIUM] dependency-hygiene — PLAN.md:177 — P8-T6 `openbuff evolve` (DSPy): KEEP Python offline + TS orchestration; metric calls the TS runner
- **Risk:** The plan is Python plus TS orchestration, which is correct: DSPy/GEPA has no TS equivalent. The risk is the metric loop. DSPy must score candidates by running real agents, which only the TS SDK can do. If DSPy calls providers directly, BYOK config and the tool surface diverge.
- **Fix:** KEEP Python, offline only. Use dspy.GEPA (reflection_lm plus a budget), or MIPROv2 as the alternative. The metric shells out to `openbuff run --json` (P1-T5) or ACP on a train split. Outputs are prompt/tool-description overlays that go through the TS P8-T5 registry and gate on the held-out split. UNLOCKS NOW: prompt evolution with no runtime Python. NEXT: GEPA reflection consumes P8-T4 failure clusters and P8-T8 lessons.
- **Evidence:** PLAN.md:177. SPEC D2. cb-evals-infra lessons-extractor finding (offline DSPy loop re-entering the TS gate). Cost: 1-2 weeks, plus eval spend. Confidence: medium. Web: dspy.GEPA documented in current DSPy (needs metric, reflection_lm and a budget; depends on the `gepa` package).

## [MEDIUM] dependency-hygiene — PLAN.md:178 — P8-T7 Learned router + bandit: CHANGE→Python train, pure-TS scoring of exported weights (no onnxruntime-node)
- **Risk:** The plan is Python training with TS/onnxruntime inference. A router classifier is tiny (logistic regression or a small GBDT). onnxruntime-node brings a large native addon into the Bun process for a dot product, which contradicts D34 ('tiny routers score in TS') and adds a second ONNX runtime next to the Rust ort sidecar.
- **Fix:** CHANGE: train in the offline Python learn CLI (sklearn/lightgbm) and export JSON weights or trees, which TS evaluates in microseconds. Use ONNX only if the model outgrows that, and then serve it via the Rust ort sidecar. Thompson/LinUCB bandits stay pure TS and are persisted in the P8-T8 store. Explicit routing wins and recommendations stay transparent. UNLOCKS NOW: no native dependency and deterministic tests. NEXT: arms equal P8-T5 variants.
- **Evidence:** PLAN.md:178 'TS/onnxruntime inference'. SPEC D34. Cost: S-M. Confidence: high.

## [MEDIUM] dependency-hygiene — PLAN.md:179 — P8-T8 Lessons knowledge store: KEEP TS bun:sqlite FTS5; sqlite-vec with an extension-loading check (rusqlite later)
- **Risk:** The plan is TS bun:sqlite FTS5 plus sqlite-vec, which is right for lessons/memory scale. sqlite-vec is a loadable extension, and on macOS Bun uses the system SQLite, which blocks extensions unless Database.setCustomSQLite is used (inferred, not verified here). Semantic search could silently degrade. Brute-force vector scan (~20k x 1536) is the D12 kernel candidate.
- **Fix:** KEEP. Probe for extension loading at startup and report the tier via X-4 ('memory search: fts5+vec' versus 'fts5-only'). Bundle or pin sqlite-vec per platform. Ship memory-v2 search() on FTS5 first. LATER: move to rusqlite plus sqlite-vec in the daemon when the daemon exists. Use a SIMD dot-product kernel only if the X-2 row justifies it.
- **Evidence:** PLAN.md:179. SPEC D12, D33. cb-rt-util archive-recall-index (bun:sqlite FTS5 pattern). Cost: M. Confidence: medium (macOS extension-loading behavior inferred, not web-verified).

## [MEDIUM] performance — PLAN.md:180 — P8-T9 Memory reranking + NLI: CHANGE→Rust ort sidecar (fastembed-rs TextRerank + NLI cross-encoder ONNX)
- **Risk:** The plan is TS transformers.js/onnxruntime-node, which contradicts D34. It would load cross-encoders into the Bun process: GC pressure, no GPU EPs, and a native crash taking down the TUI (the same class of risk as D7). It would also create a second ML runtime next to CQ-T1.
- **Fix:** CHANGE: the same `openbuff-ml` Rust sidecar as CQ-T1. Use fastembed-rs TextRerank (bge-reranker-base or v2-m3) and an NLI cross-encoder exported to ONNX for contradiction and staleness, feeding revalidate/correct. TS calls it over JSON-RPC; if the sidecar is absent, the capability is not advertised. UNLOCKS NOW: precision on memory search. NEXT: the reranker is reused by CQ-T3 recall and query_index.
- **Evidence:** PLAN.md:180 'lang TS (transformers.js / onnxruntime-node)'. SPEC D34, D7 rationale. cb-sdk-core embeddings.ts (CONSUME fastembed-rs/ort). Cost: M (shared crate). Confidence: medium-high. Web: fastembed-rs uses ort plus tokenizers and ships TextRerank with BGE rerankers, Apache-2.0.

## [MEDIUM] performance — PLAN.md:181 — P8-T10 Local embeddings: CHANGE→CONSUME fastembed-rs in the Rust ort sidecar (skip the onnxruntime-node stage)
- **Risk:** The plan is TS onnxruntime-node, then a candle/ort sidecar if GPU is needed. The two stages mean two runtimes and a migration. The cacheKey would have to stay stable across both.
- **Fix:** CHANGE: go straight to fastembed-rs in `openbuff-ml` (or the index daemon once it exists), behind EmbedFn, with cacheKey `local:onnx/<model>@<revision>`. The candle backend is only for models that need it. UNLOCKS NOW: offline semantic search with no API keys. NEXT: the index daemon embeds incrementally on notify events.
- **Evidence:** PLAN.md:181. SPEC D34. cb-sdk-core embeddings.ts LOW finding. Cost: S on top of the P8-T9 crate. Confidence: medium-high. Web: fastembed-rs Apache-2.0, ort-based, with an optional candle backend for some models.

## [HIGH] dependency-hygiene — PLAN.md:191 — P9-T6 Local inference: CONSUME llama.cpp `llama-server` binary under X-5 first; author a llama-cpp-2 sidecar only for KV-fork gaps
- **Risk:** D7 locks an authored Rust sidecar (mistral.rs or llama-cpp-2) that implements constrained decoding, KV sequences/forks and snapshots itself. The upstream llama-server already ships GBNF/JSON-schema constraints, parallel slots, slot save/restore to disk, speculative decoding and LoRA adapters, with per-platform CUDA/Metal/Vulkan binaries. Authoring the sidecar duplicates most of this and takes on GPU build-matrix cost. D7's goal of process isolation from Bun is fully met by a supervised binary. The genuine gap is per-run KV forks for spawn_agents (seq_cp), which the server does not expose as an API.
- **Fix:** CONFLICT 4 ADJUDICATED: CONSUME. Tier 1: X-5 supervises checksum-verified llama-server release binaries on a loopback port with a token. X-5 needs an HTTP health/transport adapter because today it speaks stdio JSON-RPC. Tool calls use json_schema compiled from Zod (D17). Resume uses --slot-save-path. Draft models give speculative decoding. LoRA uses /lora-adapters. Tier 2 (evidence-gated): a thin llama-cpp-2 Rust sidecar exposing kv_cache_seq_cp/seq_rm and state_seq_save for spawn_agents forks, only if an eval shows fork savings. Keep mistral.rs as the alternative engine (MIT, llguidance, per-request LoRA). This needs a dated D7 amendment. UNLOCKS NOW: local models in weeks, not months, with no GPU CI matrix. NEXT: forks and llguidance lazy grammars through Tier 2; PR-T4 block payloads become the default there.
- **Evidence:** PLAN.md:191. SPEC D7 (locked), D38. cb-sdk-core llm.ts (keep AI SDK; llama-server's OpenAI-compatible API plugs into the existing openai-compatible provider). Cost: Tier 1 S-M (supervision plus a provider preset); authored sidecar L plus a GPU build matrix. Confidence: high. Web: llama-server README (--json-schema/grammar, -np slots, --slot-save-path save/restore, -md draft, /lora-adapters, /v1/chat/completions), release binaries for Metal/CUDA/Vulkan. llama-cpp-2 0.1.157 has kv_cache_seq_cp, state_seq_save_file and grammar samplers. mistral.rs is MIT with llguidance and LoRA/X-LoRA.

## [MEDIUM] performance — PLAN.md:192 — P9-T7 Local compaction: CHANGE→TS governor + shared Rust ort compaction sidecar (drop 'TS (ONNX)')
- **Risk:** The plan says 'lang TS (ONNX) + P9-T6 engine' and points the quality core at the CQ-T1 Python sidecar. That is three conflicting runtimes (TS ONNX, Python and Rust ort) for one capability. LLMLingua-2 XLM-R large is about 2.24GB F32, which is too heavy next to a local LLM on the same GPU or RAM.
- **Fix:** CHANGE: the looser local-run governor stays TS. Selection calls the same `openbuff-ml` ort sidecar as CQ-T1, using the BERT-base int8 checkpoint by default. The summarizer path uses the P9-T6 local model via llama-server. With Tier 2, the sidecar can prune the KV sequence instead of re-prefilling. UNLOCKS NOW: one compaction implementation for hosted and local runs. NEXT: KV-aware compaction.
- **Evidence:** PLAN.md:192. SPEC D28 vs D34. cb-rt-util context-pruner HYBRID finding. Cost: S incremental after CQ-T1. Confidence: medium. Web: LLMLingua-2 XLM-R large ~559M params (~2.24GB F32, MIT); BERT-base variant Apache-2.0.

## [MEDIUM] dependency-hygiene — PLAN.md:193 — P9-T8 LoRA adapters: KEEP Python offline (TRL/PEFT + unsloth on CUDA, mlx-lm on Apple), export GGUF LoRA for llama-server
- **Risk:** The plan is Python, which is correct: no TS or Rust training stack is competitive. The risk is the format handoff. Adapters trained in PEFT/MLX must convert to GGUF LoRA to hot-swap in llama-server. Unsloth Core's Apple support is still 'in the works', although Unsloth Studio claims Mac training.
- **Fix:** KEEP Python, offline, via uv. Use TRL/PEFT (unsloth on NVIDIA) or mlx_lm.lora (LoRA/QLoRA/DoRA) on Apple, trained on judge-verified traces from P8-T1 Parquet. Convert with llama.cpp convert_lora_to_gguf, preload with --lora, and hot-swap via the /lora-adapters scale or per-request lora. Promote only through the P8-T5 gate. UNLOCKS: per-project adapters on the consumed server, with no runtime Python.
- **Evidence:** PLAN.md:193. SPEC D2, D34. Cost: M plus GPU time. Confidence: medium (GGUF LoRA conversion path not web-verified here). Web: mlx-lm LORA.md supports LoRA/QLoRA/DoRA. Unsloth docs claim NVIDIA/AMD/Intel/Mac via Studio, but Core says Apple/MLX 'in the works'. llama-server /lora-adapters requires adapters preloaded with --lora.

## Coverage receipt

### Subsystems
- .agents

### Features
- eval-hygiene-statistics-gate
- local-learning-log-otel-parquet
- duckdb-observatory
- eval-fleet
- python-stats-sidecar
- failure-mining
- promotion-wiring-variant-registry
- dspy-evolve
- learned-router-bandit
- lessons-knowledge-store
- memory-rerank-nli-semantic-search
- local-inference
- local-compaction
- local-embeddings
- lora-adapters
- exact-tokenizers
- hosted-retention-floor
- eviction-archive
- indexed-recall
- multipass-drift-sweep
- eval-isolation
- conflict-D28-vs-D34
- conflict-D39-go-fleet
- conflict-python-runtime
- conflict-llama-server-consume

### Files
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-evals-infra.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-rt-util.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-core.md

### Domains
- performance
- dependency-hygiene
- test-coverage
