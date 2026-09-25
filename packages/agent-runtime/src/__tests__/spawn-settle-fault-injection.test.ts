import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { mockFileContext } from './test-utils'
import * as runAgentStep from '../run-agent-step'
// The REAL module is loaded first so the mock factory below can delegate to it.
import * as spawnAgentUtilsReal from '../tools/handlers/tool/spawn-agent-utils'
import { waitForBackgroundAgentJob } from '../util/background-agent-jobs'
import {
  acquireWorkspacePathLease,
  releaseWorkspacePathLease,
} from '../util/workspace-path-leases'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

// M2-T1 fault injection: a throw at each spawn settle step must leave zero
// active workspace-path leases and zero dangling spawn_started ledger events.
// ESM exports are readonly bindings, so the fault is injected by mocking the
// shared spawn-agent-utils module BEFORE the handlers are dynamically
// imported — the handlers then bind the wrapper, which delegates to the real
// implementations unless a one-shot fault counter is armed.
const INJECTED_ERROR = 'injected settle fault'
let buildFaultsRemaining = 0
let reconcileFaultsRemaining = 0
// The wiring-loop fault fires on the Nth extractSubagentContextParams call
// (N > 1 lets earlier background coroutines launch and wire first).
let extractCalls = 0
let extractFaultAtCall = 0

// Capture the real implementations BEFORE mock.module registers: after
// registration, bun resolves value reads on this namespace through the mock
// registry, so delegating via spawnAgentUtilsReal.<fn>(...) inside the
// factory re-enters the wrapper itself (infinite self-recursion that only
// manifests when the fault is NOT armed at build time, i.e. the
// receipt-reconcile test). Local consts are bound before registration and
// stay bound to the real functions.
const realBuildRuntimeAgentReceipt =
  spawnAgentUtilsReal.buildRuntimeAgentReceipt
const realReconcileAgentReceiptIntoParent =
  spawnAgentUtilsReal.reconcileAgentReceiptIntoParent
const realExtractSubagentContextParams =
  spawnAgentUtilsReal.extractSubagentContextParams
const realSpawnAgentUtils = { ...spawnAgentUtilsReal }

mock.module('../tools/handlers/tool/spawn-agent-utils', () => ({
  ...realSpawnAgentUtils,
  buildRuntimeAgentReceipt: (args: Parameters<
    typeof spawnAgentUtilsReal.buildRuntimeAgentReceipt
  >[0]) => {
    if (buildFaultsRemaining > 0) {
      buildFaultsRemaining -= 1
      throw new Error(INJECTED_ERROR)
    }
    return realBuildRuntimeAgentReceipt(args)
  },
  reconcileAgentReceiptIntoParent: (args: Parameters<
    typeof spawnAgentUtilsReal.reconcileAgentReceiptIntoParent
  >[0]) => {
    if (reconcileFaultsRemaining > 0) {
      reconcileFaultsRemaining -= 1
      throw new Error(INJECTED_ERROR)
    }
    return realReconcileAgentReceiptIntoParent(args)
  },
  extractSubagentContextParams: (args: Parameters<
    typeof spawnAgentUtilsReal.extractSubagentContextParams
  >[0]) => {
    extractCalls += 1
    if (extractFaultAtCall === extractCalls) {
      throw new Error(INJECTED_ERROR)
    }
    return realExtractSubagentContextParams(args)
  },
}))

// Handlers are imported AFTER the module mock so their bindings resolve
// through the fault-injecting wrapper.
const { handleSpawnAgentInline } = await import('../tools/handlers/tool/spawn-agent-inline')
const { handleSpawnAgents } = await import('../tools/handlers/tool/spawn-agents')

/** Every spawn_started must have a terminal pair (finished or interrupted). */
function assertNoDanglingSpawns(parent: AgentState): void {
  const events = parent.orchestrationLedger?.events ?? []
  const finished = new Set(
    events
      .filter((event) => event.type === 'spawn_finished')
      .map((event) => event.spawnId),
  )
  const interrupted = new Set(
    events.flatMap((event) =>
      event.type === 'interrupted' && event.subjectType === 'spawn'
        ? [event.subjectId]
        : [],
    ),
  )
  const started = events.filter((event) => event.type === 'spawn_started')
  expect(started.length).toBeGreaterThan(0)
  for (const event of started) {
    expect(
      finished.has(event.spawnId) || interrupted.has(event.spawnId),
    ).toBe(true)
  }
}

/** No lease may remain 'active' after a settled (or failed) spawn. */
function assertNoActiveLeases(parent: AgentState): void {
  for (const lease of parent.workspacePathLeases ?? []) {
    expect(lease.status).not.toBe('active')
  }
}

/** Number of spawn_started events in the parent's ledger. */
function countSpawnStarted(parent: AgentState): number {
  return (
    parent.orchestrationLedger?.events.filter(
      (event) => event.type === 'spawn_started',
    ).length ?? 0
  )
}

/** Strict v1 handoff whose non-empty writablePaths mints a real lease. */
const faultHandoff = {
  schemaVersion: 1 as const,
  taskId: 'task-m2t1-fault',
  role: 'editor' as const,
  objective: 'Fault-injection probe for spawn settle teardown',
  requirements: [{ id: 'R1', text: 'Probe', required: false }],
  acceptanceCriteria: [{ id: 'A1', behavior: 'Probe', verification: 'Test' }],
  context: [] as never[],
  nonGoals: [],
  findings: [],
  permissions: {
    readablePaths: [],
    writablePaths: ['src/fault-probe.ts'],
    allowedTools: [],
  },
}

describe('spawn settle fault injection (M2-T1)', () => {
  const createMockAgent = (
    id: string,
    spawnableAgents: string[] = [],
  ): AgentTemplate => ({
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents,
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  })

  let parentAgent: AgentTemplate
  let childAgent: AgentTemplate
  let baseParams: Record<string, unknown>

  beforeEach(() => {
    parentAgent = createMockAgent('parent', ['thinker'])
    childAgent = createMockAgent('thinker')
    baseParams = {
      ...TEST_AGENT_RUNTIME_IMPL,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      previousToolCallFinished: Promise.resolve(),
      repoId: undefined,
      repoUrl: undefined,
      sendSubagentChunk: mock(() => {}),
      signal: new AbortController().signal,
      system: 'Test system prompt',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
    }
    spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(async (options) => {
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [assistantMessage('Mock agent response')],
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
      }
    })
  })

  afterEach(() => {
    mock.restore()
    buildFaultsRemaining = 0
    reconcileFaultsRemaining = 0
    extractCalls = 0
    extractFaultAtCall = 0
  })

  it('inline: receipt-build fault releases the lease and closes the ledger pair', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    buildFaultsRemaining = 1
    await expect(
      handleSpawnAgentInline({
        ...baseParams,
        tools: {},
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agent_inline',
          toolCallId: 'inline-build-fault',
          input: {
            agent_type: 'thinker',
            prompt: 'Probe',
            handoff: faultHandoff,
          },
        },
      } as never),
    ).rejects.toThrow(INJECTED_ERROR)

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
    // The interrupted event specifically closed the pair.
    const events = parent.orchestrationLedger?.events ?? []
    expect(
      events.some(
        (event) => event.type === 'interrupted' && event.subjectType === 'spawn',
      ),
    ).toBe(true)
  })

  it('inline: receipt-reconcile fault releases the lease and closes the ledger pair', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
        reconcileFaultsRemaining = 1
    await expect(
      handleSpawnAgentInline({
        ...baseParams,
        tools: {},
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agent_inline',
          toolCallId: 'inline-reconcile-fault',
          input: {
            agent_type: 'thinker',
            prompt: 'Probe',
            handoff: faultHandoff,
          },
        },
      } as never),
    ).rejects.toThrow(INJECTED_ERROR)

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
  })

  it('background: settle fault still releases the lease and settles the job', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    // Arm BEFORE the spawn: with the mocked loopAgentSteps the job settles
    // immediately, so the success-settle buildRuntimeAgentReceipt call can fire
    // before handleSpawnAgents returns; arming here guarantees the fault fires
    // at that settle step.
    buildFaultsRemaining = 1
    const { output } = await handleSpawnAgents({
      ...baseParams,
      agentState: parent,
      agentTemplate: parentAgent,
      localAgentTemplates: { thinker: childAgent },
      toolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'bg-fault',
        input: {
          agents: [
            {
              agent_type: 'thinker',
              prompt: 'Probe',
              background: true,
              handoff: faultHandoff,
            },
          ],
        },
      },
    } as never)

    const match = JSON.stringify(output).match(/bg-agent-[A-Za-z0-9-]+/)
    expect(match).not.toBeNull()
    const jobId = match![0]

    const settled = await waitForBackgroundAgentJob(jobId, {
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(settled?.state).toBe('error')

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
    const intent = parent.backgroundAgentJobs?.find(
      (entry) => entry.jobId === jobId,
    )
    expect(intent?.status).toBe('error')
    expect(String(intent?.error)).toContain(INJECTED_ERROR)
  })

  it('inline success path keeps the happy-path contract (regression)', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    const { output } = await handleSpawnAgentInline({
      ...baseParams,
      tools: {},
      agentState: parent,
      agentTemplate: parentAgent,
      localAgentTemplates: { thinker: childAgent },
      toolCall: {
        toolName: 'spawn_agent_inline',
        toolCallId: 'inline-success',
        input: {
          agent_type: 'thinker',
          prompt: 'Probe',
          handoff: faultHandoff,
        },
      },
    } as never)
    expect(JSON.stringify(output)).toContain('Mock agent response')

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
    const events = parent.orchestrationLedger?.events ?? []
    expect(
      events.some((event) => event.type === 'spawn_finished'),
    ).toBe(true)
  })

  it('inline: lease-acquisition fault leaves no spawn_started behind', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    // A foreign owner already holds the exact writable path the spawn wants:
    // acquisition must reject with a lease conflict BEFORE any ledger event,
    // so the failure leaves no dangling spawn_started to close.
    const foreignLeaseId = acquireWorkspacePathLease({
      state: parent,
      projectRoot: mockFileContext.projectRoot,
      ownerAgentId: 'foreign-owner',
      paths: ['src/fault-probe.ts'],
    })
    expect(foreignLeaseId).toBeDefined()
    await expect(
      handleSpawnAgentInline({
        ...baseParams,
        tools: {},
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agent_inline',
          toolCallId: 'inline-lease-fault',
          input: {
            agent_type: 'thinker',
            prompt: 'Probe',
            handoff: faultHandoff,
          },
        },
      } as never),
    ).rejects.toThrow('Workspace path lease conflict')

    expect(countSpawnStarted(parent)).toBe(0)
    // The conflicting acquisition left no durable entry of its own; release
    // the pre-armed foreign lease so the assertion below sees a clean state.
    releaseWorkspacePathLease(parent, foreignLeaseId)
    assertNoActiveLeases(parent)
  })

  it('foreground batch: receipt-build fault releases the lease and closes the ledger pair', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    buildFaultsRemaining = 1
    await expect(
      handleSpawnAgents({
        ...baseParams,
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agents',
          toolCallId: 'fg-build-fault',
          input: {
            agents: [
              {
                agent_type: 'thinker',
                prompt: 'Probe',
                handoff: faultHandoff,
              },
            ],
          },
        },
      } as never),
    ).rejects.toThrow(INJECTED_ERROR)

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
    // The interrupted event specifically closed the pair (the terminal receipt
    // was never reconciled), and the claimed discovery shard was completed as
    // interrupted rather than stranded active.
    const events = parent.orchestrationLedger?.events ?? []
    expect(
      events.some(
        (event) => event.type === 'interrupted' && event.subjectType === 'spawn',
      ),
    ).toBe(true)
    for (const shard of parent.discoveryCoverage?.shards ?? []) {
      expect(shard.status).not.toBe('active')
    }
  })

  it('foreground batch: receipt-reconcile fault releases the lease and closes the ledger pair', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    reconcileFaultsRemaining = 1
    await expect(
      handleSpawnAgents({
        ...baseParams,
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agents',
          toolCallId: 'fg-reconcile-fault',
          input: {
            agents: [
              {
                agent_type: 'thinker',
                prompt: 'Probe',
                handoff: faultHandoff,
              },
            ],
          },
        },
      } as never),
    ).rejects.toThrow(INJECTED_ERROR)

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
  })

  it('background launch fault: rollback leaves coroutine-owned agents untouched', async () => {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    // Two background agents. The wiring loop's SECOND
    // extractSubagentContextParams call throws AFTER the first agent's
    // coroutine was already launched and wired: rollback must skip that
    // agent (its settle handlers own the lease, shard, and ledger closure)
    // and still roll back the never-launched second one.
    extractFaultAtCall = 2
    await expect(
      handleSpawnAgents({
        ...baseParams,
        agentState: parent,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agents',
          toolCallId: 'bg-wired-rollback',
          input: {
            // Both agents are BACKGROUND: the wiring-loop catch (with its
            // rollbackValidatedClaims skip for wired agents) only runs for
            // background spawns — foreground faults are captured by the
            // Promise.allSettled aggregation instead of rejecting.
            agents: [
              { agent_type: 'thinker', prompt: 'Probe one', background: true },
              { agent_type: 'thinker', prompt: 'Probe two', background: true },
            ],
          },
        },
      } as never),
    ).rejects.toThrow(INJECTED_ERROR)

    // Ledger order matches batch order: the first spawn_started belongs to
    // the wired job, the second to the abandoned one.
    const events = parent.orchestrationLedger?.events ?? []
    const startedIds = events
      .filter((event) => event.type === 'spawn_started')
      .map((event) => event.spawnId)
    expect(startedIds.length).toBe(2)
    const [wiredSpawnId, abandonedSpawnId] = startedIds

    // The coroutine-owned agent still settled NORMALLY through its own settle
    // handlers: completed job and a spawn_finished ledger closure.
    const wiredIntent = parent.backgroundAgentJobs?.[0]
    expect(wiredIntent?.jobId).toBeDefined()
    const settled = await waitForBackgroundAgentJob(wiredIntent!.jobId, {
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(settled?.state).toBe('completed')
    expect(wiredIntent?.status).toBe('completed')
    expect(
      events.some(
        (event) =>
          event.type === 'spawn_finished' && event.spawnId === wiredSpawnId,
      ),
    ).toBe(true)
    // The exact regression: rollback must NOT have stamped an `interrupted`
    // event on the coroutine-owned agent (which would pair interrupted with
    // the finished settlement above) nor freed its lease mid-flight.
    expect(
      events.some(
        (event) =>
          event.type === 'interrupted' &&
          event.subjectType === 'spawn' &&
          event.subjectId === wiredSpawnId,
      ),
    ).toBe(false)
    // The never-launched agent is still rolled back: interrupted closure.
    expect(
      events.some(
        (event) =>
          event.type === 'interrupted' &&
          event.subjectType === 'spawn' &&
          event.subjectId === abandonedSpawnId,
      ),
    ).toBe(true)

    assertNoActiveLeases(parent)
    assertNoDanglingSpawns(parent)
  })
})
