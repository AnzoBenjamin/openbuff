# Audit findings: w2-plan-p7-p10-x

- Subsystems: .agents, sdk, cli, common, packages, agents
- Features: P7-T1, P7-T2, P7-T3, P7-T4, P7-T5, P7-T6, P7-T7, P7-T8, P8-T0, P8-T1, P8-T2, P8-T3, P8-T4, P8-T4a, P8-T5, P8-T6, P8-T7, P8-T8, P8-T9, P8-T10, P9-T1, P9-T1a, P9-T2, P9-T3, P9-T4, P9-T5, P9-T6, P9-T7, P9-T8, P10-T1, P10-T2, P10-T3, P10-T4, P10-T5, P10-T6, P10-T7, P10-T8, P10-T9, X-4, X-5, CQ-T1
- Files covered: 11
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T1: confirmed
- **Risk:** None. VS Code has no first-party ACP client (D9), so a TS extension over ACP is the only option.
- **Fix:** Keep TS. Build it on @agentclientprotocol/sdk ClientSideConnection (the same SDK the server uses) and spawn `openbuff serve --stdio`. Do not add a second wire format.
- **Evidence:** PLAN P7-T1; SPEC D9 says VS Code has only third-party clients. sdk/package.json already pins @agentclientprotocol/sdk.

## [MEDIUM] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T2: build ACP client configs and ext-method adapters, not four bespoke editor clients
- **Risk:** Writing and maintaining a Kotlin, Lua and Elisp client each is a large, fragmented effort. JetBrains AI Assistant, Zed, Neovim (CodeCompanion/avante) and Emacs (agent-shell) already speak ACP (SPEC D9). A bespoke plugin would duplicate them and drift from ACP conformance.
- **Fix:** Ship a registration/config for each host: JetBrains ACP agent config (acp.json), Zed agent_servers entry, CodeCompanion/avante adapter snippet, agent-shell config. For Openbuff-only features (receipts, lanes, gate), write thin ext-method adapters on top of those hosts: a small Kotlin plugin that uses the official Kotlin ACP SDK only for `_openbuff.dev/*` UI, plus a Lua module for CodeCompanion. Also generate each adapter's types from the D17 JSON Schema artifacts.
- **Evidence:** SPEC D9 lists the existing ACP clients and the official TS/Rust/Python/Kotlin libraries. PLAN P7-T2 lang lists 'Kotlin/Lua/Elisp/Rust' as full clients.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T3: Tauri 2 is the right shell, but the plan to reuse React components assumes DOM components that do not exist
- **Risk:** The TUI renders with OpenTUI (terminal cells), not DOM React, so the desktop app cannot reuse TUI components. On Linux, Tauri uses WebKitGTK, whose WebGL/3D-preview and media support lags Chromium, so the rich-media goal may regress there.
- **Fix:** Keep Tauri 2 (Rust + webview; Electron's ~100MB Chromium adds nothing needed). Share the P2-T7 `openbuff dash` React/DOM components instead, and make the desktop an ACP client over the unix socket. Gate 3D previews on a WebGL capability probe with a static-image fallback on WebKitGTK. Use tauri-plugin-updater, tauri-plugin-notification and the tray API, which also cover P7-T5 (see that finding).
- **Evidence:** PLAN P7-T3 says 'reuses the React components where possible'. P2-T7 dash is the only DOM React surface. SPEC non-goals: TUI stays OpenTUI.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T4: use one Rust Noise core (snow) via UniFFI and a Rust relay; drop 'Noise/libsodium' mixing and the Go relay option
- **Risk:** Implementing Noise separately in Swift, Kotlin and Go means three crypto implementations to review, plus handshake-pattern drift. 'Noise/libsodium' is ambiguous (two different protocols). A Go relay adds a toolchain with no capability gain.
- **Fix:** Put Noise_XX (or IK after QR pairing, with the PSK carried in the QR) in a Rust crate built on `snow`, exported to Swift/Kotlin with UniFFI. The relay is a small Rust (tokio/axum) blind forwarder in the same workspace (X-3b). Keep native Swift (APNs, Live Activities, watchOS) and Kotlin (FCM, Wear); Tauri mobile and PWAs cannot do Live Activities or Wear, and PWA push needs a hosted push service, which conflicts with D6. Add property tests of the Swift and Kotlin bindings against the Rust vectors.
- **Evidence:** PLAN P7-T4 'Noise/libsodium (D6)', 'Rust/Go relay'. SPEC D6 requires LAN/self-hosted Noise E2E. X-3b hosts the crates.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T5: notify-rust cannot deliver actionable Approve/Deny on macOS/Windows from a Bun napi addon; keep napi only for arboard
- **Risk:** notify-rust has action buttons only on Linux/XDG. On macOS, UNUserNotificationCenter actions need a signed app bundle with a bundle id, which a CLI process loaded as a napi addon lacks. Windows actionable toasts need a registered AUMID and COM activator. The approval UX would silently degrade outside Linux.
- **Fix:** Split the task. (a) Rust napi addon with arboard (text plus image get/put), which replaces clipboard.ts execSync and the clipboard-image.ts PowerShell shelling. (b) Deliver actionable notifications and the tray through the P7-T3 Tauri app (tauri-plugin-notification with a signed bundle/AUMID) acting as an ACP client that answers session/request_permission. The CLI falls back to OSC 9/777 from P1-T7 and advertises the tier via X-4.
- **Evidence:** PLAN P7-T5 'actionable Approve/Deny notifications (notify-rust), tray-icon'. Its DEPTH note cites clipboard.ts:120-146 execSync and the PowerShell 5-10s timeouts.

## [HIGH] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P7-T6: SDKs only for Python/Go; generate from D17 JSON Schema on top of the official ACP SDKs and cover Rust/Java-Kotlin/C# too
- **Risk:** Users whose repos are in Rust, JVM or .NET get no SDK. Hand-rolled Python/Go protocol stacks would duplicate the official ACP libraries and drift from them.
- **Fix:** For every language, layer the SDK on the official ACP library (Python, Rust, Kotlin; Go and C# have community libraries or can use a thin JSON-RPC layer). Generate only the Openbuff extension and tool types from the published z.toJSONSchema artifacts, with per-language tools: datamodel-code-generator (pydantic v2), go-jsonschema or quicktype (Go), typify (Rust), quicktype/jsonschema2pojo (Kotlin/Java), NJsonSchema (C#). Do not use openapi-generator, because the contract is JSON-RPC, not OpenAPI. Custom tools are reverse RPC with a per-SDK conformance run against the GV-01…GV-30 golden vectors.
- **Evidence:** PLAN P7-T6 names 'Python (pydantic/asyncio) and Go'. SPEC D17 says the JSON Schema artifacts feed P7-T6. SPEC D9 lists the official TS/Rust/Python/Kotlin ACP libraries.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T7: fix grapheme wrap in TS with Intl.Segmenter first; use prebuilt sharp for image resize; napi only for nucleo
- **Risk:** A napi kernel for a correctness bug (Array.from code-point splitting) adds build-matrix cost when Bun already ships Intl.Segmenter (ICU grapheme clusters). A custom image-resize crate duplicates the maintained sharp/libvips prebuilt addon.
- **Fix:** Grapheme: use Intl.Segmenter in text-layout.ts with a per-line cache, and measure against X-2 before considering napi (unicode-segmentation + unicode-width). Image encode/resize: use @img/sharp prebuilt (principle 3d, existing prebuilt addon) instead of the 16 synchronous Jimp passes. Keep the OpenTUI kitty/sixel protocol work in TS. Keep the nucleo napi kernel, since there is no TS equivalent for fuzzy matching at that quality.
- **Evidence:** PLAN P7-T7 DEPTH notes text-layout.ts:31-33 Array.from and image-handler.ts:120-190 Jimp. SPEC principle 3(d) prefers existing prebuilt addons.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P7-T8: confirmed
- **Risk:** None beyond the D1 daemon dependency.
- **Fix:** Keep TS client plus Rust daemon. The attach path reuses the P1-T3 protocol client over the unix socket.
- **Evidence:** PLAN P7-T8; SPEC D1.

## [LOW] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T0: confirmed
- **Risk:** A container wrapper without network and credential isolation would still leak keys.
- **Fix:** Keep TS/YAML. Run rootless podman/docker with `--network none` (or an egress allowlist), an env allowlist through getChildProcessEnv, and a read-only host mount. Upload artifacts with if: always().
- **Evidence:** PLAN P8-T0; SPEC D18.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T1: write OTLP-JSON NDJSON spans locally and let DuckDB produce Parquet; skip a JS Parquet writer and the Go collector
- **Risk:** JS Parquet writers (parquetjs forks, parquet-wasm) are weakly maintained or heavy. An optional Go OTel collector adds a toolchain just to reformat local files.
- **Fix:** Emit spans with @opentelemetry/sdk-trace-base plus a small file exporter that writes OTLP-JSON NDJSON with outcome labels (rotated, size-bounded). At P8-T2 ingest, DuckDB `read_json_auto` → `COPY … TO 'x.parquet'` gives columnar storage with zero new writers. Keep the collector only as documentation for users who already run one.
- **Evidence:** PLAN P8-T1 'written as Parquet … optional Go OTel collector'. No duckdb/parquet dependency in sdk/cli package.json (code_search found none).

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T2: run DuckDB out-of-process (duckdb CLI sidecar or duckdb-wasm), not the duckdb node napi binding under Bun
- **Risk:** @duckdb/node-api is a large napi binary. Under Bun, napi addons have the same crash class that D7 used to justify keeping inference out of process. An observatory crash would take down the TUI or dash.
- **Fix:** Invoke the pinned, checksummed duckdb CLI as an X-5-supervised sidecar (or `duckdb -json` one-shots) for dash queries, or use @duckdb/duckdb-wasm in the dash browser. Python notebooks use the duckdb Python package directly on the same Parquet.
- **Evidence:** PLAN P8-T2 'TS (duckdb node)'. SPEC D7 rationale (napi/Bun segfault precedent, oven-sh/bun#27320).

## [HIGH] test-coverage — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P8-T3: StrykerJS mutation oracle only covers JS/TS repos; the Go runner is a thin wrapper
- **Risk:** Oracle strength goes unmeasured for Python/Rust/Go/JVM/.NET/C++ eval repos, so learning is biased toward TS tasks. Per D18 the Go fleet only owns container lifecycle, which Bun.spawn plus the docker/podman CLI already cover (P8-T0 is TS).
- **Fix:** Pick the mutation tool by the ToolSpec registry language: StrykerJS / Stryker.NET, mutmut or cosmic-ray (Python), cargo-mutants (Rust), gremlins/go-mutesting (Go), PIT (JVM), mull (C/C++), surfaced as registry `testRunner`-adjacent specs. Extend the P8-T0 TS wrapper into the fleet (concurrency, repeats, resume) and add Go or a microVM runner only when X-2-style evidence shows TS lifecycle limits.
- **Evidence:** PLAN P8-T3 'oracle strength via StrykerJS mutation', 'lang Go runner'. SPEC D18 limits Go to process/container lifecycle.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T4: confirmed (Python/uv); pin specific libraries
- **Risk:** Generic 'krippendorff/Bradley-Terry/Dawid-Skene' leaves the implementations unchosen.
- **Fix:** Use statsmodels MixedLM (mixed effects), scipy.stats.wilcoxon (exact), the `krippendorff` package, choix (Bradley-Terry), crowd-kit (Dawid-Skene), lightgbm+shap, hdbscan (sklearn.cluster.HDBSCAN), optuna. pingouin is optional convenience. Call the sidecar over JSON-RPC via X-5 with a uv-locked env.
- **Evidence:** PLAN P8-T4; SPEC D2.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T4a: confirmed
- **Risk:** None.
- **Fix:** Keep TS (seeded RNG already in evals/buffbench/statistics.ts).
- **Evidence:** PLAN P8-T4a, P0-T6.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T5: confirmed
- **Risk:** None.
- **Fix:** Keep TS.
- **Evidence:** PLAN P8-T5.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T6: confirmed (DSPy GEPA/MIPROv2); drop TextGrad
- **Risk:** Carrying two optimizer ecosystems doubles the maintenance surface.
- **Fix:** Use DSPy (dspy.GEPA, MIPROv2) only, with prompts/tool descriptions as dspy Signatures exported to versioned overlays. Split train/held-out by repo language as well as task, so gains are not TS-only [POLY].
- **Evidence:** PLAN P8-T6 'DSPy MIPROv2/GEPA or TextGrad'.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T7: score the router in pure TS from exported coefficients; bandit in TS; no ONNX runtime or Vowpal Wabbit
- **Risk:** onnxruntime-node is a large napi dependency under Bun for what is a logistic/GBDT classifier. VW is heavyweight and poorly maintained for this scale.
- **Fix:** Train in Python and export a JSON artifact: logistic coefficients, or GBDT trees via lightgbm dump_model. Evaluate it in about 100 lines of TS. Implement Thompson sampling (Beta/Normal-Gamma) and LinUCB in TS over the local outcome log, with a golden-vector test that TS scoring equals Python predictions.
- **Evidence:** PLAN P8-T7 'exported to ONNX for TS inference. Thompson/LinUCB'.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T8: bun:sqlite FTS5 is right, but sqlite-vec loading needs Database.setCustomSQLite on macOS
- **Risk:** On macOS, Bun's bun:sqlite uses the system SQLite, which disables loadExtension, so sqlite-vec silently fails there and vector search is Linux-only.
- **Fix:** Keep TS. At startup, call Database.setCustomSQLite() with a vendored or Homebrew libsqlite3 when the platform is darwin, and record 'vec' in memory_store_capabilities the way fts5 is probed. If unavailable, fall back to brute-force Float32 scan and report the tier (principle 6).
- **Evidence:** bun-sqlite-memory-repository.ts recordRuntimeCapabilities probes only fts5. search() returns unsupported('semantic-search').

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T9: reranker/NLI in transformers.js contradicts D28; run it in the same ort sidecar as compaction
- **Risk:** This creates a second ML runtime (transformers.js/onnxruntime-node in-process) alongside the D28 Python sidecar, with duplicated model management and napi-under-Bun risk.
- **Fix:** Host the cross-encoder (e.g. bge-reranker-v2-m3, multilingual) and the NLI model (e.g. mDeBERTa-xnli) in one Rust `ort` sidecar (openbuff-ml, X-5-supervised) shared with P8-T10 embeddings and CQ-T1 LLMLingua-2 inference. Python stays for training and export only.
- **Evidence:** PLAN P8-T9 'lang TS (transformers.js / onnxruntime-node)'. SPEC D28 moves rerankers to Python.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P8-T10: local embeddings via the fastembed-rs/ort sidecar or the existing OpenAI-compatible path (ollama/llama-server), not onnxruntime-node
- **Risk:** onnxruntime-node in-process under Bun carries the D7 crash risk and has no GPU EPs on macOS. A separate model per subsystem wastes RAM.
- **Fix:** Tier 0: document that createConfiguredEmbedder already works with local OpenAI-compatible servers (ollama, llama-server `/v1/embeddings`), zero code. Tier 1: an ort/fastembed-rs sidecar (CoreML/CUDA/DirectML EPs) shared with P8-T9 and CQ-T1, with cacheKey `local:onnx/<model>@<dims>`.
- **Evidence:** sdk/src/impl/embeddings.ts accepts any provider.type 'openai-compatible'. PLAN P8-T10 'TS onnxruntime-node → candle/ort sidecar'.

## [MEDIUM] correctness — packages/indexer/src/semantic.ts — [POLY] P8-T10/semantic search: no code-language or non-English coverage evaluation for the embedding model
- **Risk:** General text-embedding models (e.g. text-embedding-3-small in the doc example) and English-only local models under-recall for non-JS languages and non-English identifiers and comments. With no per-language MRR row, the regression is invisible.
- **Fix:** Default local models: code-aware and multilingual (jina-embeddings-v2-base-code, nomic-embed-code / CodeRankEmbed, bge-m3). Add a per-language MRR suite (the 13 registry languages plus a CJK-comment fixture) to the P6 MRR gate, and pin the model per language tier in the capability manifest.
- **Evidence:** semantic.ts header example model 'openai/text-embedding-3-small'. fileEmbeddingText embeds path/symbols/contentSample with no language tag.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T1: confirmed
- **Risk:** None.
- **Fix:** Keep TS. Publish the agent.yaml JSON Schema (from Zod via D17) so yaml-language-server gives any editor validation and completion for free.
- **Evidence:** PLAN P9-T1; SPEC D17.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T1a: confirmed
- **Risk:** None.
- **Fix:** Keep TS.
- **Evidence:** PLAN P9-T1a.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T2: confirmed (stdio JSON contract is the any-language baseline); WASI/extism is not the primary path
- **Risk:** WASI-only hooks would exclude existing shell/Python/Go hook scripts.
- **Fix:** Keep executables over stdio JSON with the receipt schema published through D17, running inside the P5-T1 shim. Optionally accept P9-T5 components as a second hook kind.
- **Evidence:** PLAN P9-T2 DEPTH note (structured receipts).

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T3: confirmed
- **Risk:** None.
- **Fix:** Keep TS and validate external descriptors with a JSON Schema validator (ajv) against the D17 meta-schema.
- **Evidence:** PLAN P9-T3; SPEC D17.

## [HIGH] correctness — packages/agent-runtime/src/run-programmatic-step.ts:368 — [LANG] P9-T4: QuickJS via quickjs-emscripten is right, but JS_WriteObject cannot checkpoint a suspended generator; resume must be journal replay (or wasm linear-memory snapshot)
- **Risk:** JS_WriteObject serializes values and function bytecode, not live generator frames, closures or heap object graphs. The D11 'bytecode/heap snapshot of generator state' as specified is infeasible and would stall P9-T4 or ship a fake resume. rquickjs in a Rust sidecar adds an IPC round-trip per yield. SES has no CPU/memory limits. Javy is an AOT compiler; none fixes this.
- **Fix:** Keep quickjs-emscripten (add quickjs-emscripten-core around the already-pinned @jitl/quickjs-wasmfile-release-sync, sync variant with no asyncify). Use setInterruptHandler for CPU and setMemoryLimit/setMaxStackSize for memory, and HandleStepsYieldValueSchema at the boundary. Durable resume: deterministic re-drive, meaning re-run the generator in a fresh VM feeding the journaled toolResult sequence (P2-T2 already states 'a generator is re-driven by replay'; the IdGen/Clock injection makes it deterministic). Optional fast path: snapshot the whole WebAssembly.Memory buffer of the dedicated module instance when no host handles are live. Replace AgentRunContextRegistry with journal-keyed VM ownership.
- **Evidence:** run-programmatic-step.ts:55-134 in-memory AgentRunContextRegistry. new Function materialization around :368. sdk/package.json:63 @jitl/quickjs-wasmfile-release-sync 0.31.0 is the only QuickJS dependency (no wrapper). PLAN P2-T2 'a generator is re-driven by replay'.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T5: wasmtime component host is right; jco only for trusted plugins; sign with sigstore plus minisign offline
- **Risk:** jco-transpiled components run in the host JS engine with no fuel/epoch limits and share the process, so treating jco as an equal host weakens isolation. An unspecified signing scheme risks a bespoke key-management system.
- **Fix:** Use a wasmtime (component model, WASI 0.2, fuel plus epoch interruption, resource limiter) sidecar as the authoritative host for untrusted plugins. Use jco only for signed first-party plugins or dev mode. Guests in any language: cargo-component, componentize-py, jco componentize, TinyGo. Registry: sigstore keyless bundles verified in TS (sigstore-js) with a Rekor inclusion proof, minisign signatures for offline/air-gapped use, and a lockfile pinning digest plus capability grants. Skip extism, which is not component-model.
- **Evidence:** PLAN P9-T5 'wasmtime (sidecar) / jco … signed registry with lockfile'. SPEC principle 3(c).

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T6: prefer llama-cpp-2 plus llguidance as the primary engine, add an external OpenAI-compatible server tier, and add per-language local-model evals [POLY]
- **Risk:** mistral.rs has narrower quant/backend coverage than llama.cpp. Making users build a sidecar before any local path works delays value. No plan exists to measure local-model tool-call validity or code quality per repo language.
- **Fix:** The openbuff-infer Rust sidecar uses llama-cpp-2 (GGUF, Metal/CUDA/Vulkan/ROCm, seq_cp KV forks, state save/load) with llguidance grammars compiled from the D17 JSON Schemas (llama.cpp integrates llguidance natively). mistral.rs is the alternative backend behind the same JSON-RPC. Tier 0: detect ollama/llama-server/vLLM/SGLang (xgrammar/json_schema response_format) through the existing provider config. Gate model recommendations on MultiPL-E / per-registry-language tool-call validity evals.
- **Evidence:** PLAN P9-T6; SPEC D7 locks a Rust sidecar with 'mistral.rs or llama-cpp-2'.

## [LOW] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T7: confirmed as TS wiring only; remove '(ONNX)' from its lang line
- **Risk:** The lang line 'TS (ONNX)' contradicts D28, which moves the quality core out of TS.
- **Fix:** Lang becomes TS governor plus the P9-T6 engine and the shared ML sidecar.
- **Evidence:** PLAN P9-T7; SPEC D28.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P9-T8: confirmed (unsloth/TRL on CUDA, mlx-lm on Apple Silicon); add GGUF adapter conversion
- **Risk:** Adapters trained in PEFT format cannot be hot-swapped by llama.cpp without conversion.
- **Fix:** Pipeline: train (unsloth/TRL on NVIDIA, mlx-lm on macOS), then convert_lora_to_gguf, then load with llama_adapter_lora in P9-T6. Stratify the train/held-out split by repo language [POLY].
- **Evidence:** PLAN P9-T8.

## [LOW] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T1: confirmed Rust; make libkrun the primary cross-platform tier
- **Risk:** Firecracker is Linux/KVM-only. Virtualization.framework needs a Swift entitlement-signed binary.
- **Fix:** libkrun (KVM on Linux, HVF on macOS, Rust API) is primary. Firecracker/cloud-hypervisor for Linux snapshot/branch. gVisor runsc is optional. Windows uses the Hyper-V HCS / WSL2 fallback. Report the tier via X-4.
- **Evidence:** PLAN P10-T1; SPEC D4 hedge.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T2: aya/fanotify/ETW in Rust are fine; EndpointSecurity needs an Apple-granted entitlement; emit provenance as in-toto attestations
- **Risk:** The EndpointSecurity entitlement is not self-serve, so the macOS tier may never ship. Bespoke provenance records are not verifiable by SLSA tooling.
- **Fix:** macOS: ship as a Swift system extension only if the entitlement is granted, otherwise report 'provenance: none' honestly. Windows: ferrisetw. Record provenance as in-toto Statements (SLSA-provenance-style predicate) attached to broker receipts, verifiable with standard tooling.
- **Evidence:** PLAN P10-T2.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T3: consolidate GUI perception into one Rust MCP server instead of Swift + C# + Rust
- **Risk:** Three toolchains (Swift, C#/.NET, Rust) for one MCP tool surface. accesskit is an accessibility provider library, not a consumer, so it cannot be used for perception.
- **Fix:** One Rust MCP server: objc2 AXUIElement plus screencapturekit bindings (macOS), windows-rs UIAutomation plus Graphics.Capture (Windows), atspi plus PipeWire portal (Linux), xcap for screenshots. Approval-gated per-app allowlist.
- **Evidence:** PLAN P10-T3 'Swift AX + ScreenCaptureKit, C# UIAutomation, Rust atspi/PipeWire'.

## [LOW] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T4: confirmed Rust; consider sherpa-onnx as the single VAD+ASR+TTS engine
- **Risk:** Three separate engines (whisper.cpp, Silero, piper).
- **Fix:** whisper-rs plus Silero via ort is fine; alternatively sherpa-onnx (C API/Rust bindings), which bundles Silero VAD, Whisper/Paraformer ASR and piper/VITS TTS. Add a code-identifier hotword/prompt list derived from the index [POLY].
- **Evidence:** PLAN P10-T4.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T5: confirmed
- **Risk:** None.
- **Fix:** Keep Rust daemon with fencing-token leases.
- **Evidence:** PLAN P10-T5; SPEC D1.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T6: confirmed Yjs; use yrs in the daemon and on non-JS clients
- **Risk:** Kotlin, Lua and Elisp clients have no native Yjs.
- **Fix:** Yjs in TS. yrs (Rust) in the daemon as the authoritative doc. Non-JS editors sync through the daemon rather than embedding a CRDT.
- **Evidence:** PLAN P10-T6.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T7: confirmed as TS (vscode-languageserver) in core
- **Risk:** None.
- **Fix:** Implement in TS, because the intelligence lives in TS. Move to the daemon only if it becomes the owner.
- **Evidence:** PLAN P10-T7.

## [LOW] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T8: confirmed; specify `bun build --compile` for the TS core, no Rust launcher
- **Risk:** 'Reduced TS bundle' is unspecified, and a Rust launcher would add a layer without benefit.
- **Fix:** Build a bun --compile single executable per target for the core. cargo-dist handles sidecars with checksums at build time. The core discovers sidecars via optionalDependencies or a checksummed download.
- **Evidence:** PLAN P10-T8.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P10-T9: confirmed (X-2 evidence-gated)
- **Risk:** None.
- **Fix:** Keep it gated.
- **Evidence:** PLAN P10-T9; SPEC D12.

## [LOW] api-contract — common/src/util/language-capability-manifest.ts — [LANG] X-4: confirmed TS; the language manifest is not the full capabilities map
- **Risk:** The manifest carries only language/tool data. Sandbox tier, sidecar availability and LSP liveness have no versioned schema yet, so the initialize/doctor maps could diverge.
- **Fix:** Add a sibling CapabilitiesMapV1 Zod schema (sandbox tier, sidecars {name, version, tier}, lsp servers) that embeds LanguageCapabilityManifestV1 by version. Serialize it once for ACP initialize, /doctor and the status bar, with golden vectors.
- **Evidence:** language-capability-manifest.ts defines only {schemaVersion, languages}.

## [MEDIUM] error-handling — sdk/src/services/sidecar-supervisor.ts — [BEST] X-5: supervisor drops string ids, notifications and server→client requests, and has no liveness health check
- **Risk:** handleLine ignores messages whose id is not a number. JSON-RPC 2.0 allows string ids and notifications, and MCP/ACP sidecars send progress, logging notifications and reverse requests, all silently discarded. 'Health-checks' in the task are only exit detection: a hung sidecar is never restarted and only produces per-request timeouts. stderr String(chunk) can split multi-byte UTF-8.
- **Fix:** Stay in TS. Either adopt vscode-jsonrpc (StreamMessageReader/Writer, which handles notifications and bidirectional requests) under the existing restart/backoff shell, or add onNotification/onRequest handlers with string|number ids. Add a periodic `$/ping` with a deadline that triggers restartLoop on N misses. Decode stderr with StringDecoder. Add fake-sidecar tests for notification delivery, a string-id response, and a hang → restart.
- **Evidence:** sidecar-supervisor.ts handleLine: `if (typeof id !== 'number') return`. No heartbeat timer; restart only from handleChildGone. stderr uses `String(chunk)`.

## [MEDIUM] dependency-hygiene — sdk/src/services/sidecar-supervisor.ts — [LANG] X-5: checksum-verified artifact resolution is missing from the supervisor contract
- **Risk:** sidecarPath is an arbitrary path with no integrity check, so the first real sidecar may ship without verification.
- **Fix:** Add a resolveSidecarArtifact({name, version, sha256, source: optionalDependency|download}) step that verifies sha256 (and optionally a minisign signature) before spawn, and reports the result via X-4.
- **Evidence:** SidecarSupervisorOptions has only sidecarPath/args/env. PLAN X-5 defers this.

## [HIGH] correctness — agents/context-pruner.ts — [LANG] CQ-T1 (D28 remainder): LLMLingua-2 selection in the optional Python sidecar puts Python on the per-turn hot path, contradicting D2; run inference via ONNX in a Rust ort sidecar
- **Risk:** D2 says Python is 'never on the hot path', but compaction runs on hosted turns, so a missing or slow Python env would degrade every compaction. LLMLingua-2 is an XLM-R/BERT token classifier that exports cleanly to ONNX, so 'Python-native' is only true for training. The pruner is serialized handleSteps and cannot call a sidecar directly.
- **Fix:** Export llmlingua-2-xlm-roberta-large-meetingbank (or the bert-base-multilingual variant) to ONNX once, in Python. Serve token-keep probabilities from the shared Rust `ort` sidecar (X-5 supervised, CPU default, CoreML/CUDA EPs). Inject a `selectTokens` capability into the pruner via generatorParams, the same pattern as orchestrationControlPlane. Fail open to the current extractive path and report the 'compaction: extractive|lingua' tier. Python remains for fine-tuning.
- **Evidence:** run-programmatic-step.ts injects orchestrationControlPlane/semanticBudget into serialized generators. context-pruner.ts header: 'handleSteps is serialized (new Function) and cannot import'. SPEC D2 vs D28.

## [MEDIUM] correctness — agents/context-pruner.ts — [POLY] CQ-T1: LLMLingua-2 is trained on English meeting transcripts and will drop code tokens
- **Risk:** Token-level compression of code, paths, identifiers and non-English text corrupts exactly the must-survive evidence (file paths, symbols, error strings) in non-TS and non-English repos.
- **Fix:** Apply compression only to prose spans. Protect fenced code, tool-result JSON, paths and identifiers (tree-sitter/regex span mask) as force-keep. Add compaction-retention eval fixtures in Python, Rust, Go and CJK text with a recall floor per fixture.
- **Evidence:** context-pruner.ts pinned knowledge_memory and tool-facts carry paths/commands verbatim. D28 names LLMLingua-2.

## [MEDIUM] performance — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts — [BEST] memory-v2 query folds up to 10k events in JS per query while FTS5 is already probed
- **Risk:** query() re-reads up to 10,000 events / 8 MiB and re-folds every observation on each call (O(events) per query). The recorded fts5 capability is never used and search() returns unsupported.
- **Fix:** Stay in TS/bun:sqlite. Maintain an FTS5 contentless table over the memory_claims projection (summary/detail/selectors), updated in applyProjection. Rank with bm25() and fold only matched ids plus pinned entries. Keep the fold path as the fallback when fts5 is unavailable (P8-T8).
- **Evidence:** scanQueryRows MAX_QUERY_EVENTS 10_000 / MAX_QUERY_PAYLOAD_BYTES 8MiB; buildLexicalResult full fold; recordRuntimeCapabilities fts5 probe; search() → unsupported('semantic-search').

## [MEDIUM] correctness — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts — [POLY] memory-v2 lexicalTokens discards all non-ASCII text
- **Risk:** lexicalTokens lowercases, then splits on /[^a-z0-9._:/-]+/, so CJK/Cyrillic/accented identifiers, comments and queries produce no tokens and non-English memories are unrecallable.
- **Fix:** Tokenize with Unicode classes (/[^\p{L}\p{N}._:/-]+/u) plus Intl.Segmenter word segmentation for CJK. With FTS5, use the unicode61 or trigram tokenizer.
- **Evidence:** lexicalTokens(): `.split(/[^a-z0-9._:/-]+/)`.

## [MEDIUM] performance — packages/indexer/src/semantic.ts — [BEST] semantic search stores number[] vectors and recomputes both norms per comparison
- **Risk:** About 20k × 1536 boxed-double arrays per query recompute normB every time, and JSON number[] persistence is large. This is the D12 kernel candidate, but most of the cost is fixable in TS.
- **Fix:** Normalize vectors at build time and store them as Float32Array (binary blob or P6-T6a/sqlite-vec). Score with a plain dot-product loop over a contiguous Float32Array matrix, and use a top-k heap instead of full sort. Then re-measure before any napi SIMD kernel.
- **Evidence:** cosineSimilarity computes normA/normB per call; FileVector.vector: number[]; semanticSearch map+sort over all vectors.

## [LOW] api-contract — sdk/src/impl/embeddings.ts — [BEST] embedder cacheKey omits dimensions/encoding parameters
- **Risk:** A model served with a configurable output dimension (e.g. text-embedding-3 `dimensions`, Matryoshka local models) would reuse incompatible cached vectors; build-time dimension checks only drop mismatches silently per batch.
- **Fix:** Include the requested dimensions and any normalization flag in cacheKey, and record the vector dimension in the semantic fingerprint.
- **Evidence:** embeddings.ts cacheKey = {providerId, baseURL, providerModel}; semantic.ts getSemanticConfigFingerprint.

## Coverage receipt

### Subsystems
- .agents
- sdk
- cli
- common
- packages
- agents

### Features
- P7-T1
- P7-T2
- P7-T3
- P7-T4
- P7-T5
- P7-T6
- P7-T7
- P7-T8
- P8-T0
- P8-T1
- P8-T2
- P8-T3
- P8-T4
- P8-T4a
- P8-T5
- P8-T6
- P8-T7
- P8-T8
- P8-T9
- P8-T10
- P9-T1
- P9-T1a
- P9-T2
- P9-T3
- P9-T4
- P9-T5
- P9-T6
- P9-T7
- P9-T8
- P10-T1
- P10-T2
- P10-T3
- P10-T4
- P10-T5
- P10-T6
- P10-T7
- P10-T8
- P10-T9
- X-4
- X-5
- CQ-T1

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- sdk/src/services/sidecar-supervisor.ts
- common/src/util/language-capability-manifest.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- sdk/src/impl/embeddings.ts
- packages/indexer/src/semantic.ts
- agents/context-pruner.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- sdk/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
