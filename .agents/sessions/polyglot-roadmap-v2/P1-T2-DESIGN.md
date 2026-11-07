# P1-T2 — `openbuff serve` bridge design

Status: draft (design only; no code written). Prerequisite work landed: the NEW-1 MCP
origin registry + single connect-time `$VAR` substitution (`common/src/mcp/client.ts`,
commit `045365e2`). This doc plans how `openbuff serve` exposes the core over ACP v1
(D9) without reopening the secret-exfiltration and approval-bypass vectors the P1-T1
security review (SEC-1…SEC-9) and NEW-1 raised.

Spec: `SPEC.md` (D1–D9). Protocol contract: `P1-T1-DESIGN.md` (ACP mapping, extensions,
golden vectors GV-01…GV-30, security rules §12). This doc is the P1-T2 counterpart:
it specifies the runtime bridge that terminates the protocol and drives the in-process
core, and the exact trust-boundary marking that keeps a protocol peer untrusted.

## 1. Scope

`openbuff serve` runs the existing core (the SDK `run()` loop) as a protocol server so an
ACP client (editor, headless CI, another Openbuff instance) can drive sessions. In scope:

- `openbuff serve --stdio` (default) and `--socket` (unix domain socket, same-user only).
- Session lifecycle: `session/new`, `session/load`, `session/prompt`, `session/cancel`,
  `session/close`, mapped to core run invocations.
- Event → ACP update streaming (the 20 `PrintModeEvent` variants per P1-T1 §exceptions).
- Reverse requests: permission (approvals), and the deliberate refusal to delegate fs/
  terminal to the client (the agent performs those itself; P1-T1 §agent-never-asks-editor).
- **Client-origin marking at the bridge boundary** (the P1-T2-specific security work).

Out of scope (later tasks): P1-T3 TUI-attaches-over-protocol, P1-T4 `openbuff mcp`,
P1-T5 headless `--json`, the ACP SDK dependency addition (needs dependency-manager +
explicit user approval before any implementation begins).

## 2. The client-origin trust boundary (the crux)

NEW-1 established that MCP configs carry an out-of-band origin (`user`/`project`/`client`)
in a WeakMap, that `client` can never be upgraded to a trusted origin, and that unmarked
configs fail closed to `client` (no `$VAR` expansion). The serve bridge is the single new
place where **untrusted, protocol-peer-supplied** material enters the core, so it must mark
everything it forwards `client` before that material reaches `getMCPClient`.

Concrete entry points a client can populate and the required marking:

| Client-supplied input | Reaches | Required action at the bridge |
|---|---|---|
| `session/new { mcpServers }` (ACP + `_openbuff.dev` ext) | `client.run({ agentDefinitions })` → `assembleLocalAgentTemplates` → `getMCPClient` | `markAllMCPConfigOrigins(mcpServers, 'client')` on every server map **before** it is handed to `run()`. |
| client-supplied `agentDefinitions[].mcpServers` | same path | mark each embedded `mcpServers` `'client'` at ingest; never rely on a downstream loader mark. |
| `session/prompt` content, cwd, additionalDirectories | run params | path containment re-validation (SEC-7); never expands `$VAR`. |

The bridge must mark at ingest (identity-stable, before any Zod re-parse) because
`assembleLocalAgentTemplates` blanket-marks `fileContext.agentTemplates` entries `project`.
NEW-1's provenance gate already prevents that blanket mark from upgrading a pre-marked
`client` config, and `propagateMCPConfigOrigins` carries the mark across the identity-losing
re-parse — but only if the bridge applied the `client` mark first. The bridge therefore:

1. On every inbound `mcpServers` record from the peer, call `markAllMCPConfigOrigins(map, 'client')`
   on the exact object it will pass into `run()`.
2. Never call `loadMCPConfig`/`loadLocalAgents` (the trusted `user`/`project` loaders) on
   peer-supplied paths.
3. Rely on the fail-closed default as defense in depth: even if a bridge path forgets to
   mark, `resolveMCPConfigOrigin` treats the unmarked config as `client` and emits the
   one-time `diagnoseFailClosedEnvRefs` warning.

Golden vector (extends the P1-T1 GV set): **GV-31** — a `session/new` carrying an http MCP
server whose header is `Authorization: $OPENROUTER_API_KEY` must reach `getMCPClientCacheKey`
with the literal `$OPENROUTER_API_KEY` (no expansion), and `originOf` must report `'client'`.

## 3. Transport & auth

- **`--stdio` (default):** JSON-RPC 2.0 over stdio, framed per ACP. stdout carries only
  protocol messages (P1-T1 §already-right). The core's own logs go to stderr.
- **`--socket`:** unix domain socket only; **no TCP listener** (SEC, D9 note). Auth per
  P1-T1 §SEC-4: verify the socket directory owner/permissions/not-a-symlink, take a lock
  before removing a stale socket, create the token file with `O_EXCL|O_NOFOLLOW`, compare
  tokens in constant time, close connections that do not `initialize` within 5s, and tie
  each session to the connection that created it. Windows does not offer `--socket` in v1.
- Every outbound message passes through the single `sanitizeOutbound()` filter (P1-T1
  §SEC-1): strips `cap.v3` read tokens, file contents, and secret values at any depth,
  fails closed if a token slips through, drops `rawOutput`, and never forwards
  `tool_call`/`tool_result` events verbatim.

## 4. Bridge structure (planned files, no code yet)

- `sdk/src/serve/` (new dir): `serve.ts` (CLI entry `openbuff serve`), `bridge.ts`
  (ACP session ↔ core run adapter), `outbound-filter.ts` (`sanitizeOutbound`), and
  `socket-listener.ts` (`--socket` auth per SEC-4).
- Reuses without change: `common/src/mcp/client.ts` (origin registry), `sdk/src/run.ts`
  (`OpenbuffClient.run`), the existing approval/harness-enforcement path.
- The ACP wire types come from `@agentclientprotocol/sdk` (dependency add gated on explicit
  user approval; until then the bridge is designed against the P1-T1 mapping table only).

## 5. Approvals over the protocol

Approvals become ACP permission reverse-requests (P1-T1 §approvals):

- Always one-shot `allow once` / `deny`; no `always allow`; anything that goes wrong counts
  as deny; disconnect mid-approval aborts the run.
- The prompt must include the exact command and its hash (SEC-5); the approval is voided if
  what runs does not match the approved command+target. This is the **approval commandHash
  contract change** still listed as a P1-T2 prerequisite in STATUS.md — it must land before
  the bridge forwards approvals, so a client can never approve a different command than the
  one that executes.
- **Client-tool first-call approval hook** (the other listed prerequisite): the first call
  of each tool from a `client`-origin MCP server requires approval, its description is
  wrapped as untrusted text, and requests to local/private network addresses are blocked
  (SEC-3). This hook does not exist yet and is required before client MCP servers can be
  offered at all.

## 6. Remaining P1-T2 prerequisites (tracked, not yet built)

1. Approval commandHash contract change (§5) — approvals carry the exact command + hash;
   mismatch voids the approval.
2. Client-tool first-call approval hook (§5) — per-tool first-use approval + SSRF block +
   untrusted-description wrapping for `client`-origin MCP servers.
3. `@agentclientprotocol/sdk` dependency addition — needs dependency-manager + explicit
   user approval.

The NEW-1 origin registry (this doc's §2 dependency) is **done** (`045365e2`), so the
secret-exfiltration axis is closed; the two approval prerequisites above are the remaining
blockers before `openbuff serve` can safely accept a `session/new` from an untrusted peer.

## 7. Test plan (design-level)

- GV-31 (§2): client `$VAR` header stays literal, `originOf === 'client'`.
- Socket auth negative tests (SEC-4): wrong owner, symlinked dir, stale socket, missing
  token, no-`initialize`-within-5s, cross-connection session access — all rejected.
- `sanitizeOutbound` (SEC-1): a `read_files` result carrying a `cap.v3` edit anchor + `.env`
  contents is dropped/redacted; fail-closed if a token slips through.
- Approval commandHash mismatch voids the approval; disconnect mid-approval aborts.
- No TCP listener is ever opened (assert only stdio/unix-socket fds).
