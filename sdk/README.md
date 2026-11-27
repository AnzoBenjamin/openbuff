# Openbuff SDK

Openbuff is a local-first, BYOK coding-agent SDK: tools run locally and model
requests go directly to your configured provider. There is **no hosted
Openbuff backend or inference fallback**. Configure a provider first, then
save the [shared example setup](#shared-example-setup) alongside each example.

## Quickstart

Save as `quickstart.ts`; after the setup below, run `bun quickstart.ts`.

<!-- sdk-example: quickstart.ts -->
```ts
import { OpenbuffClient, type PrintModeEvent } from '@openbuff/sdk'
import { clientOptions } from './example-setup'
const client = new OpenbuffClient(clientOptions)
try {
  const result = await client.run({ agent: 'base2', prompt: 'Say hello without running tools.',
    handleEvent: (event: PrintModeEvent) => { if (event.type === 'text') process.stdout.write(event.text) } })
  if (result.output.type === 'error') throw new Error(result.output.message)
  console.log('\nFinal output:', JSON.stringify(result.output))
} catch (error) { console.error(error); process.exitCode = 1 }
```

`handleEvent` receives `PrintModeEvent` progress, including streamed `text`
and per-request `usage` events. Usage counts are omitted when unavailable;
`complete: true` means valid input/output counts were reported, not that cache
counts or remote cost are known. `result.output` is the final discriminated result, not just a string.
A resolved promise is not proof of success: inspect error output as above and
catch rejected calls. Execution completion also does not prove task acceptance;
see [outcomes and cancellation](#outcomes-and-cancellation).

## Configure the examples

Install the SDK in your application with `bun add @openbuff/sdk` (or
`npm install @openbuff/sdk`). The SDK supports Node.js 20.3+; these TypeScript
examples use Bun to run TypeScript directly.

This concrete configuration expects an Ollama server already listening on
`127.0.0.1:11434`, with `qwen3:8b` and `qwen3-coder:30b` installed. If needed,
install those models with `ollama pull qwen3:8b` and
`ollama pull qwen3-coder:30b`, and start the server with `ollama serve`.
Save this as `openbuff.json` in the directory where you run the examples:

<!-- sdk-example-config: openbuff.json -->
```json
{
  "defaultModel": "local/qwen3:8b",
  "providers": {
    "local": {
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:11434/v1",
      "models": ["qwen3:8b", "qwen3-coder:30b"]
    }
  },
  "sandbox": { "mode": "project" },
  "indexing": { "enabled": false }
}
```

For a BYOK HTTPS provider, configure its endpoint, supported models and
`apiKeyEnv`, and supply that environment variable privately. Do not put keys
in prompts, source files, transcripts or child-command environment overrides.
A local HTTP endpoint must be recognized as local and keyless; credentials
require HTTPS. See [local/BYOK provider setup](../docs/local-mode.md) and
[configuration](../docs/configuration.md) for other providers and routing.

### Shared example setup

**All TypeScript fences in this README are complete files**, with the names
shown above them. Save this one as `example-setup.ts` in the same directory as
`quickstart.ts`, `structured-output.ts`, `continuation.ts` and `deadline.ts`.
It is their only shared dependency; it can also be run with
`bun example-setup.ts` (it exports options and does not start a model run).

<!-- sdk-example: example-setup.ts -->
```ts
import path from 'node:path'
import type { AgentDefinition, OpenbuffClientOptions } from '@openbuff/sdk'

// SDK hosts supply definitions; this is a minimal prompt-only example agent.
const base2: AgentDefinition = {
  id: 'base2',
  displayName: 'Example base2',
  systemPrompt: 'Answer the user directly. Use the reporting tool when an output schema is supplied.',
  toolNames: [],
  outputMode: 'last_message',
}
const cwd = process.cwd()
export const clientOptions: OpenbuffClientOptions = {
  cwd,
  agentDefinitions: [base2],
  projectContextMode: 'paths',
  harnessStateDir: path.join(cwd, '.openbuff', 'harness'),
  handleEvent: (event) => { if (event.type === 'error') console.error(event.message) },
  hostConfiguration: {
    environment: { ...process.env },
    platform: process.platform,
    invocationCwd: cwd,
    projectRoot: cwd,
    home: { kind: 'none' },
    globals: { kind: 'disabled' },
    selection: {
      kind: 'explicit',
      path: path.resolve(cwd, process.env.OPENBUFF_PROVIDER_CONFIG ?? 'openbuff.json'),
      required: true,
    },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  },
}
```

The SDK host owns its agent definitions; it does not automatically populate
the CLI's full agent registry. This setup defines a minimal **prompt-only**
agent named `base2` so the examples are self-contained. It is not the CLI's
full coding/orchestration agent. Coding hosts should supply their reviewed
agent definitions and tool permissions through `agentDefinitions`.

This host explicitly selects the provider file you reviewed, disables home and
global discovery, and keeps harness state in the current workspace. Set the
existing `OPENBUFF_PROVIDER_CONFIG` variable to select a different reviewed
file. Explicit selection is a host trust decision, not permission to trust
arbitrary repository-supplied configuration. It does not automatically trust
project agents, skills or MCP startup. The sample disables indexing because
these prompts need no repository retrieval; ordinary coding hosts can enable
it. No example setup step creates or modifies user-global configuration.

## Per-run model and validated structured output

Run `bun structured-output.ts` with the shared setup. `model` selects a
configured primary for this run and its descendants without changing agent
templates or provider files. Configured failover still applies. Invalid or
unconfigured model IDs fail instead of silently selecting another primary.

<!-- sdk-example: structured-output.ts -->
```ts
import { OpenbuffClient } from '@openbuff/sdk'
import { clientOptions } from './example-setup'

const client = new OpenbuffClient(clientOptions)
try {
  const result = await client.run({
    agent: 'base2',
    model: 'local/qwen3-coder:30b',
    prompt: 'Return a greeting as summary and an empty changedFiles array. Do not run workspace tools.',
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1 },
        changedFiles: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
      required: ['summary', 'changedFiles'],
      additionalProperties: false,
    },
  })
  if (result.output.type === 'error') throw new Error(result.output.message)
  if (result.output.type !== 'structuredOutput' || result.output.value === null)
    throw new Error('No validated structured output was returned')
  console.log('Structured output:', JSON.stringify(result.output.value))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
```

`outputSchema` is a **root-only, per-run JSON Schema draft-7 contract** with
`type: 'object'`. The SDK captures plain, acyclic JSON before asynchronous
setup, bounded to 64 KiB, 4,096 nodes and depth 32. Inline the schema: actual
schema-reference `$ref` keywords, including local references, are refused; no
external references are fetched. Ordinary output-property names and literal
annotation/constant data may contain `$ref`. Accessors, serialization hooks, unsupported dialects and invalid
schemas are refused rather than executed or silently relaxed.

The runtime supplies the root reporting tool and validates its structured
output without coercing types, adding defaults or removing extra properties.
Check for non-null `structuredOutput` as above; an arbitrary last message or
missing output is not a validated result. This option does not install a
schema on templates or descendants. These examples use the in-process backend;
they do not imply ACP remote model/schema negotiation.

## Continue a conversation

Run `bun continuation.ts`. Pass the **whole returned `RunState`** as
`previousRun`, not just its output. Treat session state as private: it can
contain source, prompts and tool history. Keep it with its owning workspace
and do not treat restored state as fresh approval or read authority.

<!-- sdk-example: continuation.ts -->
```ts
import { OpenbuffClient } from '@openbuff/sdk'
import { clientOptions } from './example-setup'

const client = new OpenbuffClient(clientOptions)
try {
  const first = await client.run({
    agent: 'base2',
    model: 'local/qwen3-coder:30b',
    prompt: 'Remember the word ORCHID-27; repeat it without tools.',
  })
  if (first.output.type === 'error') throw new Error(first.output.message)
  const next = await client.run({
    agent: 'base2',
    prompt: 'What word did I ask you to remember? Answer without tools.',
    previousRun: first,
  })
  if (next.output.type === 'error') throw new Error(next.output.message)
  console.log('Continued output:', JSON.stringify(next.output))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
```

The second turn keeps conversation context but returns to configured model
routing. Run-scoped `model` and `outputSchema` do **not** persist through
`previousRun`; supply them again when wanted. Live workspace context is
refreshed, and restored security maps are sanitized.

## Reference

### Host configuration, credentials and trust

Each run captures host configuration, provider credentials and read roots
before setup. Without explicit `hostConfiguration`, the SDK uses normal
local configuration discovery. `configReadFs` can inject the synchronous
configuration reader; it does not silently fall back to another reader.
An unreadable required selection makes the run unavailable. Disabled globals
read no global config or OAuth store; `home: { kind: 'none' }` also disables
home knowledge/agent discovery.

`env` and `inheritEnv` control child commands, **not** SDK provider selection
or credentials. `inheritEnv: false` supplies only the chosen child environment
before credential scrubbing; an explicit `undefined` removes an entry. Keep
provider credentials on the host-only configuration/credential boundary.
Neither child environment control nor tool filtering is OS isolation.

Project configuration can only tighten policy until trusted. SDK hosts can
select `trustProjectConfig`; with explicit `hostConfiguration`, use its
`trust.projectConfig` instead (`'trusted'` or `'untrusted'`). Ancestor config
trust, additional readable-root trust and execution trust are separate grants.
Do not grant them merely because a model or repository asks.

### Filesystem broker and authenticated read anchors

Filesystem tools operate through `CodebuffFileSystem`. With `cwd`, no custom
`fsSource`, and an available harness state root, a run creates a
workspace-scoped `WorkspaceMutationBroker` for the Node adapter. The ordinary
state root is the Openbuff config directory's `state/harness`; the shared
setup chooses `.openbuff/harness` instead. Broker failures leave guarded
mutations fail-closed, not silently unguarded.

Structured `read_files` v1 results are the native run surface. Fresh complete
reads carry **opaque authenticated `cap.v4` read anchors**, bound to the
project, normalized path, run and authenticated original raw basis. Copy an
anchor only to its matching edit target; never construct or decode one as a
host authorization shortcut. Whole-file writes need a whole-file basis;
line/structural reads retain scoped authority. Truncated reads mint no fresh
edit authority. Exact confirmed after-content receipts can refresh raw
authority; invalidation removes stale anchors. Historical anchors do not
provide fresh raw edit authority.

The broker provides conditional commit/delete/move and exclusive create.
This is **cooperative CAS among participating Openbuff processes**, not
kernel-enforced exclusion against external editors. Workspace revision checks
and filesystem watching remain the backstop for outside changes. The bare
`createNodeFileSystem()` deliberately omits conditional mutation authority.
For direct host use, create a `WorkspaceMutationBroker` with your workspace
and owned state directory, then pass it as the Node adapter's `mutationBroker`.
Broker/journal factories capture bootstrap host authority once; observed Git
identity or an observed non-Git filesystem fallback selects the workspace.
Permission/I/O errors, empty Git responses and execution refusals cannot
silently select a different identity.

Custom adapters should declare only capabilities they can guarantee:

| Capability | Required guarantee |
| --- | --- |
| `readTextRange` | Bounded text-range reads, including files larger than 10 MB. |
| `streamDirectory` | A promise of an async iterable; its `return()` releases directory handles, and `readdirView` is the adapter's current `readdir`. |
| `createFileExclusive` | Collision-free exclusive creation. |
| `conditionalCommit` | Exact expected-state check and guarded overwrite. |
| `conditionalDelete` | Exact-byte expected-hash deletion. |
| `conditionalMove` | Expected source hash and absent destination. |

A mis-paired `readdirView` silently disables lazy directory streaming and
falls back to full materialization. Check the completed adapter with
`supportsStreamDirectory()`, not member presence. Virtual/remote filesystem
hosts must separately override or disable process-backed tools when the local
process does not represent that workspace. `code_search` and
`find_files_matching_content` accept a realpath-resolved, existing directory
`cwd` outside the project; missing, unreadable or file roots fail. This does
not relax containment for terminal or other read/exec tools.

### Sandbox and execution enforcement

Agent filesystem access is **unrestricted by default**. The sample explicitly
opts into `sandbox.mode: 'project'`, a tool-level containment policy. Trusted
`sandbox.allowPaths` grants additional writable paths; `readableRoots` grants
read-only exceptions. See [filesystem sandbox](../docs/configuration.md#filesystem-sandbox).
The portable backend applies path checks and a scrubbed child environment,
but does not enforce OS filesystem/network isolation or certify process-tree
death. A remote filesystem adapter alone cannot change that.

`executionProfile` declares policy, preferred backend and required capabilities;
missing required capabilities return unavailable rather than proving isolation.
Native execution requires a verified host installation and supported platform.
Plan-lineage terminal commands require verified native read-only enforcement;
portable fallback, approval and terminal overrides cannot bypass that gate.
See [execution backend](../docs/configuration.md#execution-backend).
`recordExecution` separates planned, admitted, dispatched and observed starts;
only an actual runtime PID/event is an observed start, not dispatch or reuse.

### High-impact action approvals and terminal profiles

`approvalMode` chooses how classified terminal effects are admitted:

- `balanced` (default): routine dependency changes, commits, feature-branch
  pushes, pull requests, downloads, reads, project scripts, pipelines/tests
  and staged-only restore do not prompt. Destructive workspace/history
  operations, default-branch pushes, deployment/release/migration,
  uploads/remote shells, interpreter evaluation and unknown executable adapters
  require approval. Ordinary pipes, project-script substitution and normal
  background jobs are not automatically arbitrary code.
- `strict`: asks for every classified package, Git, remote or destructive effect.
- `allow-all`: auto-approves classified effects, but is not a sandbox or a
  bypass for mandatory authority, containment or protected-action checks.

`requestApproval` pauses the same tool call and returns a decision. A grant
issues a single-use receipt bound to repository, workspace, root run, exact
action and current snapshot. Hosts may pre-create receipts with
`HarnessApprovalService` and supply `approvalReceiptIds`. Wrong-scope or stale
receipts are rejected; agents cannot mint or broaden them. Client-origin MCP
process startup requires its separate approval, not merely tool approval.

The runtime forwards an agent's `terminalPermissionProfile` to terminal
handlers/overrides. Declared `read-only` and `workspace-write` policies are
additional upper bounds on the captured host profile, not replacements.
Task-specific profiles are not all runtime-bound yet. The exported
`evaluateTerminalCommandPolicy` can evaluate their lexical rules directly;
its `mode: 'user'` bypass and `full-access` result are not proof of OS safety.

| Profile | Lexical policy summary |
| --- | --- |
| `read-only` | Inspection; no writes, dependency/Git mutation, unsafe redirection or interpreter escapes. |
| `workspace-write` | General contained writes and ordinary shell flow; environment dumps still denied. |
| `validation-diagnosis` | Inspection plus contained debug-output writes and in-project parent references. |
| `git-commit` | Owned-path staging, meaningful non-amend commits and explicit non-force feature pushes; no data-loss/history rewrite. |
| `dependency-mutation` | Supported ecosystem dependency operations; no global installs or composed shell payloads. |
| `tmux-test` | Strict inspection; shell fixture creation is not authorized. |
| `librarian-read-only` | Read-only plus a narrow shallow GitHub clone into a librarian temporary directory. |
| `full-access` | Bypasses lexical policy gates; approvals still apply. |

For policy evaluation, `projectRoot` anchors containment, optional `cwd`
resolves relative paths, and `allowedPaths` is required for owned Git staging.
Non-full-access rules retain outside-path/escape and environment-dump denials;
exact exceptions differ by profile. Prefer authored project scripts over
inline interpreter evaluation. Approval classification and lexical policy
are distinct checks, neither of which provides OS enforcement.

### Deadlines and process lifetimes

`runTimeoutMs` opts into an overall wall-clock deadline beginning **before
configuration capture**; omitted means no automatic run timeout.
`maxAgentSteps` and `maxMissingOutputRetries` are explicit budgets, not new
default cutoffs. Finite parent deadlines and caller cancellation still apply.

To include earlier asynchronous preparation, capture a deadline first and
pass `runDeadline`. This complete example deliberately selects 30 seconds;
run it with `bun deadline.ts` and the shared setup:

<!-- sdk-example: deadline.ts -->
```ts
import { access } from 'node:fs/promises'
import { captureRunDeadline, OpenbuffClient } from '@openbuff/sdk'
import { clientOptions } from './example-setup'

try {
  const deadline = captureRunDeadline(30_000)
  if (!deadline.ok) throw new Error(deadline.cause)
  await access(process.cwd())
  const client = new OpenbuffClient(clientOptions)
  const result = await client.run({
    agent: 'base2',
    prompt: 'Say ready without running tools.',
    runDeadline: deadline.value,
  })
  if (result.output.type === 'error') throw new Error(result.output.message)
  console.log('Deadline output:', JSON.stringify(result.output))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
```

A concurrent `runTimeoutMs` can shorten the captured expiry. Seeds must come
from the same loaded SDK clock instance; expired, malformed or foreign-clock
seeds refuse before configuration/native setup. They contain clock coordinates,
not credentials or authorization tokens.

Direct process helpers need registered host execution authority. Use
`createConfiguredDirectHostExecution` for a configuration-based host boundary,
or `createDirectHostExecution` for an explicitly selected host context. Pass
its `executionContext`, captured `terminalShell` and launch metadata to
`runTerminalCommand`; context-free helpers return a structured refusal.

SYNC stdin is closed (prompts read EOF). Omitting `timeout_seconds` adds no
automatic local timeout. Explicit tool caps include approval/startup; a
selected `terminalTimeoutPolicy.defaultSyncSeconds` starts after admission.
`maxSeconds` and `allowUnbounded` select further host limits. Configured hooks
have no default local time cap; a positive `timeoutSeconds` opts into one.
Finite parent caps and cancellation still apply. Hook inference runs only
when `autoFileChangeHooks` is explicitly true. See
[terminal timeout policy](../docs/configuration.md#terminal-timeout-policy).
A SYNC result can carry `idleOutputHint` after 30 seconds without output;
timeout/cancellation preserves partial output.

Attached BACKGROUND jobs (`detach: false`) end with the host process on
natural exit, explicit exit and SIGINT/SIGTERM/SIGHUP. Without another signal
handler, SDK cleanup precedes exit with 128 + signal number. Detachment
transfers ownership to a registered session receiver before admission; its
receiver lifetime and original finite cap survive the host. This does not
certify OS process-tree death. Run-owned LSP/MCP request leases can be released
when a waiter cancels while the registered run still owns the process; every
terminal run path ends the run lifetime and closes captured MCP clients.
Sharing remains scoped to host, owner, configuration and lifetime.

### Outcomes and cancellation

Use a caller-owned `AbortSignal` through `signal` to request cancellation.
Native reads, images, patches and hooks receive the run signal. Portable
filesystem commits already in progress can still finish; cancellation is
cooperative, not a rollback guarantee.

- `runOutcome` describes execution termination; `taskAcceptance` separately
  describes accepted/rejected/unknown task evidence. `actionOutcomes` describes
  individual tool attempts; `executionCleanup` carries physical cleanup facts.
- Mutation `applied` means final state was verified and an authority receipt
  issued; `not_applied` means authority proved no requested action committed.
- `unconfirmed` means final disk state cannot be established; re-read before
  retrying. An authoritative mutation result can arrive after interruption.
- `onFilesystemMutation` is awaited for precise confirmed path/action/hash
  synchronization; `onFilesChanged` is a best-effort compatibility callback.
- External mutation overrides remain `unconfirmed` unless the host's
  `verifyExternalMutation` attests the canonical v1 result. Self-certified
  remote results do not automatically acquire local authority.

### Public helpers and executable documentation tests

The package root exports `OpenbuffClient`, `run`, structured read/mutation
helpers, `FilesystemAuthority`, broker/journal factories, Node adapters,
capability detection/types and the `ToolHelpers` namespace, plus the public
run/configuration/tool contracts needed by host integrations.

From this checkout, execute and typecheck **every TypeScript fence**:

```sh
bun --no-env-file --no-install test ./sdk/e2e/readme-examples.test.ts
```

The test runs the actual SDK/runtime with a keyless loopback fake provider,
owned temporary workspaces/config/harness directories, forbidden external
fetches and bounded child deadlines. It checks natural child exit and cleanup,
streaming/final output, model selection, structured validation and continuation.
No user HOME/config changes, model mocks, installs or builds are needed.
For an already-built public-consumer rerun, explicitly select its index:

```sh
OPENBUFF_README_SDK_INDEX="$PWD/sdk/dist/index.mjs" bun --no-env-file --no-install test ./sdk/e2e/readme-examples.test.ts
```
