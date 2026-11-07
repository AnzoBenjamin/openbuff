# P1-T1 Design: `openbuff serve` on ACP v1 + Openbuff extensions (ext v1)

Status: DRAFT rev 3, 2026-09-26. Implements PLAN.md P1-T1, which rests on locked decision D9 (adopt ACP v1 with namespaced Openbuff extensions).

Rev 2 adds §12, the normative security hardening that answers advisory review SEC-1…SEC-9, and §13, which records the verified facts behind it. Rev 3 adds §12.8, which answers the second review (NEW-1…NEW-7), and brings §2 and §5 in line with §12. Where §12 conflicts with earlier sections, §12 wins.

Sources:
- ACP v1 spec at agentclientprotocol.com/protocol/v1: schema, initialization, prompt-turn, tool-calls, extensibility, cancellation.
- `@agentclientprotocol/sdk` 1.x, using the fluent `agent()` API. The `AgentSideConnection` API is deprecated.
- Openbuff contracts, read live:
  - `sdk/src/run.ts:221-318`: `OpenbuffClientOptions` and `FilesystemMutationEvent`.
  - `common/src/types/print-mode.ts`: 20 `PrintModeEvent` variants.
  - `common/src/tools/results/filesystem.ts:112-480`: `FileMutationResultV1` and `CommitReceiptV1`.
  - `sdk/src/services/harness-enforcement.ts:112-131`: `HarnessApprovalRequest`.
  - `agents/base2/gate-state.ts:203-276`: `Base2GateState`.

## 1. Goals / non-goals

**Goals**
- Any ACP v1 client (Zed, JetBrains AI Assistant, Neovim CodeCompanion/avante, Emacs agent-shell, VS Code ACP extensions) can drive Openbuff with no Openbuff-specific code.
- Clients that know about Openbuff also get receipts, a capability map, lanes and gate state through the official ACP extension points: `_meta` and methods prefixed with `_`.
- The wire is deterministic, versioned, and pinned by golden vectors (§8).

**Non-goals for v1**
- Remote HTTP/WebSocket transport. Upstream still marks it WIP.
- Delegating writes or terminals to the client (§4.3).
- Lane creation and landing. Those are reserved and arrive in P6.
- Changing any existing SDK or TUI API. `OpenbuffClient.run()` stays as it is; the ACP agent is a new client of it.

## 2. Transport & process model

- `openbuff serve --stdio` is the default and is what editors launch.
  - Framing is ACP stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
  - Logs go to stderr and the log file, never stdout.
- `openbuff serve --socket[=PATH]` is an Openbuff extension transport.
  - Default path: `$XDG_RUNTIME_DIR/openbuff/<projectHash>.sock`, falling back to `~/.config/openbuff/run/`.
  - The directory is 0700 and the socket 0600.
  - Peer credentials (SO_PEERCRED / LOCAL_PEERCRED) are best-effort defense in depth. Node and Bun `net` do not expose them without a native addon, so the security argument rests on the verified 0700 directory plus the token (§12.2), not on peer-cred.
  - The first message must be `initialize` with `_meta["openbuff.dev"].socketToken`, matching a token file that is 0600 and rotated every time the server starts. Anything else closes the connection.
  - No TCP listener in v1.
- A server process has one project root. It can host many sessions, and each session wraps one `OpenbuffClient` run chain (`previousRun`).
- On shutdown (stdin EOF, SIGTERM, or the last socket client leaving with `--exit-when-idle`):
  - abort active runs,
  - flush pending updates,
  - answer each open `session/prompt` with `stopReason: "cancelled"`.

## 3. Initialization & negotiation

### 3.1 ACP version
- Accept `protocolVersion: 1`. For any other value, respond with `1`; the ACP rule is that the agent returns the latest version it supports.
- `agentInfo`: `{name:"openbuff", title:"Openbuff", version:<cli version>}`.

### 3.2 Openbuff extension negotiation (ext v1)
- **Client side.** A client that understands the extensions sends `clientCapabilities._meta["openbuff.dev"]`:
  - `{extVersion:1, extensions:["capabilities","receipts","lanes","gate","events"], events?:"acp"|"full"}`.
  - A plain ACP client sends nothing and gets pure ACP behavior.
- **Agent side.** The agent responds with `agentCapabilities._meta["openbuff.dev"]`:
  - `{extVersion:1, extensions:<intersection of requested and supported>, capabilities:CapabilityMapV1}`.
  - Extensions the client did not request are never emitted. Extension notifications are sent only for enabled extensions.
- **Versioning.**
  - `extVersion` is independent of the ACP `protocolVersion`.
  - v1 may only grow by adding optional fields.
  - Unknown `_meta` keys and unknown `_openbuff.dev/*` notifications MUST be ignored.
  - Any breaking change becomes `extVersion: 2`, negotiated as min(client max, agent max).

### 3.3 Agent capabilities advertised (P1)
- `loadSession: true`. Loading replays the persisted chat history (§4.1). Mid-step resume comes with the P2 journal and is advertised as `sessionCapabilities.resume` from P2 on.
- `promptCapabilities: {image:true, audio:false, embeddedContext:true}`.
- `mcpCapabilities: {http:true, sse:true}`. The existing MCP client supports stdio, SSE and HTTP (`common/src/mcp/client.ts`).
- `sessionCapabilities: {list:{}, close:{}}`.
- `authMethods`:
  - `[]` for BYOK, since keys come from `openbuff.json` or the environment.
  - Add `{id:"chatgpt-oauth", name:"Sign in with ChatGPT", type:"terminal", args:["login","chatgpt"]}` only when `clientCapabilities.auth.terminal === true`.

## 4. ACP method mapping

### 4.1 Client → agent

| ACP method | Openbuff implementation | Notes |
|---|---|---|
| `initialize` | Build CapabilityMapV1 (X-4); negotiate ext | §3 |
| `authenticate` | `chatgpt-oauth` is terminal-type, so a client MUST NOT send it. Any other methodId returns -32602 | BYOK has no agent-side auth |
| `session/new {cwd, mcpServers, additionalDirectories?}` | Validate that `cwd` is absolute and equals, or is inside, the server's project root; otherwise return -32602. Create a session record, then tag each `mcpServers` entry `origin:"client"` and admit it only under §12.3. On a name clash the project entry wins. Return `sessionId`, `modes` and `configOptions` | `sessionId` = `obs_` + 26-char ULID |
| `session/load {sessionId, cwd, mcpServers}` | Load RunState and chat history (`cli/src/utils/run-state-storage.ts`, `chat-history-store`). Replay the history as `user_message_chunk` / `agent_message_chunk` / `tool_call` (status final) updates, then respond | Replay drops reasoning and contains no receipts or capabilities (redaction §6.2) |
| `session/list` | Chat-history index filtered by `cwd` | `nextCursor` = opaque base64url offset |
| `session/close` | Abort the run and release its MCP clients | |
| `session/prompt {sessionId, prompt}` | `client.run({prompt, content, previousRun, agent: mode→agentId, signal})`. The ContentBlock mapping is in §4.4. Returns `{stopReason}` (§4.5) | One active prompt per session; a second concurrent prompt returns -32600 with `data["openbuff.dev"].code = "prompt_in_flight"` |
| `session/cancel` (notification) | `AbortController.abort()` on the active run. Pending `request_permission` resolves to cancelled | The prompt answers with `stopReason:"cancelled"`, not an error |
| `session/set_config_option` | `mode` → agent id; `model` → per-session model route override; `thought_level` → reasoning effort | Always returns the full `configOptions` |
| `session/set_mode` (deprecated in ACP) | Alias of `set_config_option(configId:"mode")` | Kept because some clients only use modes |

**Config options returned by `session/new`**

- `{id:"mode", category:"mode", type:"select", currentValue:"default", options:[default, plan, max, fast, …]}`
  - The option list is derived from the mode registry; the values are the ids used by the CLI's agent-mode toggle.
- `{id:"model", category:"model", type:"select", currentValue:<route default>, options:<openbuff.json routes>}`
- `{id:"thought_level", category:"thought_level", type:"select", currentValue:"auto", options:[auto, low, medium, high]}`

`modes` mirrors the `mode` option for older clients.

### 4.2 Agent → client

| Openbuff source | ACP message | Mapping |
|---|---|---|
| `text` | `session/update` `agent_message_chunk` | `messageId` = the run id of the emitting agent. Subagent text goes out only when events=`full`, carrying `_meta["openbuff.dev"].agentId/parentAgentId` |
| `reasoning_delta` | `agent_thought_chunk` | Root agent only, unless events=`full` |
| `tool_call` | `tool_call` | `toolCallId` = Openbuff toolCallId; `title` from the tool registry display label; `kind` per §4.6; `status:"pending"` (or `pending` + `_meta.queued`); `rawInput` = input after `sanitizeOutbound` (§12.1); `locations` from path params, made absolute |
| `tool_start` | `tool_call_update {status:"in_progress"}` | |
| `tool_result` | `tool_call_update {status:"completed"\|"failed", content}`. `rawOutput` is never emitted (§12.1) | `failed` when the output carries `errorMessage`, or a mutation outcome ∉ {applied}. Mutations add `diff` content when before and after text are available (`afterContent` present), plus a receipt envelope in `_meta` (§6.2) |
| `write_todos` result | `plan {entries}` | Todo → `{content: task, priority:"medium", status: completed?"completed":"pending"}`. The first incomplete todo becomes `in_progress` |
| `subagent_start` / `subagent_finish` | `tool_call` / `tool_call_update` on the parent's spawn `toolCallId` | Child agents are nested content, not new sessions. `_meta["openbuff.dev"].agent = {agentId, agentType, displayName}` |
| `context_window`, `finish.totalCost` | `usage_update {used, size, cost:{amount, currency:"USD"}}` | Cost is local estimation only |
| `error` with `autoRecovering:true` | not emitted | Matches the TUI contract (`print-mode.ts:22-28`) |
| `error` (terminal) | JSON-RPC error on `session/prompt` (-32603, `data["openbuff.dev"].message = userMessage ?? message`) | |
| `HarnessApprovalRequest` (`requestApproval`) | `session/request_permission` | §5 |
| `ask_user` | `elicitation/create` (form mode) when `clientCapabilities.elicitation.form`; otherwise the `_openbuff.dev/ask_user` request when the `events` ext is enabled; otherwise the tool returns a skipped result | Never blocks forever: honors cancel |
| gate state change | `_openbuff.dev/gate_state` notification | §6.4 (gate ext) |
| capability change | `_openbuff.dev/capabilities_changed` notification | §6.1 |
| `job_update`, `provider_status`, `phase`, `context_compaction*`, `memory_reuse`, `download` | `_openbuff.dev/event {sessionId, event: PrintModeEvent}` | Only when events=`full`. Restricted to exactly the variants named in this row, never `tool_call` or `tool_result`, and always passed through `sanitizeOutbound` (§12.1) |

### 4.3 Client fs/terminal capabilities: deliberately not used for writes/exec in v1

- Openbuff's safety model lives in its own process:
  - cap.v3 read authority,
  - CAS broker receipts,
  - the terminal policy, and the P5 sandbox.
- `fs/write_text_file` and `terminal/create` would bypass that model. At best they yield `unconfirmed` mutations (`verifyExternalMutation`).
- v1 rule: the agent executes all tools locally and never calls `fs/write_text_file` or `terminal/*`.
- Optional, opt-in via `_meta["openbuff.dev"].fsMode:"editor-overlay"` in `session/new`:
  - `read_files` consults `fs/read_text_file` for paths the client reports as open, so the agent sees unsaved buffers.
  - A read served from an overlay never mints edit authority. Its cap.v3 is `read_only`, and an edit requires an on-disk re-read.
  - Deferred to P7-T1 unless trivial.

### 4.4 Prompt ContentBlock → Openbuff input

| ContentBlock | Openbuff |
|---|---|
| `text` | Concatenated into `prompt`, joined with blank lines, in order |
| `image {data, mimeType}` | `content: ImageContent {type:"image", image:data, mediaType:mimeType}` |
| `resource {resource:{uri, text}}` | `file://` URI inside the project: attached as a file context block with path + text. Outside the project: attached as quoted context and marked untrusted |
| `resource {resource:{uri, blob}}` | Images → ImageContent. Other types are rejected with -32602 |
| `resource_link {uri, name}` | `file://` inside the project: path mention, and the agent reads it with its own tools. Anything else: text `"[link] name <uri>"` |
| `audio` | -32602, since `promptCapabilities.audio = false` |

### 4.5 Stop reasons

| Openbuff outcome | `stopReason` |
|---|---|
| Run finished normally (`finish`) | `end_turn` |
| `maxAgentSteps` exhausted | `max_turn_requests` |
| Context-overflow terminal failure | `max_tokens` |
| Aborted by `session/cancel` or shutdown | `cancelled` |
| Provider refusal (content-filter finish reason) | `refusal` |
| Any other run error | JSON-RPC error (not a stopReason) |

### 4.6 Tool `kind` mapping (single table in code, test-pinned)

- `read`: read_files, read_outline, read_subtree, read_image, read_logs, list_directory, git_status, inspect_*
- `search`: code_search, glob, query_index, find_files, find_files_matching_content
- `edit`: str_replace, write_file, edit_transaction, replace_range, rewrite_symbol, create_plan, update_plan_status
  - A mutation whose only action is `delete` → `delete`.
  - A mutation whose only action is `move` → `move`.
- `execute`: run_terminal_command, run_file_change_hooks, run_targeted_validation, kill_job
- `fetch`: web_search, read_docs, browser_logs
- `think`: think_deeply
- `other`: everything else, including spawn_agents and MCP/custom tools

## 5. Approvals → `session/request_permission`

- `requestApproval(req: HarnessApprovalRequest)` becomes `session/request_permission`:
  - `toolCall`: `{toolCallId: <the pending run_terminal_command call>, title: "Approve <action>: <target>", kind:"execute", status:"pending"}`
  - `options`:
    - `{optionId:"allow_once", name:"Allow once", kind:"allow_once"}`
    - `{optionId:"reject_once", name:"Deny", kind:"reject_once"}`
  - `_meta["openbuff.dev"].approval`: `{action, target, branch?, risk, reason, scope:{workspaceId, runId, snapshotId}}`
- There are no `allow_always` or `reject_always` options. Openbuff approvals are one-shot and bound to a snapshot (`harness-enforcement.ts`, and P0-T2 one-shot tokens). Any `optionId` other than exactly `allow_once`, including a fabricated `allow_always`, resolves `false` (§12.4).
- Outcome mapping:
  - `{outcome:"selected", optionId:"allow_once"}` → `true`
  - anything else → `false`
  - `{outcome:"cancelled"}` → `false`
  - transport loss → `false` (fail closed)
- Timeout: `serve.approvalTimeoutMs` (default 30 min) resolves `false`. `session/cancel` and owner disconnect also resolve it as cancelled (§12.4).

## 6. Openbuff extensions (namespace `openbuff.dev`, ext v1)

Conventions:
- Extension methods are named `_openbuff.dev/<area>/<verb>` and extension notifications `_openbuff.dev/<area>`.
- `_meta` payloads live under the single key `"openbuff.dev"`.
- An extension request that is not negotiated, or whose capability is off, returns -32601. That is the ACP rule for unknown extension methods.
- Openbuff error detail goes in `error.data["openbuff.dev"] = {code, ...}`.

### 6.1 `capabilities`

```ts
CapabilityMapV1 = {
  kind: 'openbuff.capabilities', version: 1,
  generation: number,            // increments on every change
  sandbox: { tier: 'lexical' | 'landlock' | 'landlock+seccomp' | 'seatbelt' | 'appcontainer' | 'microvm',
             enforced: boolean,  // false for 'lexical': never overstated (SPEC principle 6)
             network: 'unrestricted' | 'allowlist' | 'none' },
  index:   { state: 'absent' | 'building' | 'ready' | 'stale', files?: number },
  lsp:     Array<{ language: string, server: string, state: 'starting' | 'ready' | 'failed' }>,
  sidecars:Array<{ id: string, version: string, state: 'ready' | 'degraded' | 'failed' }>,
  lanes:   { supported: boolean },           // false until P6
  journal: { resume: boolean, replay: boolean }, // false until P2
  gate:    { enabled: boolean },
}
```

- Advertised in `initialize` and returned by `_openbuff.dev/capabilities/get {}`.
- Pushed as `_openbuff.dev/capabilities_changed {capabilities}`, rate-limited to one push per 250 ms and always sending the full map.

### 6.2 `receipts`

- Attached to the `tool_call_update` of every file-mutating tool as `_meta["openbuff.dev"].receipt: ReceiptEnvelopeV1`.
- Fetchable afterwards with `_openbuff.dev/receipts/get {sessionId, receiptId}` → `{receipt: ReceiptEnvelopeV1}`, or -32002 if unknown.

```ts
ReceiptEnvelopeV1 = {
  kind: 'openbuff.receipt_envelope', version: 1,
  sessionId: string, toolCallId: string, laneId: 'main',
  mutation: WireFileMutationResultV1,   // redacted projection, below
}
```

**Redaction (normative).** `WireFileMutationResultV1` is `FileMutationResultV1` with these changes:
- Each action DROPS `afterContent`, `patch` and `editAnchor`. Text content travels only in ACP `diff` content, which the client needs anyway.
- `freshCapabilities` becomes `[]`.
- `authorityReceipt` is kept verbatim. CommitReceiptV1 holds only ids, hashes and statuses.
- Paths stay project-relative, as in the internal contract. ACP `diff.path` and `locations` are absolute.

Why redact:
- cap.v3 tokens are process-scoped HMAC authorities and MUST NEVER leave the core.
- `afterContent` duplicates the diff and can be large.

The ext zod schema enforces this: `.strict()` action objects, with `freshCapabilities: z.tuple([])`.

### 6.3 `lanes` (shape frozen now, behavior in P6)

```ts
LaneV1 = { kind: 'openbuff.lane', version: 1, laneId: string /* 'main' | 'ln_'+ULID */,
           status: 'active' | 'landed' | 'abandoned',
           baseRevision: number, workspaceSnapshotId?: string, agentIds: string[] }
```

- P1 behavior:
  - `_openbuff.dev/lanes/list {sessionId}` → `{lanes:[<main>]}`.
  - `_openbuff.dev/lanes/create` and `/land` → -32601 while `capabilities.lanes.supported === false`.
  - Every receipt envelope and tool `_meta` carries `laneId:"main"`.
- Rationale: clients can build UI against the shape now, and P6 lights it up without an extVersion bump.

### 6.4 `gate`

```ts
GateStateV1 = {
  kind: 'openbuff.gate_state', version: 1,
  sessionId: string,
  status: 'idle' | 'pending' | 'validating' | 'reviewing' | 'passed' | 'failed' | 'skipped',
  pendingFiles: string[],          // Base2GateState.pendingGateFiles
  passedFiles: string[],           // gatePassedFiles
  reviewerVerdict?: string,        // gatePassedReviewerVerdict (e.g. 'LOOKS_GOOD')
  validationSummary?: string,      // gatePassedValidationSummary
  fingerprint?: string,            // gatePassedFingerprint (opaque v3 token; not an authority)
  progress?: string,               // gateProgressLine
  skipReason?: string,             // lastReviewerGateSkipReason
}
```

- Emitted as the notification `_openbuff.dev/gate_state {state}` whenever the projected value changes. Fetchable with `_openbuff.dev/gate_state/get {sessionId}`.
- It is a projection of `Base2GateState` plus phase. The mapping is `awaiting_validation → pending`, then hooks → `validating`, reviewer → `reviewing`.
- The existing `<gate-state>{gate,status,details}` text block is unchanged. This is an additional channel for it.

### 6.5 Also in ext v1 (small, required for lossless TUI-over-ACP)

- `events`: the `_openbuff.dev/event` passthrough (§4.2).
- `_openbuff.dev/ask_user` request: `{sessionId, toolCallId, questions}` → `{answers | skipped:true}`. The schema is the existing ask_user tool schema.

## 7. Implementation layout

- `common/src/protocol/acp-ext-v1.ts`
  - Zod schemas for everything in §6, all `.strict()` except `_meta` bags.
  - Constants: `OPENBUFF_ACP_NS = 'openbuff.dev'`, `OPENBUFF_ACP_EXT_VERSION = 1`.
  - Pure projection functions:
    - `toWireMutation(FileMutationResultV1)`
    - `projectGateState(Base2GateState, phase)`
    - `toolKind(toolName, mutation?)`
    - `printModeToSessionUpdates(event, ctx)`
- JSON Schema export: `bun run generate:acp-ext-schema` writes `common/src/protocol/acp-ext-v1.schema.json`, reusing the existing zod→JSON-schema util used by `compile-tool-definitions`.
- Core ACP types come from `@agentclientprotocol/sdk`. They are never re-declared.
- `sdk/src/serve/`
  - `acp-agent.ts`: the `agent()` handlers from §4.1.
  - `event-bridge.ts`: `handleEvent` → session/update.
  - `approval-bridge.ts`
  - `session-store.ts`
  - `socket-transport.ts`: peer-cred plus token.
- `cli`: `openbuff serve` subcommand in `cli-args.ts`, which prints nothing to stdout except protocol messages.
- Dependency: `@agentclientprotocol/sdk` pinned exactly, added via dependency-manager after user approval.

## 8. Golden vectors (ext v1)

The test suite must satisfy all of the following:
- Fixtures live at `common/src/protocol/__fixtures__/acp-ext-v1/GV-XX.json`.
- `acp-ext-v1.golden.test.ts` asserts that each vector:
  - (a) parses with the ACP SDK schema plus our ext schema,
  - (b) round-trips byte-exactly through `JSON.stringify(parse(x))` with schema key order,
  - (c) equals the output of the projection function from its `source` fixture, where one is given.
- Canonical hashing for change detection uses RFC 8785 (JCS).
- Hash values below are fixed fixture literals, not derived from real files.

**GV-01 `initialize` (client → agent, Openbuff-aware client)**
```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,"_meta":{"openbuff.dev":{"extVersion":1,"extensions":["capabilities","receipts","lanes","gate","events"],"events":"acp"}}},"clientInfo":{"name":"openbuff-vscode","version":"0.1.0"}}}
```

**GV-02 `initialize` result**
```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"close":{}},"_meta":{"openbuff.dev":{"extVersion":1,"extensions":["capabilities","receipts","lanes","gate","events"],"capabilities":{"kind":"openbuff.capabilities","version":1,"generation":1,"sandbox":{"tier":"lexical","enforced":false,"network":"unrestricted"},"index":{"state":"ready","files":4213},"lsp":[],"sidecars":[],"lanes":{"supported":false},"journal":{"resume":false,"replay":false},"gate":{"enabled":true}}}}},"agentInfo":{"name":"openbuff","title":"Openbuff","version":"2.0.0"},"authMethods":[]}}
```

**GV-03 plain ACP client: no ext `_meta` means none is echoed**

The client sends GV-01 without `clientCapabilities._meta`. In the result, `agentCapabilities` equals GV-02 with `_meta` removed. The rule is that no ext is emitted unless negotiated.

**GV-04 `session/new` → result**
```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/home/dev/proj","mcpServers":[]}}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","configOptions":[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"default","options":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"}]},{"id":"model","name":"Model","category":"model","type":"select","currentValue":"default","options":[{"value":"default","name":"Route default"}]},{"id":"thought_level","name":"Reasoning","category":"thought_level","type":"select","currentValue":"auto","options":[{"value":"auto","name":"Auto"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]}],"modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"},{"id":"plan","name":"Plan"}]}}}
```

**GV-05 `session/prompt` and a streamed text chunk**
```json
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","prompt":[{"type":"text","text":"Rename foo to bar in src/a.ts"}]}}
```
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","update":{"sessionUpdate":"agent_message_chunk","messageId":"run_root_1","content":{"type":"text","text":"Updating src/a.ts."}}}}
```

**GV-06 edit tool call, then completion with a diff and a redacted receipt**
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","update":{"sessionUpdate":"tool_call","toolCallId":"call_7","title":"Edit transaction","kind":"edit","status":"pending","locations":[{"path":"/home/dev/proj/src/a.ts"}],"rawInput":{"edits":[{"type":"str_replace","path":"src/a.ts","replacements":[{"oldString":"foo","newString":"bar"}]}]},"_meta":{"openbuff.dev":{"laneId":"main"}}}}}
```
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_7","status":"completed","content":[{"type":"diff","path":"/home/dev/proj/src/a.ts","oldText":"export const foo = 1\n","newText":"export const bar = 1\n"}],"_meta":{"openbuff.dev":{"laneId":"main","receipt":{"kind":"openbuff.receipt_envelope","version":1,"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","toolCallId":"call_7","laneId":"main","mutation":{"kind":"file_mutation_result","version":1,"operationId":"op_1","outcome":"applied","actions":[{"actionId":"op_1:0","index":0,"action":"update","path":"src/a.ts","outcome":"applied","beforeHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","afterHash":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"authorityTier":"conditional_commit","receiptId":"rcpt_1","authorityReceipt":{"kind":"commit_receipt","version":1,"receiptId":"rcpt_1","operationId":"op_1","callId":"call_7","authorityTier":"conditional_commit","status":"committed","actions":[{"actionId":"op_1:0","index":0,"action":"update","path":"src/a.ts","status":"committed","beforeHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","afterHash":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"finalHashes":{"src/a.ts":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}},"errors":[],"freshCapabilities":[]}}}}}}}
```
- Source fixture: the same `FileMutationResultV1`, but carrying `afterContent`, `editAnchor.readCapability:"cap.v3.1.1.AAA.BBB.CCC"` and one `freshCapabilities` entry.
- `toWireMutation(source)` MUST equal the `mutation` object above.

**GV-07 negative: a leaked capability is rejected**

This vector is GV-06's `mutation` with `"freshCapabilities":[{"kind":"whole_file","token":"cap.v3.1.1.AAA.BBB.CCC"}]` or `actions[0].editAnchor` present. Parsing it with `wireFileMutationResultV1Schema` MUST fail. This test is the redaction invariant.

**GV-08 approval request and allow-once response**
```json
{"jsonrpc":"2.0","id":100,"method":"session/request_permission","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","toolCall":{"toolCallId":"call_9","title":"Approve push: origin feature/x","kind":"execute","status":"pending"},"options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"reject_once","name":"Deny","kind":"reject_once"}],"_meta":{"openbuff.dev":{"approval":{"action":"push","target":"origin","branch":"feature/x","risk":"high","reason":"git push to remote","scope":{"workspaceId":"ws_1","runId":"run_root_1","snapshotId":"workspace.v1.12.abcdef01"}}}}}}
```
```json
{"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```
- This response maps to `requestApproval` resolving `true`.
- `{"outcome":{"outcome":"cancelled"}}` and `{"outcome":{"outcome":"selected","optionId":"reject_once"}}` both map to `false`.

**GV-09 gate state notification**
```json
{"jsonrpc":"2.0","method":"_openbuff.dev/gate_state","params":{"state":{"kind":"openbuff.gate_state","version":1,"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","status":"passed","pendingFiles":[],"passedFiles":["src/a.ts"],"reviewerVerdict":"LOOKS_GOOD","validationSummary":"typecheck ok; 12 tests passed","fingerprint":"v3:0123456789abc"}}}
```
- Source fixture: a `Base2GateState` with `gatePassedFiles:["src/a.ts"]`, `pendingGateFiles:[]`, verdict and summary as above, plus phase `final_response_allowed`.
- `projectGateState` MUST produce exactly this `state`.

**GV-10 lanes in P1**
```json
{"jsonrpc":"2.0","id":3,"method":"_openbuff.dev/lanes/list","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3"}}
```
```json
{"jsonrpc":"2.0","id":3,"result":{"lanes":[{"kind":"openbuff.lane","version":1,"laneId":"main","status":"active","baseRevision":12,"agentIds":["run_root_1"]}]}}
```
```json
{"jsonrpc":"2.0","id":4,"method":"_openbuff.dev/lanes/create","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3"}}
```
```json
{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found","data":{"openbuff.dev":{"code":"capability_disabled","capability":"lanes"}}}}
```

**GV-11 capability change (sandbox upgraded after the P5 shim starts)**
```json
{"jsonrpc":"2.0","method":"_openbuff.dev/capabilities_changed","params":{"capabilities":{"kind":"openbuff.capabilities","version":1,"generation":2,"sandbox":{"tier":"landlock+seccomp","enforced":true,"network":"allowlist"},"index":{"state":"ready","files":4213},"lsp":[{"language":"typescript","server":"tsserver","state":"ready"}],"sidecars":[{"id":"openbuff-sandbox","version":"0.1.0","state":"ready"}],"lanes":{"supported":false},"journal":{"resume":false,"replay":false},"gate":{"enabled":true}}}}
```

**GV-12 cancel, then the prompt result**
```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3"}}
```
```json
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"cancelled"}}
```
The pending GV-08 request, if any, resolves to cancelled, and the approval resolves `false`.

**GV-13 `plan` from `write_todos`**
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3","update":{"sessionUpdate":"plan","entries":[{"content":"Rename symbol","priority":"medium","status":"completed"},{"content":"Run tests","priority":"medium","status":"in_progress"},{"content":"Summarize","priority":"medium","status":"pending"}]}}}
```

**GV-14 negative: a second concurrent prompt**
```json
{"jsonrpc":"2.0","id":5,"error":{"code":-32600,"message":"A prompt is already running for this session","data":{"openbuff.dev":{"code":"prompt_in_flight"}}}}
```

## 9. Security invariants (security-reviewer checklist for P1-T2)

1. **No authority leaves the process.** No cap.v3 token, approval receipt id, API key or env var appears in any wire message. The GV-07 negative test and a fuzz test over all emitted messages scan for `cap.v3.` and known key env names.
2. **Paths are contained.** `cwd`, `additionalDirectories`, resource URIs and `locations` must lie inside the project root or the declared additional directories; anything else is rejected, not normalized.
3. **Client MCP servers are untrusted input.** They are governed by §12.3: no `$VAR` expansion, an env denylist, approval before spawn, refused over `--socket` by default, namespaced tools, and SSRF checks. Once P5-T6 lands, they launch inside the sandbox shim.
4. **Approvals fail closed** (§5). There are no persistent allow-always grants.
5. **stdout is protocol-only.** Any stray write is a bug. There is a test that runs `serve --stdio` and asserts every stdout line parses as JSON-RPC.

## 10. Test plan (P1-T1/P1-T2 gates)

- `acp-ext-v1.golden.test.ts`: GV-01…GV-14.
- `event-bridge.test.ts`: every `PrintModeEvent` variant maps to exactly the §4.2 row. An exhaustiveness check fails on new variants.
- `acp-conformance.test.ts`: drive `serve --stdio` with the SDK's `client()` covering initialize, new, prompt with a stub model, cancel, load (replay order), set_config_option, and request_permission round-trips.
- A socket auth test for wrong uid (simulated), wrong token, and a missing first `initialize`.
- Validation commands: `bun run typecheck`, then `bun test` in `common` and `sdk`.

## 11. Open questions (non-blocking; defaults in bold)

- Q1. Emit subagent text by default? **No, only with events=`full`.** ACP clients expect a single assistant stream.
- Q2. Should `session/load` replay tool calls? **Yes, as final-status `tool_call` entries without receipts.** Receipts stay fetchable via `receipts/get`.
- Q3. Session id format: **`obs_`+ULID**, which lets Openbuff ids be told apart from client ids in logs.
- Q4. When P2 lands, add `sessionCapabilities.resume` (mid-step resume from the journal) as a separate capability from `loadSession` (history replay). **Yes.**

## 12. Security hardening (normative; answers SEC-1…SEC-9)

### 12.1 One outbound chokepoint (SEC-1, SEC-6)

Every agent→client frame goes through `sanitizeOutbound(frame)` in `sdk/src/serve/outbound.ts` immediately before the transport write. That covers responses, notifications, agent→client requests, `session/load` replay and all `_openbuff.dev/*` messages. It runs these steps in order:

1. Remove keys named `readCapability`, `editAnchor`, `freshCapabilities`, `afterContent` and `patch` at any depth. Exception: `freshCapabilities` stays inside a `WireFileMutationResultV1`, where it is always `[]`.
2. Replace every string match of `/cap\.v3\.[A-Za-z0-9._-]+/` with `[REDACTED:cap]`.
3. Apply `redactSecretValues` (`common/src/util/redact-secrets.ts`) to every string. Add the `cap.v3.` shape to its `TOKEN_SHAPES` so the redaction behaves the same everywhere.
4. Re-serialize and scan the result. If any `cap.v3.` or known credential env value (the BYOK/OAuth keys read in `sdk/src/env.ts`) survives, the frame is dropped. The server logs a redacted incident, and the in-flight prompt fails with -32603 `data["openbuff.dev"].code = "redaction_violation"`. This check fails closed.

Content rules:
- `rawOutput` is never emitted.
- Tool results reach the client only as sanitized `content` text, capped at 64 KiB per tool call with a truncation marker.
- `rawInput` is emitted only after the pass above.

Sensitive paths (SEC-6):
- A path is sensitive when `isMandatorySensitiveReadPath` matches it (`common/src/util/sensitive-paths.ts`), for example `.env`, keys or credential stores.
- For a sensitive path, `diff` content is replaced by `{type:"content", content:{type:"text", text:"[sensitive file changed: <relpath>]"}}`.
- Its `beforeHash`, `afterHash` and `finalHashes[path]` become `"sha256:redacted"`. This prevents offline guessing of low-entropy secrets.

Other outbound rules:
- `errors[].message` and `actions[].error.message` are sanitized like every other string.
- `session/load` replay emits `tool_call` entries with only `toolCallId`, `title`, `kind`, `status` and `locations`.
- The gate `fingerprint` may be emitted. §13 verifies it is an unkeyed sha256 over file paths, content markers and the validation summary, so it grants no authority.
- Approval `scope` ids are emitted only as display data. §13 records that consuming an approval also requires the exact action, target, run and snapshot, all held server-side.

### 12.2 Socket transport (SEC-4)

- **Threat model.** `--socket` protects against other local uids and against mistaken permissions. Processes running as the same uid are trusted, since they can read the token or ptrace the editor. The docs say so explicitly.
- **Directory checks.**
  - Create the directory with `mkdir(0700)` under `umask 077`.
  - Then `lstat` it and require: not a symlink, owner == euid, and `(mode & 0o077) == 0`. If any check fails, refuse to start.
  - For the `~/.config/openbuff/run/` fallback, which is the common path on macOS, apply the same check to every component below `$HOME`.
- **Stale sockets.** Take an exclusive `flock` on `<projectHash>.lock` first. Unlink an existing socket only if `lstat` shows a socket owned by euid and a probe `connect()` fails. A second server for the same project fails with `lock_held`.
- **Token.**
  - 32 random bytes, base64url.
  - Written with `open(O_CREAT|O_EXCL|O_NOFOLLOW, 0600)` to `<projectHash>.token` in the verified directory. One token per server start per project; it is deleted on shutdown.
  - Compared with `crypto.timingSafeEqual` on equal-length buffers.
- **Handshake.** `initialize` must arrive within 5 s or the connection is closed.
- **Ownership.** Each session is owned by the connection that created or loaded it. Session-scoped methods called from any other connection return -32602 `code:"session_not_owned"`. That covers `session/prompt`, `cancel`, `close` and `set_config_option`, plus `receipts/get`, `gate_state/get` and `lanes/*`. `session/request_permission` is sent only to the owner. The ACP SDK already keeps per-connection pending maps (§13), so a response on another connection cannot resolve it.
- **Windows.** `--socket` is refused on Windows in v1. A named pipe with ACL design is deferred.

### 12.3 Client-supplied MCP servers (SEC-2, SEC-3)

- **Origin.** Client entries MUST reach both MCP connect sites (`sdk/src/run.ts` `requestMcpToolData` and `requestToolCall`) with `origin:'client'`. §12.8 NEW-1 defines the required plumbing and the fail-closed default. `resolveMCPConfigValues` in `common/src/mcp/client.ts` already implements the literal, no-`$VAR` behavior for that origin and keys the client cache by origin. It is covered by tests in `common/src/mcp/__tests__/client.test.ts`.
- **Env denylist.** The stdio child env is the MCP SDK default inherited set plus the client entries (§13). A client env name is rejected with -32602 if it matches any of these: `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `BUN_*`, `PYTHON*`, `PERL5*`, `RUBYOPT`, `GIT_*`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `OPENBUFF_*`, `CODEBUFF_*`.
- **Transport gating.**
  - Over `--socket`, client MCP servers are refused (-32602 `code:"client_mcp_disabled"`) unless `openbuff.json` sets `serve.allowClientMcp: true`.
  - Over stdio, each server needs a `session/request_permission` before it is spawned or connected. The request uses kind `execute` and the title `Start MCP server <name>: <command basename | url host>`. It fails closed per §12.4.
- **Name clash.** The project entry wins. Client server names must match `^[a-z0-9-]{1,32}$` (no `__`); anything else gets -32602. Client entries are registered as `client-<name>`, so their tools are `client-<name>__<tool>` under the existing `__` separator.
- **Untrusted tools.**
  - Tool descriptions from client servers are wrapped as untrusted (§12.6) and truncated to 1 KiB.
  - The first call of each client-origin tool in a session requires `session/request_permission` (kind `other`).
  - Today MCP tool calls bypass harness approval completely (§13); this rule closes that gap for client origin.
- **Remote URLs (SSRF).**
  - Client http/sse URLs must use `https:`, or `http:` only to a loopback host:port listed in `serve.allowedLoopbackMcp`.
  - After DNS resolution, the server refuses link-local, RFC1918, CGNAT, ULA, `0.0.0.0/8`, metadata (`169.254.169.254`, `fd00:ec2::254`) and loopback addresses unless allowlisted.
  - Redirects are not followed.
- **Limits and logging.**
  - At most 8 MCP servers per session.
  - Launch logs record only name, origin, command basename or URL host, and a sha256 of args/env/headers.

### 12.4 Approvals (SEC-5)

- **Command binding.** `_meta["openbuff.dev"].approval` also carries `command` and `commandHash`.
  - `command` is the normalized command string, truncated at 4 KiB with a marker.
  - `commandHash` is the sha256 of the full normalized command.
  - The command that finally runs must hash to `commandHash`, otherwise the approval is void. This needs a small SDK change: `HarnessApprovalRequest` gains `command` / `commandHash`, and the consume step compares them.
- **Display sanitization.** Before emission, `title`, `target`, `branch` and `command` are sanitized:
  - C0/C1 controls, ESC, U+2028/2029, bidi controls (U+202A–202E, U+2066–2069) and zero-width characters (U+200B–200D, U+FEFF) become U+FFFD.
  - `title` is capped at 200 characters.
- **Resolution.** An approval resolves `true` only when all of these hold:
  - `outcome.outcome === "selected"`;
  - `optionId === "allow_once"` exactly;
  - the request is still pending on the owning connection.

  The ACP SDK does not check `optionId` against the offered options (§13), so the bridge must. A duplicate or unknown-id response is dropped by the SDK. A rejected promise, which happens when the connection closes, maps to `false`.
- **Disconnect.** When the owning connection closes, every pending approval resolves `false`, and the session's active run is aborted with `stopReason:"cancelled"`. The run does not continue unattended.
- **Timeout.** `serve.approvalTimeoutMs` defaults to 30 min. When it expires, the approval resolves `false` and a `$/cancel_request` is sent for the outstanding request.

### 12.5 Path containment (SEC-7)

- **Resolution.** `cwd`, `additionalDirectories` and `file://` URIs are percent-decoded once, then rejected if either of these is true:
  - the decoded value still contains `%2e`, `%2f` or `%5c`;
  - the authority is not empty or `localhost`.

  They are resolved with `resolveProjectPath` / `realpathOrLexical` (`common/src/util/project-path-containment.ts`). A value is rejected, never silently normalized, if it contains traversal segments or escapes the root after realpath.
- **Additional directories.** `additionalDirectories` are accepted only if each one also appears in `openbuff.json` `serve.additionalDirectories` or in `openbuff serve --add-dir`.
- **Reload.** `session/load` rejects a `cwd` that differs from the project root recorded with the session.

### 12.6 Untrusted context, overlay reads, limits (SEC-8, SEC-9)

- **Untrusted wrapper.** Untrusted text (outside-project `resource` blocks and client MCP tool descriptions) is wrapped in `<untrusted-context nonce="N">…</untrusted-context nonce="N">`, where N is 16 random hex characters per prompt. Content that contains N is rejected.
- **Overlay reads.** Editor-overlay reads are tagged `source:"editor-overlay"` and mint only `read_only` caps. They never supply `beforeHash` or CAS inputs; edits always re-read from disk.
- **Size and count limits.**
  - An inbound frame may be at most 16 MiB. Pass `maxMessageBytes: 16 MiB` to the SDK `ndJsonStream`, whose default is 32 MiB and which closes the connection on overflow.
  - A prompt may total at most 8 MiB, with each decoded image at most 5 MiB. Larger requests get -32602 `limit_exceeded`.
  - A server holds at most 16 live sessions. More also gets `limit_exceeded`.
- **Outbound backpressure.**
  - The outbound queue is capped at 32 MiB per connection.
  - On overflow, consecutive `agent_message_chunk` / `tool_call_update` frames for the same id are coalesced.
  - If the queue is still over the cap, the session's run is aborted with `stopReason:"cancelled"`.

### 12.7 Additional golden vectors

Fixtures GV-15…GV-26 live next to GV-01…GV-14 and use the same harness.

| ID | Input / source | Required outcome |
|---|---|---|
| GV-15 | `read_files` tool_result whose output contains `cap.v3.1.1.AAA.BBB.CCC` and `OPENROUTER_API_KEY=sk-or-v1-abc` | Emitted `tool_call_update` JSON contains neither string and has no `rawOutput` key |
| GV-16 | events=`full`, internal `tool_result` PrintModeEvent | No `_openbuff.dev/event` frame is emitted |
| GV-17 | End-to-end: a `client.run()` whose base agent has a merged client-origin http MCP server with header `Authorization: $OPENROUTER_API_KEY` (env set), plus a local capture server. The test drives the real `requestMcpToolData` path, not `getMCPClient` directly. | Captured header is literally `$OPENROUTER_API_KEY` |
| GV-18 | `--socket` session with a stdio `mcpServers` entry, `allowClientMcp` unset | -32602 `client_mcp_disabled`, and no process spawned |
| GV-19 | Project MCP server `db`, client MCP server `db`, and client names `db__x` / `Db:1` | Model tool list has project `db__*` and `client-db__*`; `db__x` and `Db:1` are rejected with -32602 |
| GV-20 | Client MCP url `http://169.254.169.254/` | -32602; no connection attempted |
| GV-21 | Approval with `branch = "x\u001b]0;pwn\u0007\u202Eevil"` | Emitted title contains U+FFFD in place of every control and bidi char, and no ESC/BEL |
| GV-22 | Permission responses `optionId:"allow_always"`, `"proceed_always"`, `"reject_once"` | Each resolves `false` |
| GV-23 | Owner connection closes while an approval is pending | Approval `false`; run aborted `cancelled`; command never executed |
| GV-24 | Duplicate permission response for an already-resolved id | Ignored; first outcome stands |
| GV-25 | Agent edits `.env` via `write_file` and `str_replace` | No `diff` content for it; its hashes are `sha256:redacted`; `rawInput` content fields are `[sensitive]` |
| GV-26 | `session/load` of a history containing a `read_files` result with a cap.v3 token | No frame contains `cap.v3.`; replayed `tool_call` has no rawInput/rawOutput |
| GV-27 | A configured credential value, and separately a cap.v3 token, split across 3 `agent_message_chunk` frames at every possible offset | No single frame, and no per-messageId concatenation of frames, contains the value |
| GV-28 | A handler throws `Error("cap.v3.1.1.AAA.BBB.CCC sk-or-v1-abc")` | The SDK-built JSON-RPC error frame contains neither string |
| GV-29 | `openbuff serve --stdio` started in a project whose `.agents/mcp.json` has an http server with header `$OPENROUTER_API_KEY`, without `--trust-project-agents` | Project `.agents` / `mcp.json` are not loaded; no connection is attempted |

Property tests:
- (a) Every frame emitted during `acp-conformance.test.ts` is scanned, and so is the concatenation of all chunk frames per `messageId`. None may match `/cap\.v3\./` or a configured credential value.
- (b) Socket suites cover:
  - start is refused with a 0755 directory, a symlinked directory, or a directory owned by another uid (simulated);
  - a second server fails with `lock_held`;
  - another connection's prompt gets `session_not_owned`;
  - a stalled handshake is closed at 5 s.
- (c) Limit suites cover:
  - a 17 MiB line closes the connection;
  - the 17th session is rejected;
  - a stalled reader aborts the run with bounded memory.
- (d) Containment suites cover:
  - a symlink cwd that escapes the root;
  - `additionalDirectories:["/"]`;
  - percent-encoded traversal;
  - a `file://host/share` URI.

### 12.8 Second-review hardening (normative; answers NEW-1…NEW-7)

**NEW-1: origin plumbing and fail-closed default (BLOCKING before P1-T2 ships).**

Today the `common/src/mcp/client.ts` default origin is `'project'`. That is correct only while every caller is a trusted on-disk loader, which the second review verified is true today. Before `serve` merges any client-supplied server:

1. Add an origin registry in `common/src/mcp/client.ts`:
   - `markMCPConfigOrigin(config, origin)`, backed by a `WeakMap<MCPConfig, MCPConfigOrigin>`;
   - `originOf(config)`.
2. The trusted loaders mark every config they return:
   - `loadMCPConfig` / `loadMCPConfigSync` mark `'user'` for home and `'project'` for the project dir;
   - `loadLocalAgents` marks agent `mcpServers` the same way;
   - bundled agent templates are marked `'project'`.
3. `getMCPClient` / `getMCPClientCacheKey` resolve origin in this order: `options.origin ?? originOf(config) ?? 'client'`. An unmarked config is therefore treated as untrusted.
4. The serve bridge marks client entries `'client'`. It must merge the same object references into `agentTemplate.mcpServers`, with no spread-clone. It must also assert, before merge, that `originOf(entry) === 'client'`.
5. Any code that clones MCP configs (spread, `structuredClone`, zod parse) must re-mark the copy. A unit test enforces this for each loader.
6. GV-17 is the end-to-end proof.

**NEW-2: serve trust default.**
- `openbuff serve` never loads project `.agents/**` or `.agents/mcp.json` unless one of these holds:
  - (a) it was started with `--trust-project-agents`; or
  - (b) the realpath of the project root appears in a user-level allowlist (`~/.config/openbuff/trusted-roots.json`, 0600, owned by the user).
- Trust is never inferred from `session/new` `cwd` or from any other client-supplied field.
- Home `~/.agents` stays trusted, as it is in the CLI today.
- GV-29 covers this.
- Published or database agent templates: verified 2026-09-26, see §13 "Database agent templates". The path is dormant today. If it is ever enabled, its `mcpServers` must be marked `'client'` at the points listed there.

**NEW-3: streaming holdback.**
- `outbound.ts` keeps a per-`(sessionId, messageId)` holdback buffer for `agent_message_chunk` and `agent_thought_chunk`.
- It holds back the trailing `max(longest configured credential length, 256)` characters and runs §12.1 steps 2–4 over the held-back tail plus the new chunk.
- It flushes on the next `tool_call`, turn end, cancel, or after 250 ms idle, whichever comes first.
- GV-27 covers this.

**NEW-4: chokepoint location.**
- `sanitizeOutbound` wraps the `WritableStream` handed to `ndJsonStream`, so every serialized frame passes through it. That includes SDK-generated JSON-RPC errors, agent→client requests, and `$/cancel_request`.
- Handler-level sanitization is an optimization only, never the guarantee.
- The ACP SDK's `console.error` for unknown response ids goes to stderr and only echoes client data. That is acceptable.
- GV-28 covers this.

**NEW-5: client MCP names.** Handled by the §12.3 name rule (`^[a-z0-9-]{1,32}$`, `client-` prefix) and GV-19.

**NEW-6: sensitive `rawInput`.**
- When any path parameter of a tool call is sensitive, these `rawInput` content fields are replaced with `"[sensitive]"`: `content`, `newString`, `oldString`, `replacements[].*`, `edits[].*` (including nested `content`/`newString`/`oldString`/`newContent`), and `diff`.
- GV-25 covers this.

**NEW-7: consistency and rebinding.**
- §2 and §5 now match §12.
- SSRF: client http/sse transports get a custom `fetch` whose undici `Agent` `connect.lookup` enforces the §12.3 IP policy on the actual connect address. This pins the address and closes the DNS-rebinding TOCTOU gap.

## 13. Verified facts behind §12 (2026-09-26)

| Question | Finding | Evidence |
|---|---|---|
| Do MCP tool calls go through harness approval? | **No.** When `action.mcpConfig` is set, the SDK calls `getMCPClient` then `callMCPTool` directly. There is no `requestApproval` and no terminal policy. | `sdk/src/run.ts:1816-1843`; `classifyTerminalHarnessAction` only classifies terminal commands (`harness-enforcement.ts:144`) |
| MCP SDK stdio child env | `@modelcontextprotocol/sdk` 1.20.2 `StdioClientTransport` spawns with `{...getDefaultEnvironment(), ...serverParams.env}`. The default is a small inherited allowlist (`DEFAULT_INHERITED_ENV_VARS`), not all of `process.env`. Secrets therefore reached children only through Openbuff's own `$VAR` substitution, which is now origin-gated. | `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:28-31,68-71` |
| `$VAR` substitution sites | `common/src/mcp/client.ts` (stdio env and remote headers, now origin-gated) and `sdk/src/agents/load-mcp-config.ts:44-87` (stdio env from user/project `mcp.json`; trusted and left unchanged) | read directly |
| Is `gatePassedFingerprint` an authority? | **No.** It is `v3:` + unkeyed sha256 over `files-v4\n<path>\t<contentMarker>…\n--\n<validationSummary>`. It is not HMAC-keyed and not accepted as edit authority. | `agents/base2/gate-fingerprint.ts:18-40`; `base2.ts:11723-11747` |
| ACP SDK request ids | `@agentclientprotocol/sdk` 1.5.0 keeps `pendingResponses` and `nextRequestId` per `Connection` instance. A response on connection B cannot resolve a request sent on A. | librarian: `src/jsonrpc.ts:859-873,1114,1145,1489-1506` |
| Unknown or duplicate response ids | Logged with `console.error`, then dropped. The connection stays open. | `src/jsonrpc.ts:1503-1504` |
| `optionId` validation | Not done by the SDK. v1 does not validate the response at all; v2 validates shape only. The application must check. | `src/acp.ts:2736-2743`; `src/schema/zod.gen.ts:3902-3933` |
| Pending requests on stream close | Rejected: they get the read error, or `"ACP connection closed"` on a clean EOF. The SDK has no per-request timeout. | `src/jsonrpc.ts:1159-1177,1214-1243` |
| Inbound size limit | `ndJsonStream` takes `maxMessageBytes` (default 32 MiB). Overflow throws `MessageTooLargeError` and closes the connection. | `src/stream.ts:45-52,130-136`; `src/stream-limits.ts:1`; `src/line-buffer.ts:73-82` |
| Can published/database agent templates carry `mcpServers` into `run.ts`? | **Not today (dormant path).** The template shape allows it, and nothing strips it, but the SDK never fetches from the registry. See the subsection below. | `sdk/src/impl/agent-runtime.ts:76,137-146`; `sdk/src/impl/database.ts:247-344` |

### Database agent templates (verified 2026-09-26)

**Why it is unreachable today**
- The SDK runtime injects `fetchAgentFromDatabase: localFetchAgentFromDatabase` (`sdk/src/impl/agent-runtime.ts:76`). That stub logs "Local mode: skipping remote agent registry lookup" and returns `null` (`:137-146`).
- The real `fetchAgentFromDatabase` (`sdk/src/impl/database.ts:247`) is referenced only by tests, which `spyOn` it. `sdk/src/index.ts:146` exports only `getUserInfoFromApiKey` from that module.
- The evals runtime and the common test fixtures also return `null` (`evals/impl/agent-runtime.ts:41`; `common/src/testing/fixtures/agent-runtime.ts:120`).
- As a result, `getAgentTemplate` (`packages/agent-runtime/src/templates/agent-registry.ts:21-88`) can only resolve templates from `localAgentTemplates`. Its database step always misses.

**What happens if the path is re-enabled**
1. `DynamicAgentTemplate` includes `mcpServers: z.record(z.string(), mcpConfigSchema)` (`common/src/types/dynamic-agent-template.ts:190`).
2. `fetchAgentFromDatabase` rejects only `handleSteps` (`database.ts:287-297`). `validateSingleAgent` spreads the whole validated config into the `AgentTemplate` (`common/src/templates/agent-validation.ts:265-272`). The result is tagged `executionSource: 'database'` (`database.ts:319-323`), but its `mcpServers` pass through unchanged.
3. Those `mcpServers` reach both connect sites, and only `mcpConfig` crosses the contract (`common/src/types/contracts/client.ts:10-31`); neither origin nor `executionSource` does:
   - Tool listing: `run-agent-step.ts:404-409` → `getMCPToolData` → `requestMcpToolData({mcpConfig})` (`mcp.ts:52`) → `getMCPClient(mcpConfig)` (`sdk/src/run.ts:1216`).
   - Tool calls: `tool-executor.ts:3535-3539` → `requestToolCall({mcpConfig})` → `getMCPClient(action.mcpConfig)` (`sdk/src/run.ts:1819`).
   - Subagents resolve through the same `getAgentTemplate` (`spawn-agent-utils.ts:287`).
4. `getMCPClient` defaults to origin `'project'`, so a published agent's `Authorization: $OPENROUTER_API_KEY` header would be expanded and sent to its URL.

**Required marking points (part of §12.8 NEW-1)**

| # | Location | Rule |
|---|---|---|
| M-1 (primary) | `packages/agent-runtime/src/templates/agent-registry.ts`, immediately after both `fetchAgentFromDatabase` calls (lines 65-72 and 79-86), before `databaseAgentCache.set` / return | `markMCPConfigOrigin(entry, 'client')` for every `dbAgent.mcpServers` entry. This covers root agents, subagents, cached copies and any injected fetch implementation. |
| M-2 (defense in depth) | `sdk/src/impl/database.ts:319-323`, on the final `agentTemplate` object | Mark the same entries. Only the final object may be marked, because zod parsing and the spread in `validateSingleAgent` create new objects, and any earlier mark would be lost. |
| M-3 (fail-closed backstop) | `sdk/src/run.ts:1216` and `:1819` (via `getMCPClient`) | Resolve origin as `options.origin ?? originOf(config) ?? 'client'`, so an unmarked config is treated as untrusted. |
| Alt | `tool-executor.ts:3535`, `mcp.ts:52`, and `RequestToolCallFn`/`RequestMcpToolDataFn` | Explicit alternative to the WeakMap: add `origin` to the contract, derived as `executionSource === 'database' ? 'client' : 'project'`. This is a contract change. |

**Adjacent path**
- `client.run({ agentDefinitions })` (`sdk/src/run.ts:229,770`) → `run-state.ts:98-110` → `assembleLocalAgentTemplates` accepts `mcpServers` from the embedding host, which is trusted as `'project'`.
- The serve bridge MUST NOT forward client-supplied agent definitions through this path unless it first marks their `mcpServers` `'client'`.

**Test**
- GV-30: inject a fake `fetchAgentFromDatabase` that returns a template whose `mcpServers` includes an http server with header `$OPENROUTER_API_KEY` (env set) and a local capture server. Run the agent through `getAgentTemplate` and `client.run()`.
- Assert that the captured header is literally `$OPENROUTER_API_KEY`.

Still open and tracked for P1-T2 implementation:
- The origin registry and loader marking with a fail-closed default (§12.8 NEW-1). This must land before any client-supplied server can be merged.
- The `HarnessApprovalRequest` command/commandHash extension (§12.4). This changes the SDK approval contract, so it needs its own test and a compatibility note.
- The per-client-tool first-call approval hook (§12.3). It needs a small interception point before `callMCPTool` in `sdk/src/run.ts`.
- ~~The published/database agent template `mcpServers` path (§12.8 NEW-2).~~ Closed 2026-09-26: the path is dormant. Marking points M-1…M-3 and test GV-30 are folded into the NEW-1 origin-registry item above.
