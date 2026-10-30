# Audit findings: lens-plan-critique-extensibility

- Subsystems: polyglot-plan, native-core, sdk-extensibility, agent-templates, mcp, skills
- Features: plan-critique, report-citation-spotcheck, custom-tools, local-agents, mcp-config, skills, hooks, alternative-architecture
- Files covered: 22
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] api-contract — .agents/sessions/polyglot-native-waves/SPEC.md:5 — PC-1: The plan treats other languages only as accelerators behind frozen TS interfaces
- **Risk:** The Goal line puts every native component 'behind existing TS interfaces', and the Non-goals freeze run.ts, ToolResultOutput, ClientToolOverrides, and the agents/ templates. That caps what a new language can add at 'the same API, faster'. Most of the report's Q2 list (LSP, MCP server, daemon, plugin host, OS sandbox, embeddings) is new process topology or new trust boundaries, and none of it fits behind an unchanged in-process TS function signature. So the framing structurally postpones the features the audit said were the point.
- **Fix:** Rewrite the SPEC goal from 'native accelerators behind TS interfaces' to 'a versioned, language-neutral protocol boundary that any language can implement or consume'. Keep the existing TS APIs as one client binding of that protocol, not as the boundary itself.
- **Evidence:** SPEC.md:5 ('incrementally via napi-rs prebuilt modules behind existing TS interfaces'); SPEC.md:9-17 non-goals; AUDIT-REPORT.md Q2 section lists daemon/LSP/MCP/plugin host/sandboxing as the unlocks.

## [HIGH] dependency-hygiene — .agents/sessions/polyglot-native-waves/SPEC.md:50 — PC-2: Only one integration mechanism: Rust through napi, in-process
- **Risk:** The acceptance criteria require that every native module ship as a prebuilt per-platform .node package. That excludes Python (the ONNX, sentence-transformers, and tree-sitter-languages ecosystems, plus Aider-style tooling), Go (gopls, fast static binaries, strong sidecar tooling), and WASM. In-process napi also means a Rust panic or segfault takes down the TUI, there is no crash isolation, and each binding needs a 7-leg OS/libc matrix. Wave 0 already paid that cost (see PC-3). Local embeddings (R5e) are the clearest case: in Rust they need candle or ort bindings, while in Python they are a mature one-liner. The plan also never considers sidecar processes, stdio/JSON-RPC, or WASM as alternatives.
- **Fix:** Add an integration-mechanism decision matrix to the SPEC. Use napi only for sub-millisecond, chatty, in-UI kernels (fuzzy match, highlight spans). Use sidecars over stdio JSON-RPC or MCP for coarse capabilities (index, embeddings, PTY, LSP bridges), in whichever language fits best. Use WASM components for untrusted or portable plugins. Allow Python and Go sidecars explicitly.
- **Evidence:** SPEC.md:50 ('Every native module ships as a prebuilt per-platform .node package (napi-rs optionalDependencies pattern)'); native-core-build.yml matrix has 7 targets incl. 2 musl cross legs; Cargo.toml:13 napi only.

## [HIGH] correctness — .agents/sessions/polyglot-native-waves/STATUS.md:36 — PC-3: Wave 0 took 4 repair rounds to prove a stripAnsi that a JS fallback already did correctly
- **Risk:** The Wave 0 deliverable is version(), stripAnsi(), and countBytes(). countBytes is just Buffer.length and needs no native code. To keep native and JS byte-identical, the project needed 4 rounds: u64/BigInt plus the napi8 feature, a canonicalizeInput lossy-UTF-8 pass, a default-arm ESC contract, libc triple fall-through, and a musl '--gnu' malformed-triple bug. The wrapper grew to 410 lines for 3 trivial exports. That is strong evidence that the dual-implementation parity model (every feature exists twice: native plus a JS fallback that must match byte for byte) multiplies cost with every export. Wave 1 through 3 each add larger surfaces (tokenizer, ripgrep, tantivy, tree-sitter) under the same rule.
- **Fix:** Stop requiring byte-identical dual implementations for each export. For sidecar capabilities, the fallback is 'capability not advertised' (graceful feature absence), not a second implementation. Reserve parity mirrors for the few in-process kernels where the TS path is the real product. Track rework cost per wave as a gate.
- **Evidence:** STATUS.md:36-57 rounds 2-4; index.ts:1-410 (loader, isNativeBinding probe, tripleCandidatesFor regex fix at ~:106, canonicalizeInput, utf8CodePointLength mirror); lib.rs:156 count_bytes returns input.len().

## [HIGH] correctness — .agents/sessions/polyglot-native-waves/PLAN.md:33 — PC-4: No user-visible feature ships until Wave 4, and the first wins do not need a new language
- **Risk:** Waves 0 through 3 are internal swaps with no visible change, validated by 'tests pass unchanged'. The first visible item (W4-2 syntax highlighting) is also blocked behind the W4-1 styled-span protocol. Yet syntax-highlighter.tsx:9-18 is a stub that could be filled today from TS: the web-tree-sitter grammars and .scm queries already ship, and shiki also exists. semantic-search returns unsupported at bun-sqlite-memory-repository.ts:1553, but bun:sqlite already bundles FTS5. The plan therefore delays value while buying it the most expensive way.
- **Fix:** Reorder so each phase ships something users can see. Examples: highlighting through the existing tree-sitter WASM, and FTS5-backed memory search on bun:sqlite. Add native code only where a benchmark shows TS cannot meet a latency budget.
- **Evidence:** PLAN.md:13-33 (W1-W3 all 'tests pass unchanged'); PLAN.md:35-36 W4-1 gating; cli/src/utils/syntax-highlighter.tsx:9-18 stub; cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1553 unsupported('semantic-search').

## [HIGH] api-contract — .agents/sessions/polyglot-native-waves/PLAN.md:44 — PC-5: The architectural pivot (daemon, LSP, MCP server, plugin host) comes last, which forces a rewrite
- **Risk:** W5-1 (index daemon) depends on W2-3, and W5-4 depends on W2-1 and W3-2. The plan therefore builds the tantivy index, the store, and the parser as in-process napi modules first, then re-hosts them into a daemon later. That means redoing IPC, lifecycle, and locking. It even plans to port the hand-rolled lock/CAS tests verbatim (W2-3) that a daemon would eliminate by construction. Committing to process topology last means paying for the boundary twice.
- **Fix:** Decide process topology first. Define a protocol, then host the index as a sidecar speaking it from day one. The in-process lock/CAS port becomes unnecessary.
- **Evidence:** PLAN.md:23 W2-3 'port lock/CAS tests verbatim'; PLAN.md:44 W5-1 'lock machinery tests replaced by daemon lifecycle tests'; PLAN.md:50 dependencies.

## [MEDIUM] test-coverage — .github/workflows/native-core-build.yml:116 — PC-6: CI never runs the native path it builds
- **Risk:** The test job installs no artifacts and runs only the pure-JS fallback. Its own comment says 'no native artifact is required here'. Native-versus-fallback parity tests are skipped when the native binary is absent, so the parity contract the 4 repair rounds defended is never exercised in CI. The prebuilds are also never published (README: 'follow-up wave'), so no user can receive the native path.
- **Fix:** Add a matrix test job that downloads each build artifact and runs bun test with nativeAvailable asserted true. Otherwise acknowledge that the native path has no CI coverage.
- **Evidence:** native-core-build.yml:116-135 test job with comment 'Runs the pure-JS fallback path; no native artifact is required here'; packages/native-core/README.md:33-38 publishing deferred; STATUS.md:17 parity tests conditional 'when native is available'.

## [MEDIUM] correctness — .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md:17 — PC-7: Report citation spot-check: 3 of 5 accurate, 1 wrong line, 1 not verifiable at the cited line
- **Risk:** The SPEC and PLAN inherit the report's claims as requirements. Spot-checks: (a) syntax-highlighter.tsx:9 stub is accurate (lines 9-18). (b) token-counter.ts:46 is accurate: MAX_BPE_ENCODE_CHARS=100_000, with the 20k sample at :56. (c) query.ts:417 is accurate: scoreFile is at 417. (d) The memory-v2 cite is wrong. Line :2670 is event-normalization metadata; unsupported('semantic-search') is at :1553. (e) terminal-images.ts:155 is kitty multi-chunk encoding, not the sixel null path; sixel handling is at :37/:196/:218, and its null return was not verified here. Beyond line numbers, the report also frames 'MCP server' as a Wave 5 native unlock and never mentions that a full MCP client already exists (stdio, SSE, and streamable HTTP) in common/src/mcp/client.ts. That omission misses the most important existing language-neutral extension point.
- **Fix:** Correct the citations (memory :1553; terminal-images sixel lines). Add an 'existing extension surfaces' section noting the MCP client, the QuickJS sandbox, and skills.
- **Evidence:** cli/src/utils/syntax-highlighter.tsx:9-18; packages/agent-runtime/src/util/token-counter.ts:46,56; packages/indexer/src/query.ts:417; cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1553 vs :2670; cli/src/utils/terminal-images.ts:37,155,196,218; common/src/mcp/client.ts:3-6.

## [HIGH] api-contract — sdk/src/custom-tool.ts:9 — EXT-1: Custom tools must be in-process TypeScript closures with Zod schemas
- **Risk:** CustomToolDefinition requires a zod/v4 ZodType inputSchema and an in-process execute() that returns ToolResultOutput[]. A Python or Go author has only one route: an MCP server, which the agent must list in mcpServers. There is no first-class 'tool manifest plus executable' form, and no JSON Schema input path in the SDK API itself. Tools also share the host process, so there is no isolation or timeout boundary beyond the AbortSignal.
- **Fix:** Accept a language-neutral tool descriptor: a JSON Schema inputSchema plus a transport of in-process, mcp-stdio, jsonrpc-stdio, or wasm-component. Make the Zod helper sugar that compiles to that descriptor. Generate Python and Go SDK types from the same schema pipeline (compile-tool-definitions).
- **Evidence:** sdk/src/custom-tool.ts:9-25 (inputSchema: z.ZodType; execute: (params)=>Promise<ToolResultOutput[]>); :37-76 getCustomToolDefinition.

## [HIGH] api-contract — sdk/src/agents/load-agents.ts:122 — EXT-2: Agents can only be JS/TS modules executed via import(), with no declarative or other-language form
- **Risk:** agentFileExtensions is .ts/.tsx/.js/.mjs/.cjs, loaded through dynamic import(), so agent files are executable code. That is why project agents require includeProjectAgents opt-in. A purely declarative agent (YAML/JSON/TOML) cannot exist, even though DynamicAgentDefinitionSchema is almost entirely data. Programmatic handleSteps must be a JS generator: it is stringified and later run in QuickJS. A Python or Go agent-step author has no path at all.
- **Fix:** Support agent.yaml/agent.json validated by DynamicAgentDefinitionSchema. Declarative agents are then safe to load from projects without trust opt-in. Add a 'handleSteps' transport that drives the step generator over JSON-RPC (a subprocess yields tool calls and receives results) or through a WASM component export. This keeps the QuickJS sandbox for JS and opens other languages.
- **Evidence:** sdk/src/agents/load-agents.ts:122 agentFileExtensions; :160-170 default dirs + includeProjectAgents; :282-291 handleSteps.toString(); :385-388 import() with cache-bust; sdk/package.json:62 @jitl/quickjs-wasmfile-release-sync; packages/agent-runtime/src/__tests__/sandbox-generator.test.ts:21,100 QuickJS sandbox.

## [MEDIUM] security — sdk/src/agents/load-mcp-config.ts:129 — EXT-3: MCP is the only polyglot extension path, and it has no registry, pinning, integrity check, or sandbox
- **Risk:** mcp.json is the one place a non-TS extension can plug in, and it is language-neutral, which is good. But servers are arbitrary 'command' spawns with the user's full environment access ($VAR resolution from process.env). There is no version pinning, no checksum, no capability grants, and no OS sandbox. The async and sync loaders also duplicate about 70 lines of merge logic. Making MCP the polyglot backbone therefore also needs a trust model.
- **Fix:** Add a lockfile (server id, version, sha256), a declared-capabilities field (fs scopes and network), and run spawned servers under the planned OS sandbox. Factor the shared merge logic out of the sync and async loaders.
- **Evidence:** sdk/src/agents/load-mcp-config.ts:41-42 processEnv; :44-72 resolveMcpEnv; :129-203 async loader; :211-278 duplicated sync loader; common/src/mcp/client.ts:3-6 stdio/SSE/HTTP transports.

## [MEDIUM] api-contract — sdk/src/skills/load-skills.ts:96 — EXT-4: Skills are prompt-only markdown with no executable or hook component, and the agent schema has no hooks
- **Risk:** SkillDefinition carries only name, description, license, metadata, content, and filePath. A skill cannot bundle a script in any language. DynamicAgentDefinitionSchema has no hooks, events, or lifecycle field (pre-tool, post-edit, on-stop). Hooks, the most common cross-language extension users want (for example a formatter or linter in Go or Python), have no declarative home. The starter template and create-cli-agent wrap other CLIs (Claude Code, Codex) by tmux screen-scraping (terminalPermissionProfile 'tmux-test') rather than through a protocol such as ACP.
- **Fix:** Add a hooks field (event, then a command, MCP tool, or WASM export, plus a JSON stdin/stdout contract) usable from agents, skills, and a project config. Let SKILL.md reference bundled scripts executed through the same hook runner. Replace tmux scraping of external CLIs with ACP or JSON-RPC where the target supports it.
- **Evidence:** sdk/src/skills/load-skills.ts:96-103 skill shape; common/src/types/dynamic-agent-template.ts:112-244 (no hooks field); .agents/lib/create-cli-agent.ts:68-76 tmux-test profile + run_terminal_command; common/src/templates/initial-agents-dir/my-custom-agent.ts:9-11 'codebuff publish' (TS-only authoring/publish path).

## [HIGH] api-contract — .agents/sessions/polyglot-native-waves/PLAN.md:1 — ALT-12: Alternative: protocol-first openbuff-core, thin clients, per-capability sidecars, WASM plugins, and a roadmap where every phase ships a feature
- **Risk:** Without a protocol-first redesign, the waves deliver a faster but equally closed TS monolith. Extensions stay TS-only, integrations stay scraped, and the value the report identified (LSP, MCP, daemon, plugins, sandboxing) arrives last or never.
- **Fix:** ARCH: (1) openbuff-core first stays a TS/Bun process. It owns sessions, the agent loop, tools, cap.v3, and the broker, and speaks versioned JSON-RPC 2.0 (ACP-compatible, version negotiated in initialize) over stdio or a unix socket. The schema is generated from Zod. (2) Thin clients: the OpenTUI CLI, editors via ACP, CI, and generated Python/Go SDKs. (3) Capabilities are MCP or JSON-RPC sidecars in their best language (a Rust indexer, Python embeddings, Go LSP bridges), supervised by core. (4) WASM components (WIT world openbuff:plugin, run on wasmtime or jco) for untrusted plugins with capability grants. (5) napi only for sub-millisecond TUI kernels. ROADMAP: P1 publishes the protocol spec, `openbuff serve --stdio`, and the CLI as a client; it ships headless/CI mode and editor attach. P2 adds declarative agent.yaml, hooks, and MCP lockfiles; it ships Python/Go tools and hooks. P3 ships a Rust index sidecar (tantivy+notify) with live search. P4 ships generated Python/Go SDKs with agent-step over RPC. P5 ships a WASM plugin registry. P6 ships an OS sandbox for tools and sidecars. P7 ships highlighting and fuzzy matching via napi or WASM kernels.
- **Evidence:** Synthesis of PC-1..PC-7 and EXT-1..EXT-4; existing assets that make this cheap: common/src/mcp/client.ts (MCP transports), QuickJS sandbox (sdk/package.json:62), Zod tool codegen (common/src/tools/compile-tool-definitions.ts per SPEC.md:16).

## Coverage receipt

### Subsystems
- polyglot-plan
- native-core
- sdk-extensibility
- agent-templates
- mcp
- skills

### Features
- plan-critique
- report-citation-spotcheck
- custom-tools
- local-agents
- mcp-config
- skills
- hooks
- alternative-architecture

### Files
- .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md
- .agents/sessions/polyglot-native-waves/SPEC.md
- .agents/sessions/polyglot-native-waves/PLAN.md
- .agents/sessions/polyglot-native-waves/STATUS.md
- packages/native-core/Cargo.toml
- packages/native-core/src/lib.rs
- packages/native-core/index.ts
- packages/native-core/README.md
- .github/workflows/native-core-build.yml
- sdk/src/custom-tool.ts
- sdk/src/agents/load-agents.ts
- sdk/src/agents/load-mcp-config.ts
- sdk/src/skills/load-skills.ts
- common/src/types/dynamic-agent-template.ts
- common/src/templates/initial-agents-dir/my-custom-agent.ts
- .agents/lib/create-cli-agent.ts
- packages/agent-runtime/src/__tests__/sandbox-generator.test.ts
- cli/src/utils/syntax-highlighter.tsx
- packages/agent-runtime/src/util/token-counter.ts
- packages/indexer/src/query.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/utils/terminal-images.ts

### Domains
- api-contract
- correctness
- dependency-hygiene
- security
- test-coverage
