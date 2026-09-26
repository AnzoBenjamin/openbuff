# STATUS — Polyglot Roadmap v2

Updated: 2026-09-26.

## Current state
- Roadmap v2 is written: SPEC.md and PLAN.md, with 11 phases (P0–P10), 6 cross-cutting foundations, and a traceability matrix that covers all 89 re-audit findings and the 72 prior-audit findings.
- `.agents/sessions/polyglot-native-waves/` is superseded. Its W0-1 work (the packages/native-core scaffold and the CI prebuild matrix) is kept and continues under X-3.
- No implementation has started. The next task is P0-T1.

## Verified during planning
- `sdk/src/env.ts:49` `getSystemProcessEnv()` returns the full `process.env` (P0-T1).
- `packages/agent-runtime/src/run-programmatic-step.ts:368` runs string handleSteps through `new Function`. `@jitl/quickjs-wasmfile-release-sync` is a dependency in sdk/package.json:62 but isn't used on this path (P9-T4). This resolves the QuickJS contradiction the re-audit flagged.

## Open decisions
D1–D8 are listed in SPEC.md, with a default for each and the task where each gets resolved.

## Resume instructions
- Start at P0-T1. Tasks within P0 are independent of each other.
- Run X-1, X-4 and X-5 alongside P0, before P1.
- Every task must pass the validation gates in PLAN.md. For security-boundary tasks, security-reviewer approval is required.

<!-- update_plan_status:appended -->
## Decisions D1–D9 locked — 2026-09-26T08:52:57.323Z

All open decisions are now locked in SPEC.md under "Locked decisions". The user overrode the defaults on two of them:
- **D7:** a Rust sidecar (mistral.rs / llama-cpp-2) from the start. Reason: node-llama-cpp has an open segfault under Bun (oven-sh/bun#27320).
- **D8:** remove `packages/native-core` and start a fresh Rust workspace at P4/P5. PLAN.md now has X-3a (removal, which needs explicit confirmation before any deletion) and X-3b (the new workspace).

D9 was added: adopt ACP v1 through `@agentclientprotocol/sdk`, with namespaced Openbuff extensions. Adding that dependency will need approval.

D3 is GPL-3.0-only, which is incompatible with Openbuff's Apache-2.0 license. It may therefore only be used as an external CLI that the user installs.

P1 is unblocked. The next task is still P0-T1.


<!-- update_plan_status:appended -->
## P1-T1 security follow-ups — 2026-09-26T09:26:02.994Z

Follow-ups on the P1-T1 security review are done.

**Assumptions verified (recorded in design §13):**
- MCP tool calls bypass harness approval (run.ts:1816-1843).
- The MCP SDK 1.20.2 stdio child env is the default allowlist plus the config env.
- `gatePassedFingerprint` is an unkeyed sha256 and grants no authority.
- ACP SDK 1.5.0:
  - keeps request ids per connection;
  - does not validate `optionId`;
  - rejects pending requests when the connection closes;
  - caps ndjson frames at 32 MiB by default.

**Code change:** `common/src/mcp/client.ts` now has `MCPConfigOrigin` and `resolveMCPConfigValues`.
- Configs with origin `client` are never `$VAR`-expanded.
- The origin is part of the cache key.
- The default stays `project`, so current trusted callers behave the same.
- 4 new tests; 8/8 pass; common and sdk typecheck clean.

**Design:** P1-T1-DESIGN.md is now rev 3.
- §12 covers SEC-1…9 and §12.8 covers the second review's NEW-1…7.
- Added GV-15…GV-29 and property tests.

**Blocking before P1-T2 ships:**
- NEW-1: the origin registry, loader marking, and a fail-closed default. Currently only specified in the design, not built.
- The approval commandHash contract change.
- The client-tool first-call approval hook.
- ~~Checking whether published/database templates can carry `mcpServers`.~~ Closed 2026-09-26 (see below).

<!-- update_plan_status:appended -->
## Database-template mcpServers check closed — 2026-09-26

Verified and recorded in P1-T1-DESIGN.md §13, under "Database agent templates".

**Finding.** The path is dormant, not exploitable today. The SDK injects `localFetchAgentFromDatabase`, which always returns `null` (`sdk/src/impl/agent-runtime.ts:76,137-146`), and the real registry fetch is referenced only by tests.

**Latent risk.** If the fetch is re-enabled, a database template's `mcpServers` survive validation unchanged. They would reach `getMCPClient` at `run.ts:1216` and `run.ts:1819` with the default origin `'project'`, so `$VAR` expansion would run on them.

**Action.** Folded into the NEW-1 origin-registry work. It is not a separate blocker:
- M-1: mark entries `'client'` in `agent-registry.ts` after each database fetch.
- M-2: mark the final template in `database.ts:319-323`.
- M-3: make `getMCPClient` default to `originOf(config) ?? 'client'` (fail-closed).
- Test GV-30 covers this.

**Still blocking before P1-T2 ships:**
- NEW-1 origin registry, including M-1…M-3.
- Approval commandHash contract change.
- Client-tool first-call approval hook.
