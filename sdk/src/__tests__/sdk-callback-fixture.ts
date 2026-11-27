import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createRunMcpExecution } from '../services/run-mcp-execution'

import type { callMainPrompt } from '@codebuff/agent-runtime/main-prompt'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { Result } from '@codebuff/common/types/contracts/execution-context'
import type { MCPConfig, MCPConfigOrigin } from '@codebuff/common/types/mcp'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { OpenbuffClientOptions } from '../run'

export type SdkCallbackParams = Parameters<typeof callMainPrompt>[0]
type CallbackCall = { toolName: string; input: unknown; userInputId?: string }

export function sdkCallbackOptions(
  cwd: string,
  overrides: OpenbuffClientOptions = {},
): OpenbuffClientOptions {
  return {
    apiKey: 'test-key',
    projectFiles: {},
    knowledgeFiles: {},
    fsSource: createMockFs(),
    handleEvent: () => {},
    ...overrides,
    cwd,
    hostConfiguration: overrides.hostConfiguration ?? {
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: cwd,
      projectRoot: cwd,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  }
}

/** Physical process cwd and state; tested files can remain entirely virtual. */
export function createSdkCallbackFixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `openbuff-sdk-callback-${label}-`))
  const cwd = path.join(root, 'project')
  const harnessStateDir = path.join(root, 'harness')
  mkdirSync(cwd)
  return {
    cwd,
    harnessStateDir,
    file: (relativePath: string) => path.join(cwd, relativePath),
    options: sdkCallbackOptions(cwd, { harnessStateDir }),
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Register through the same SDK callbacks used by the real agent loop. */
export async function beginSdkCallback(params: SdkCallbackParams) {
  const sessionState = params.action.sessionState
  const agentState = sessionState.mainAgentState
  if (typeof params.action.agentId !== 'string')
    throw new Error('SDK callback fixture requires the actual agent template id')
  const registration = {
    ...params,
    agentId: params.action.agentId,
    agentState,
    ancestorRunIds: [],
  }
  const runId = await params.startAgentRun(registration)
  if (!runId) throw new Error('SDK callback fixture did not register its root run')
  agentState.runId = runId
  const prepare = async (call: CallbackCall) => {
    if (!params.onExecutionActionStart)
      throw new Error('SDK callback fixture requires the real action-start callback')
    const basis = {
      inputHash: hashActionInput(call.toolName, call.input),
      ...(agentState.workspaceState
        ? { workspaceRevision: agentState.workspaceState.revision }
        : {}),
    }
    const workspaceSnapshotId = agentState.workspaceState?.snapshotId
    const identity: ToolExecutionIdentity = {
      rootRunId: runId,
      runId,
      agentId: agentState.agentId,
      actionId: randomUUID(),
      attemptId: randomUUID(),
      basis,
      ...(workspaceSnapshotId ? { workspaceSnapshotId } : {}),
      basisId: hashActionInput('openbuff.execution-b02-basis.v1', {
        basis,
        workspaceSnapshotId: workspaceSnapshotId ?? null,
      }),
    }
    await params.onExecutionActionStart({
      identity,
      toolName: call.toolName,
      input: call.input,
      signal: params.signal,
    })
    return {
      userInputId: params.promptId,
      callId: identity.actionId,
      toolName: call.toolName,
      input: call.input as Parameters<typeof params.requestToolCall>[0]['input'],
      signal: params.signal,
      executionIdentity: identity,
      executionRequestHash: hashActionInput(call.toolName, call.input),
    }
  }
  return {
    sessionState,
    runId,
    agentId: agentState.agentId,
    prepare,
    request: async (call: CallbackCall) =>
      params.requestToolCall(await prepare(call)),
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** Real owned JSON-RPC peer for the tool-approval tests, with separate process policy. */
export function createSdkCallbackMcpFixture(
  cwd: string,
  origin: MCPConfigOrigin,
  options: { approvalMode?: OpenbuffClientOptions['approvalMode'] } = {},
) {
  const script = path.join(cwd, 'callback-mcp-peer.cjs')
  const callsPath = path.join(cwd, 'callback-mcp-calls.jsonl')
  writeFileSync(script, String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'callback-peer', version: '1' },
  };
  else if (request.method === 'tools/list') result = {
    tools: [{ name: 'search', inputSchema: { type: 'object' } }],
  };
  else if (request.method === 'tools/call') {
    fs.appendFileSync(process.argv[2], JSON.stringify(request.params) + '\n');
    result = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
  }
  else throw new Error('Unknown fixture request');
  send({ jsonrpc: '2.0', id: request.id, result });
});
`)
  const config = {
    type: 'stdio' as const,
    command: process.execPath,
    args: [script, callsPath],
    env: {},
  }
  markMCPConfigOrigin(config, origin)
  const captured = loadHostConfigSnapshot({
    inputs: sdkCallbackOptions(cwd).hostConfiguration!,
    fs: nodeConfigReadFs,
  })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const basisId = createHash('sha256').update(readFileSync(script)).digest('hex')
  const stop = new AbortController()
  let dispatches = 0
  const spawn: CodebuffSpawn = (command, argv, spawnOptions) => {
    dispatches++
    return nodeSpawn(command, [...argv ?? []], spawnOptions ?? {})
  }
  const host = unwrap(createHostExecutionServices({
    snapshot: captured.snapshot,
    boundary: unwrap(captureRootDeadline({
      clock: executionClock,
      limit: { kind: 'unbounded' },
    })),
    childInheritanceEnvironment: captured.snapshot.inputs.environment,
    signal: stop.signal,
    spawn,
    approvalMode: options.approvalMode,
    isCurrentBasis: correlation => correlation.kind === 'action' &&
      correlation.basisId === basisId &&
      createHash('sha256').update(readFileSync(script)).digest('hex') === basisId,
  }))
  const runId = randomUUID()
  const scope = unwrap(host.registerRun({
    clientSessionId: 'sdk-callback-mcp',
    rootRunId: runId,
    parentRunId: runId,
    parentAgentId: 'callback-mcp-fixture',
  }))
  const mcp = createRunMcpExecution({
    snapshot: captured.snapshot,
    authority: host.execution,
    rootLifetime: host.rootLifetime,
    spawn,
  })
  return {
    config,
    get events() { return host.events },
    dispatches: () => dispatches,
    calls: () => {
      try { return readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).length }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    },
    resolve: (requested: MCPConfig) => mcp.request(
      requested,
      scope,
      unwrap(scope.action({
        actionId: randomUUID(),
        attemptId: randomUUID(),
        basisId,
      })),
    ),
    close: async () => {
      try { await mcp.dispose() }
      finally { stop.abort(new Error('SDK callback MCP fixture disposed')) }
    },
  }
}
