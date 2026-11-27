import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { executeSubagent } from '@codebuff/agent-runtime/tools/handlers/tool/spawn-agent-utils'
import {
  acquireRenewingWorkspacePathLease,
  acquireWorkspacePathLease,
  releaseWorkspacePathLease,
} from '@codebuff/agent-runtime/util/workspace-path-leases'
import {
  createTestAgentRuntimeParams,
  mockFileContext,
  testLogger,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'

import { loadHostConfigSnapshot } from '../host-config'
import { createHostExecutionServices } from '../host-execution'
import { getAgentRuntimeImpl } from '../impl/agent-runtime'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { Result } from '@codebuff/common/types/contracts/execution-context'

const childTemplate: AgentTemplate = {
  id: 'b16-child',
  displayName: 'B16 child',
  model: 'b16-offline',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['read_files'],
  spawnableAgents: [],
  spawnerPrompt: '',
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
  // The real child joins the Unix bridge before this marker. Stay alive on
  // TERM while waiting on a controlled, read-only RPC so the test can
  // distinguish logical cancellation from kernel reaping.
  handleSteps: `function* ({ logger }) {
    process.on('SIGTERM', () => {});
    logger.info({ pid: process.pid }, 'b16-child-ready');
    yield { toolName: 'read_files', input: { paths: ['src/owned.ts'] } };
  }`,
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.cause)
  return result.value
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('B16 fixture timed out')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function fixture(authorizeAsync?: Parameters<typeof createHostExecutionServices>[0]['authorizeAsync']) {
  const actionAbort = new AbortController()
  const childAbort = new AbortController()
  const childReady = Promise.withResolvers<number>()
  const readStarted = Promise.withResolvers<void>()
  const releaseRead = Promise.withResolvers<void>()
  const projectRoot = `/virtual/b16-${crypto.randomUUID()}`
  const captured = loadHostConfigSnapshot({
    inputs: {
      environment: {},
      platform: 'linux',
      invocationCwd: projectRoot,
      projectRoot,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    fs: {
      readFile: () => { throw new Error('Unexpected config read') },
      stat: () => { throw new Error('Unexpected config stat') },
      readDirectory: () => { throw new Error('Unexpected config directory read') },
      realpath: (path) => path,
    },
  })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const clock = { domainId: 'b16-abort-fixture', nowMs: () => performance.now() }
  const host = value(createHostExecutionServices({
    snapshot: captured.snapshot,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })),
    clock,
    childInheritanceEnvironment: {},
    inheritEnv: false,
    authorizeAsync: authorizeAsync ?? (async () => ({ ok: true, basis: 'explicit-policy', decisionId: 'b16-allow' })),
  }))
  const parent = { ...getInitialAgentState(), agentId: 'b16-parent', runId: 'b16-parent-run' }
  const owner = {
    clientSessionId: 'b16-session',
    rootRunId: parent.runId,
    parentRunId: parent.runId,
    parentAgentId: parent.agentId,
  }
  const scope = value(host.registerRun(owner))
  const basis = { inputHash: hashActionInput('spawn_agents', { agents: [{ agent_type: childTemplate.id }] }) }
  const origin: ToolExecutionIdentity = {
    runId: parent.runId,
    rootRunId: parent.runId,
    agentId: parent.agentId,
    actionId: 'b16-spawn',
    attemptId: 'b16-attempt',
    basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }),
  }
  const executionContext = value(scope.action({ ...origin, signal: actionAbort.signal }))
  let lookups = 0
  const fixtureDeps = createTestAgentRuntimeParams()
  const runtime = getAgentRuntimeImpl({
    ...fixtureDeps,
    logger: testLogger,
    hostServices: host,
    processSupervision: true,
    supervisedExecutionForRequest: (request) => {
      ++lookups
      expect(request.executionIdentity).toEqual(origin)
      return executionContext
    },
    registerExecutionActor: () => {},
    onExecutionActionStart: () => {},
    sendAction: async () => {},
    sendSubagentChunk: () => {},
    requestFiles: async () => {
      readStarted.resolve()
      // A fixture failure must not leave the child blocked indefinitely.
      await bounded(releaseRead.promise, 6_000)
      return buildReadFilesResultV1([])
    },
    requestOptionalFile: async () => null,
    handleStepsLogChunk: ({ data, message }) => {
      if (
        message === 'b16-child-ready' &&
        data && typeof data === 'object' && 'pid' in data &&
        typeof data.pid === 'number' && Number.isSafeInteger(data.pid)
      ) {
        childReady.resolve(data.pid)
      }
    },
  } as Parameters<typeof getAgentRuntimeImpl>[0])
  const child = { ...getInitialAgentState(), agentId: 'b16-child-instance' }
  const paths = ['src/owned.ts']
  const competitor = getInitialAgentState()
  const acquireCompetingLease = () => acquireWorkspacePathLease({
    state: competitor,
    projectRoot,
    ownerAgentId: 'competitor',
    paths,
  })
  const start = (onRelease: () => void = () => {}) => {
    const release = acquireRenewingWorkspacePathLease({
      state: parent,
      projectRoot,
      ownerAgentId: child.agentId,
      paths,
      onHeartbeatError: (error) => { throw error },
    })!
    return executeSubagent({
      ...fixtureDeps,
      ...runtime,
      signal: childAbort.signal,
      agentState: child,
      parentAgentState: parent,
      agentTemplate: childTemplate,
      localAgentTemplates: { [childTemplate.id]: childTemplate },
      fileContext: { ...mockFileContext, projectRoot },
      ancestorRunIds: [],
      prompt: 'Wait for cancellation',
      spawnParams: undefined,
      repoUrl: undefined,
      repoId: undefined,
      userId: undefined,
      userInputId: 'b16-input',
      clientSessionId: owner.clientSessionId,
      executionIdentity: origin,
      fingerprintId: 'b16-fixture',
      onResponseChunk: () => {},
      system: '',
      tools: {},
    } as Parameters<typeof executeSubagent>[0]).finally(() => {
      onRelease()
      release()
    })
  }
  return {
    actionAbort,
    childAbort,
    childReady,
    readStarted,
    releaseRead,
    host,
    parent,
    start,
    acquireCompetingLease,
    releaseCompetingLease: (id: string | undefined) => releaseWorkspacePathLease(competitor, id),
    lookups: () => lookups,
  }
}

describe.skipIf(process.platform !== 'linux')('SDK-owned supervised abort settlement', () => {
  test('pre-abort does not admit or launch the built-in child', async () => {
    const f = fixture()
    f.childAbort.abort()
    await expect(f.start()).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.lookups()).toBe(0)
    expect(f.host.events).toHaveLength(0)
    expect(f.parent.workspacePathLeases?.[0]?.status).toBe('released')
  })

  test('a child-only abort retires its pending admission and cannot dispatch a late grant', async () => {
    const entered = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<{ ok: true; basis: 'explicit-policy'; decisionId: string }>()
    const f = fixture(async () => { entered.resolve(); return decision.promise })
    const running = f.start().then(() => null, (error: unknown) => error)
    try {
      await bounded(entered.promise, 2_000)
      f.childAbort.abort()
      expect(await bounded(running, 1_500)).toMatchObject({ name: 'AbortError' })
      expect(f.actionAbort.signal.aborted).toBe(false)
      expect(f.parent.workspacePathLeases?.[0]?.status).toBe('released')
      decision.resolve({ ok: true, basis: 'explicit-policy', decisionId: 'b16-late' })
      await Promise.resolve()
      expect(f.host.events.map(event => event.phase)).toEqual(['planned', 'no-launch'])
    } finally {
      f.actionAbort.abort()
      decision.resolve({ ok: true, basis: 'explicit-policy', decisionId: 'b16-late' })
      f.releaseRead.resolve()
      await bounded(running, 3_000).catch(() => {})
    }
  })

  test('a child-only abort reaps the authenticated Bun child before releasing its lease', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
      async () => { throw new Error('B16 fixture must never fetch') },
      { preconnect: () => { throw new Error('B16 fixture must never preconnect') } },
    ))
    const f = fixture()
    let pid: number | undefined
    let liveAtRelease: boolean | undefined
    const running = f.start(() => { liveAtRelease = pid !== undefined && existsSync(`/proc/${pid}`) })
    const result = running.then(() => null, (error: unknown) => error)
    try {
      pid = await bounded(Promise.race([
        Promise.all([f.childReady.promise, f.readStarted.promise]).then(([pid]) => pid),
        result.then((error) => { throw new Error(`Child did not reach readiness: ${String(error)}`) }),
      ]), 4_000)
      expect(existsSync(`/proc/${pid}`)).toBe(true)
      expect(f.host.events.some((event) => event.phase === 'spawn-observed' && event.pid === pid)).toBe(true)
      expect(f.acquireCompetingLease).toThrow('Workspace path lease conflict')

      f.childAbort.abort()
      expect(await bounded(result, 3_000)).toMatchObject({ name: 'AbortError' })
      expect(f.actionAbort.signal.aborted).toBe(false)
      expect(liveAtRelease).toBe(false)
      expect(existsSync(`/proc/${pid}`)).toBe(false)
      expect(f.parent.workspacePathLeases?.[0]?.status).toBe('released')
      const next = f.acquireCompetingLease()
      f.releaseCompetingLease(next)
      expect(next).toBeDefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      f.actionAbort.abort()
      f.releaseRead.resolve()
      await bounded(result, 3_000).catch(() => {})
      fetch.mockRestore()
    }
  }, 12_000)
})
