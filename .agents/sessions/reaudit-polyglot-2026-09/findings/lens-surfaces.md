# Audit findings: lens-surfaces

- Subsystems: cli-tui, cli-commands, cli-platform-integration, sdk-public-api, mcp, dev-tooling-tmux-viewer
- Features: desktop-app, ide-integration-acp, session-replay-dashboard, mobile-remote-approval, voice-io, gui-automation, os-notifications, non-js-sdk, mcp-server-exposure, clipboard, terminal-images
- Files covered: 19
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] api-contract — sdk/src/client.ts:47 — S1: No out-of-process agent protocol (keystone blocker for every non-terminal surface)
- **Risk:** The only way to drive the agent is an in-process JS call: OpenbuffClient.run() -> run() with JS callbacks (handleEvent, handleStreamChunk, requestApproval). No wire protocol, no daemon, no session addressing. Desktop, IDE, mobile, web, Python/Go hosts all require embedding Bun/Node or reimplementing. Every surface finding below is blocked by this.
- **Fix:** Define a versioned JSON-RPC protocol (adopt ACP, Agent Client Protocol, as used by Zed; stdio + WebSocket transports) mapping 1:1 to RunOptions/PrintModeEvent/HarnessApprovalRequest. Implement the server first in TS (`openbuff serve --acp`) — TS can do this. Language only matters for the host process: a Rust daemon (tokio + axum + tokio-tungstenite) is preferable if it must be resident, multi-session, and a single static binary, but it is not required to unlock the feature. Generate schemas from the existing Zod definitions so all clients share one contract.
- **Evidence:** sdk/src/client.ts:47 `public async run(options) { return run({...this.options, ...options}) }` — in-process only; client.ts:32 docstring 'We will likely add a token-by-token streaming callback in the future'. sdk/src/run.ts:241 `requestApproval?: (request) => Promise<boolean>`, :243 `handleEvent?`, :244 `handleStreamChunk?` — all JS closures, non-serializable. code_search for McpServer/StdioServerTransport across cli/sdk/common: zero hits. Candidate: TS (ACP server) now; Rust daemon later. TS-capable: YES for protocol; Rust only for resident single-binary daemon.

## [HIGH] api-contract — sdk/src/run.ts:241 — S2: Approvals are a synchronous in-process callback — no remote/mobile approval, no approval queue
- **Risk:** HarnessApprovalService persists approvals to LocalHarnessStore (run.ts:850) but the request path is a host closure. A run started in a terminal cannot be approved from a phone, watch, desktop tray, or a teammate; a detached/background run blocks forever or must be pre-authorized via approvalReceiptIds. This is the single most valuable 'beyond the terminal' feature for long agent runs.
- **Fix:** Expose pending approvals as protocol objects (id, action, snapshot, expiry) over the S1 server, with push delivery. Mobile companion: Swift (SwiftUI + APNs, Live Activities / Dynamic Island for run progress, actionable notifications) and Kotlin (Jetpack Compose + FCM, Wear OS tiles). Pair via QR code containing an ephemeral key; relay E2E-encrypted (Noise/libsodium) through a dumb relay or Tailscale so local-first/BYOK holds. Native languages are REQUIRED for APNs/Live Activities/Wear; TS (React Native) could do a lesser version.
- **Evidence:** sdk/src/run.ts:236-241 approvalReceiptIds + approvalMode + `requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>`; run.ts:850 `new HarnessApprovalService(new LocalHarnessStore(resolvedHarnessStateDir))` — durable store exists, transport does not. Candidate: Swift/Kotlin native companion. TS-capable: partially (RN/PWA lacks Live Activities, reliable background push, watch).

## [HIGH] correctness — cli/src/index.tsx — S3: TUI capability ceiling — single alternate-screen React tree; no multi-pane, detach/attach, or multiple concurrent views of a run
- **Risk:** The whole product is one OpenTUI renderer in alternate-screen mode bound to one process; App mounts exactly one of ProjectPicker | ChatHistory | Chat. You cannot watch two agents side by side, detach and reattach (tmux-style), view a run from a second terminal, or render rich content (real images, HTML, charts, clickable diffs). The prior audit's 'keep TUI in TS + addons' only raises per-widget fidelity, not this structural ceiling.
- **Fix:** Split into headless engine (S1 server) + thin clients. Keep the OpenTUI client as one client (TS is fine). Add a desktop client: Tauri 2 (Rust shell, WebView UI reusing React components/remark renderer; ~10MB vs Electron) giving split panes, real image/diff/markdown rendering, tray, global hotkey, drag-drop, native menus. Detach/attach falls out of the daemon model for free.
- **Evidence:** cli/src/index.tsx (near end) `createCliRenderer({ backgroundColor:'transparent', exitOnCtrlC:false, screenMode:'alternate-screen' })` then `createRoot(renderer).render(<App/>)`; app.tsx renders ProjectPickerScreen OR AuthedSurface -> ChatHistoryScreen OR Chat (single key-remounted Chat). chat.tsx outline: one `function Chat` spanning L115-1870. command-registry.ts:78 RouterParams carries React MutableRefObjects/setState — command semantics are welded to the React tree. Candidate: Rust (Tauri) desktop shell. TS-capable: UI yes (Electron), but Tauri gives tray/updater/small binary natively.

## [HIGH] api-contract — common/src/mcp/client.ts:137 — S4: MCP is client-only; Openbuff cannot be consumed as an MCP server or ACP agent by IDEs/other agents
- **Risk:** Claude Desktop, Cursor, Zed, VS Code Copilot agent mode, and other agents cannot call Openbuff's unique capabilities (indexer queryIndex, code-map, workspace-mutation broker with receipts, audit-intelligence tools, memory-v2) — they are only reachable from inside Openbuff's own loop. Lost distribution channel.
- **Fix:** Ship `openbuff mcp` exposing a curated tool set (query_index, read_files with cap tokens, code_search, inspect_codebase_structure, memory search) via @modelcontextprotocol/sdk McpServer + StdioServerTransport. TS is the right language here (SDK exists, tools are TS). A Rust daemon would only matter to make the MCP server a zero-dependency binary.
- **Evidence:** common/src/mcp/client.ts:3-6 imports only Client + SSE/Stdio/StreamableHTTP *Client* transports; :137 `new Client({ name: 'codebuff', version: '1.0.0' })` (also still branded codebuff). packages/agent-runtime/src/mcp.ts:61 MCP tools are always `endsAgentStep: true` (consumption only). sdk/src/index.ts exports inspectCodebaseStructureTool/evaluateAuditCoverageTool etc. — ready-made server payloads. Candidate: TS. TS-capable: YES.

## [HIGH] api-contract — cli/src/utils/open-file.ts:126 — S5: IDE integration is fire-and-forget `code --goto` shell-outs — no bidirectional editor link
- **Risk:** Openbuff detects VS Code/Cursor/Zed only to spawn a shell command; it cannot read the editor's open buffers/selection/diagnostics, show inline diffs for approval in the editor, or let the user accept hunks there. Competitors (Claude Code IDE extension, Zed ACP) do this.
- **Fix:** On top of S1/ACP: VS Code/Cursor extension (TS — reuse SDK types), JetBrains plugin (Kotlin, IntelliJ Platform SDK; required — no TS path), Neovim plugin (Lua, msgpack-RPC/stdio JSON-RPC), Emacs (Elisp, jsonrpc.el), Zed (native ACP; extensions are Rust->WASM). Protocol: selection/diagnostics in, proposed edits + receipts out, hunk-level accept/reject.
- **Evidence:** cli/src/utils/open-file.ts:56-83 TERM_PROGRAM/VSCODE_PID/CURSOR_PORT/ZED_NODE_ENV detection -> `code --goto`, `cursor --goto`, `zed --add`; :102-124 `spawn(command, { shell:true, stdio:'ignore', detached:true })` — one-way, output discarded. Candidates: Kotlin (JetBrains), Lua (Neovim), Elisp, Rust/WASM (Zed ext), TS (VS Code). TS-capable: only for VS Code family.

## [MEDIUM] correctness — cli/src/utils/clipboard-image.ts:76 — S6: OS integration via shelling out (osascript/PowerShell/xclip) — fragile clipboard, no Wayland copy, no notifications, no drag-drop of rich data
- **Risk:** Every clipboard operation spawns a process (PowerShell cold start ~300ms-1s per paste; osascript with interpolated paths). Copy on Wayland is unsupported (xclip/xsel only), readClipboardText on Linux is xclip-only. No OS notifications exist at all (only OSC 0 title) — the user gets no signal when a 20-minute run finishes or needs approval unless they watch the terminal. Rich pastes (HTML, multiple files, screenshots with metadata) are lost.
- **Fix:** Rust napi addon using arboard (clipboard incl. images, Wayland via wl-clipboard-rs) + notify-rust / mac-notification-sys / winrt-notification (actionable notifications with 'Approve'/'Deny' buttons wired to S2) + tray-icon. Cheap wins in TS: OSC 9 / OSC 777 notifications and wl-copy fallback. Actionable native notifications need native code.
- **Evidence:** clipboard-image.ts:76,147 spawnSync('osascript', ...) with `set thePath to "${imagePath}"` interpolation; Windows paths spawn `powershell -STA` with System.Windows.Forms per call; Linux image read tries xclip then wl-paste but readClipboardText (end of file) uses xclip only. clipboard.ts:163-190 copy via execSync pbcopy / xclip / xsel / clip — no wl-copy. terminal-title.ts:37 only OSC 0 title; code_search for OSC 9/777, notify-send, terminal-notifier: zero hits. Candidate: Rust (arboard, notify-rust, tray-icon). TS-capable: partial (OSC 9/777, spawn notify-send) — no actionable notifications.

## [MEDIUM] correctness — scripts/tmux/tmux-viewer/README.md — S7: Session replay exists only as an internal dev tool over tmux text captures — no user-facing run replay/audit dashboard
- **Risk:** The team already built timeline/replay/GIF export (tmux-viewer) but it replays plain-text pane captures from debug/tmux-sessions for CLI tests. Users have no way to replay/share/inspect a past agent run (tool calls, diffs, approvals, token spend) outside the TUI /history screen. Enterprise/review use cases (what did the agent do while I was away?) are unserved.
- **Fix:** Persist the PrintModeEvent stream + mutation-broker receipts as an append-only session log (already mostly exists in journal/receipts) and serve a local web dashboard (`openbuff dash`, localhost-only + token) — TS/React is fine and reuses renderers. Optional: static HTML export for sharing. Language change not required; value comes from the protocol (S1).
- **Evidence:** tmux-viewer README: 'Interactive TUI for viewing tmux session logs', reads debug/tmux-sessions/{session}/capture-*.txt, --replay, --export-gif, --json 'for AIs'; integration section targets @cli-tester agent only. command-registry.ts 'history' -> openChatHistory (TUI-only). Candidate: TS (web) — or Rust if bundled into the Tauri shell. TS-capable: YES.

## [MEDIUM] api-contract — sdk/src/index.ts — S8: SDK is JS-only; Python/Go/JVM hosts cannot embed the agent
- **Risk:** The published surface (run, CodebuffFileSystem adapter, ToolHelpers, custom tools with Zod schemas, MemoryV2Coordinator, WorkspaceMutationBroker) is TS-typed and closure-based. Python (data/ML tooling, Jupyter), Go (infra CLIs, k8s operators), and CI systems cannot embed Openbuff without spawning Node and inventing an IPC.
- **Fix:** Do NOT port the engine. Generate thin clients over the S1 protocol: Python (pydantic models from JSON Schema, asyncio), Go (generated structs). Custom tools become protocol callbacks (tool/call reverse requests) so host-language tools work. A Rust core + PyO3/cgo would allow true in-process embedding, but only once the engine itself is native — not worth it for the SDK alone.
- **Evidence:** sdk/src/index.ts exports run, OpenbuffClient, createNodeFileSystem, custom-tool (Zod schemas), CodebuffFileSystem type closure 'consumed by external hosts' — all require a JS runtime. client.ts:12-25 handleEvent default throws inside JS. Candidate: Python/Go generated clients. TS-capable: server side YES; clients by definition other languages.

## [MEDIUM] security — cli/src/data/slash-commands.ts — S9: No GUI/native-app automation or screen perception — agent is blind outside the terminal and files
- **Risk:** Agents can run shell commands and read images the user attaches (/image, Ctrl+V), but cannot see or drive native apps (simulators, Xcode, game engines — slash-commands already ships Unity/Godot/Unreal/Bevy presets — browsers without CDP, design tools). This blocks 'verify the UI I just built' loops for desktop/mobile/game devs.
- **Fix:** Per-OS native helper exposed as MCP/tool server: macOS Swift (AXUIElement accessibility tree + ScreenCaptureKit), Windows C# (UIAutomation + Windows.Graphics.Capture), Linux (AT-SPI via Rust atspi crate / Python pyatspi, PipeWire portal screencast). Return accessibility trees as text (cheap tokens) plus screenshots. Must be gated by harness approvals (HarnessApprovalService) and per-app allowlists — high security risk. TS cannot call AX/UIA APIs directly.
- **Evidence:** slash-commands.ts: `image` 'Attach an image file (or Ctrl+V to paste from clipboard)' is the only visual input; getSlashCommandsWithSkills merges getGameDevSlashCommands(detectEngineProfiles(fileTree)) — engine workflows exist with no way to observe the running game/editor. sdk/src/index.ts exposes render3dPreview/inspect3dAsset (offline asset tools) but no screen/app tools. Candidate: Swift / C# / Rust(atspi). TS-capable: NO for OS accessibility APIs.

## [LOW] correctness — cli/src/commands/command-registry.ts — S10: Voice I/O absent; input model is keystrokes only
- **Risk:** No push-to-talk dictation or spoken status ('tests passed, need approval'). Hands-busy / accessibility users (RSI, low vision) are unserved; long prompts are slow to type.
- **Fix:** Local STT via whisper.cpp (C++; whisper-rs or napi binding) with VAD (silero), local TTS via piper (C++/ONNX). Audio capture needs cpal (Rust) or native APIs; Bun has no mic access. Deliver as an optional native addon or inside the Tauri shell; keep BYOK/local-first by defaulting to local models.
- **Evidence:** command-registry.ts ALL_COMMANDS: help, feedback, bash, diff, changes, exit, new, undo, redo, init, setup, models, provider, info, context, update, doctor, index, memory, image, mode:*, publish, connect, history, prompts, interview, plans... — no audio/voice entry; cli/package.json deps contain no audio library. Candidate: C++ (whisper.cpp, piper) via Rust bindings. TS-capable: NO (no mic capture / real-time inference in Bun).

## [LOW] correctness — cli/src/utils/terminal-images.ts:125 — S11: Image path is protocol-string generation only — materially new angle: images are a surface problem, not an addon problem
- **Risk:** Prior audit covered decode/resize/sixel addon. New point: even with a perfect addon, tmux/SSH/Windows Terminal users mostly get 'none' (detection is env-var only: TERM_PROGRAM/TERM/KITTY_WINDOW_ID), and kitty path hardcodes f=100 PNG. Screenshots, rendered 3D previews (render3dPreview), and diagrams from agent runs are fundamentally better shown in a desktop/web surface.
- **Fix:** Route rich media to the Tauri/web client when attached (S3/S7); keep terminal protocol as best-effort. Add terminal capability query (DA1/XTGETTCAP) instead of env sniffing — TS-capable.
- **Evidence:** terminal-images.ts:17-44 detection solely from env vars; :125-127 kvPairs 'a=T','f=100','t=d'; :197-200 sixel returns null. sdk/src/index.ts exports render3dPreview whose output has no good terminal destination. Candidate: Tauri (Rust) client. TS-capable: detection yes.

## Coverage receipt

### Subsystems
- cli-tui
- cli-commands
- cli-platform-integration
- sdk-public-api
- mcp
- dev-tooling-tmux-viewer

### Features
- desktop-app
- ide-integration-acp
- session-replay-dashboard
- mobile-remote-approval
- voice-io
- gui-automation
- os-notifications
- non-js-sdk
- mcp-server-exposure
- clipboard
- terminal-images

### Files
- .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md
- cli/src/index.tsx
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/commands/command-registry.ts
- cli/src/data/slash-commands.ts
- cli/src/components/review-screen.tsx
- cli/src/utils/clipboard.ts
- cli/src/utils/clipboard-image.ts
- cli/src/utils/terminal-images.ts
- cli/src/utils/terminal-title.ts
- cli/src/utils/open-file.ts
- cli/package.json
- sdk/src/index.ts
- sdk/src/client.ts
- sdk/src/run.ts
- common/src/mcp/client.ts
- packages/agent-runtime/src/mcp.ts
- scripts/tmux/tmux-viewer/README.md

### Domains
- api-contract
- correctness
- security
