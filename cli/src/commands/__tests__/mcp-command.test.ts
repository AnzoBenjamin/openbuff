import { describe, expect, test } from 'bun:test'

import {
  runMcpCommand,
  type McpCommandArgs,
  type RunMcpDeps,
} from '../mcp-command'

import type { McpServerClient, McpSessionData } from '@openbuff/sdk'

/** The SDK's Memory V2 seam, derived the same way `mcp-command.ts` derives it. */
type McpMemorySession = NonNullable<McpSessionData['memory']>

const PROJECT_ID = 'test-project' as McpMemorySession['projectId']

/**
 * A schema-shaped lexical query outcome for the fake repository: an empty
 * retrieval result with no degradation. Never touches sqlite — the fake
 * `makeMemory` stub is the only memory path a test exercises (the default
 * impl opens the memory store eagerly).
 */
function fakeQueryOutcome(): Awaited<
  ReturnType<NonNullable<McpSessionData['memory']>['repository']['query']>
> {
  const base = {
    outcome: 'result',
    result: {
      schemaVersion: 2,
      queryId: 'test-query-1',
      projectId: PROJECT_ID,
      generatedAt: '2026-01-01T00:00:00.000Z',
      matchedTasks: [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    },
  }
  return base as unknown as Awaited<
    ReturnType<NonNullable<McpSessionData['memory']>['repository']['query']>
  >
}

type CapturedSessionData = McpSessionData
type InjectedExecutionContext = NonNullable<
  Parameters<NonNullable<RunMcpDeps['runMcpImpl']>>[0]['executionContext']
>
type MemoryQueryRequest = Parameters<
  NonNullable<McpSessionData['memory']>['repository']['query']
>[0]

/** A full schema-shaped retrieval request (opaque ids are brand-cast once). */
function fakeQueryRequest(): MemoryQueryRequest {
  const base = {
    schemaVersion: 2,
    queryId: 'test-query-1',
    projectId: PROJECT_ID,
    sessionId: 'test-session-1',
    query: 'test',
    selectors: [],
    artifactKinds: [],
    includeHistorical: true,
    maxResultsPerCategory: 10,
  }
  return base as unknown as MemoryQueryRequest
}

/**
 * Minimal harness mirroring the other command tests: every dependency is
 * injected so nothing real (index, memory sqlite, stdio) is ever opened.
 */
function makeHarness(makeMemory: RunMcpDeps['makeMemory']) {
  const stderrLines: string[] = []
  const captured: { sessionData?: CapturedSessionData } = {}
  // Reference-only context: the injected MCP server never dispatches it.
  const executionContext = {} as InjectedExecutionContext
  const deps: RunMcpDeps = {
    runMcpImpl: async (options) => {
      captured.sessionData = options.sessionData
      return { close: async () => {} }
    },
    makeClient: () => ({
      fileSystem: {
        readFile: async () => null,
      } as unknown as McpServerClient['fileSystem'],
    }),
    makeIndex: () => undefined,
    makeMemory,
    makeExecution: async () => ({
      ok: true,
      value: {
        executionContext,
        hostServices: {
          directOperation: () => ({
            ok: true,
            value: { executionContext },
          }),
        },
        close: async () => [],
      },
    }),
    projectRoot: '/tmp/fake-project-root',
    writeStderr: (line: string) => {
      stderrLines.push(line)
    },
  }
  return {
    deps,
    stderrLines,
    sessionData: () => captured.sessionData,
  }
}

describe('runMcpCommand memory seam', () => {
  const args: McpCommandArgs = {}

  test('a makeMemory session is forwarded into sessionData.memory', async () => {
    let queried:
      | Awaited<
          ReturnType<
            NonNullable<McpSessionData['memory']>['repository']['query']
          >
        >
      | undefined
    const harness = makeHarness(async () => ({
      repository: {
        query: async (request) => {
          // The command must hand the repository the session's own project scope.
          expect(request.projectId).toBe(PROJECT_ID)
          queried = fakeQueryOutcome()
          return queried
        },
      },
      projectId: PROJECT_ID,
    }))

    const handle = await runMcpCommand(args, harness.deps)

    const memory = harness.sessionData()?.memory
    expect(memory).toBeDefined()
    expect(memory?.projectId).toBe(PROJECT_ID)
    // The fake lexical surface answers a real-shaped query outcome.
    const outcome = await memory?.repository.query(fakeQueryRequest())
    expect(queried).toBeDefined()
    expect(outcome?.outcome).toBe('result')
    expect(harness.stderrLines.join('\n')).not.toContain(
      'memory_search disabled',
    )
    await handle.close()
  })

  test('a null makeMemory omits sessionData.memory (fail open to disabled payload)', async () => {
    const harness = makeHarness(async () => null)

    const handle = await runMcpCommand(args, harness.deps)

    // The memory key is simply absent: the SDK's memory_search then answers
    // its honest disabled payload, and the command must not throw.
    expect(harness.sessionData()?.memory).toBeUndefined()
    await handle.close()
  })

  test('a throwing makeMemory fails open: no memory key, stderr note, no throw', async () => {
    const harness = makeHarness(async () => {
      throw new Error('sqlite open failed')
    })

    const { close } = await runMcpCommand(args, harness.deps)
    await close()

    expect(harness.sessionData()?.memory).toBeUndefined()
    expect(
      harness.stderrLines.some((line) =>
        line.includes(
          'memory_search disabled (memory provider failed: sqlite open failed)',
        ),
      ),
    ).toBe(true)
  })
})

function makeOwnershipHarness(
  options: {
    startError?: Error
    cleanupError?: Error
    incompleteCleanup?: boolean
  } = {},
) {
  const controller = new AbortController()
  // Identity/cancellation plumbing only; no real authority is dispatched here.
  const context = {} as InjectedExecutionContext
  let setupOptions:
    | Parameters<NonNullable<RunMcpDeps['makeExecution']>>[0]
    | undefined
  let serverOptions:
    | Parameters<NonNullable<RunMcpDeps['runMcpImpl']>>[0]
    | undefined
  let hostCloses = 0
  let serverCloses = 0
  const requestSignals: Array<AbortSignal | undefined> = []
  const stderr: string[] = []
  const deps: RunMcpDeps = {
    projectRoot: '/tmp/mcp-owned-fixture',
    signal: controller.signal,
    makeClient: () => ({}),
    makeIndex: () => undefined,
    makeMemory: async () => null,
    writeStderr: (line) => {
      stderr.push(line)
    },
    makeExecution: async (input) => {
      setupOptions = input
      return {
        ok: true,
        value: {
          executionContext: context,
          hostServices: {
            directOperation: (operation: { signal?: AbortSignal }) => {
              requestSignals.push(operation.signal)
              return { ok: true, value: { executionContext: context } }
            },
          },
          close: async () => {
            hostCloses++
            if (options.cleanupError) throw options.cleanupError
            return options.incompleteCleanup
              ? [{ status: 'unknown' as const }]
              : []
          },
        },
      }
    },
    runMcpImpl: async (input) => {
      serverOptions = input
      if (options.startError) throw options.startError
      return {
        close: async () => {
          serverCloses++
          await input.onClose?.()
        },
      }
    },
  }
  return {
    deps,
    controller,
    context,
    requestSignals,
    stderr,
    setup: () => setupOptions,
    server: () => serverOptions,
    counts: () => ({ hostCloses, serverCloses }),
  }
}

describe('runMcpCommand captured execution ownership', () => {
  test('cancellation during pending server setup joins the owner and the eventual server', async () => {
    const h = makeOwnershipHarness()
    let releaseServer: (
      value: Awaited<ReturnType<NonNullable<RunMcpDeps['runMcpImpl']>>>,
    ) => void = () => {}
    const pendingServer = new Promise<
      Awaited<ReturnType<NonNullable<RunMcpDeps['runMcpImpl']>>>
    >((resolve) => {
      releaseServer = resolve
    })
    let created = false
    let eventualServerCloses = 0
    h.deps.runMcpImpl = () => {
      created = true
      return pendingServer
    }
    const starting = runMcpCommand({}, h.deps)
    const deadline = performance.now() + 1_000
    while (!created) {
      if (performance.now() >= deadline)
        throw new Error('MCP command did not reach server setup')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    h.controller.abort()
    while (!h.counts().hostCloses) {
      if (performance.now() >= deadline)
        throw new Error('MCP cancellation did not join owner cleanup')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    releaseServer({
      close: async () => {
        eventualServerCloses++
      },
    })
    const handle = await starting
    await handle.close()
    expect(h.counts().hostCloses).toBe(1)
    expect(eventualServerCloses).toBe(1)
  })

  test('captures configured root and command signal, forwards trusted context, and joins close exactly once', async () => {
    const h = makeOwnershipHarness()
    const handle = await runMcpCommand({ mutations: true }, h.deps)
    expect(h.setup()).toMatchObject({
      cwd: h.deps.projectRoot,
      projectRoot: h.deps.projectRoot,
    })
    expect(h.setup()?.signal).toBe(h.server()?.signal)
    expect(h.server()?.executionContext).toBe(h.context)
    const requestStop = new AbortController()
    expect(
      h.server()?.executionContextForRequest?.(requestStop.signal),
    ).toEqual({ ok: true, value: h.context })
    expect(h.requestSignals).toEqual([requestStop.signal])
    expect(h.server()?.mutations).toBe(true)
    expect(h.counts()).toEqual({ hostCloses: 0, serverCloses: 0 })
    const first = handle.close()
    expect(handle.close()).toBe(first)
    await first
    expect(h.setup()?.signal?.aborted).toBe(true)
    expect(h.counts()).toEqual({ hostCloses: 1, serverCloses: 1 })
  })

  test('trusted transport EOF callback joins the owner before explicit handle close', async () => {
    const h = makeOwnershipHarness()
    const handle = await runMcpCommand({}, h.deps)
    await h.server()?.onClose?.()
    expect(h.setup()?.signal?.aborted).toBe(true)
    await handle.close()
    expect(h.counts()).toEqual({ hostCloses: 1, serverCloses: 1 })
  })

  test('external cancellation joins owner and server without relying on injected server cancellation', async () => {
    const h = makeOwnershipHarness()
    const handle = await runMcpCommand({}, h.deps)
    h.controller.abort()
    await handle.close()
    expect(h.counts()).toEqual({ hostCloses: 1, serverCloses: 1 })
  })

  test('setup typed refusal prevents server creation and preserves cleanup observations', async () => {
    const h = makeOwnershipHarness()
    const refusal = {
      ok: false,
      reason: 'unavailable',
      cause: 'configured backend unavailable',
      cleanup: [],
    } as const
    h.deps.makeExecution = async () => refusal
    let error: unknown
    try {
      await runMcpCommand({}, h.deps)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ executionRefusal: refusal, cleanup: [] })
    expect(h.server()).toBeUndefined()
    expect(h.counts()).toEqual({ hostCloses: 0, serverCloses: 0 })
  })

  test('start failure joins acquired owner and preserves both errors', async () => {
    const startup = new Error('server start failed')
    const cleanup = new Error('host cleanup failed')
    const h = makeOwnershipHarness({
      startError: startup,
      cleanupError: cleanup,
    })
    let error: unknown
    try {
      await runMcpCommand({}, h.deps)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBe(startup)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).toContain(
      'cleanup',
    )
    expect(h.counts()).toEqual({ hostCloses: 1, serverCloses: 0 })
  })

  test('unconfirmed host cleanup rejects explicit close and retains the rejection', async () => {
    const h = makeOwnershipHarness({ incompleteCleanup: true })
    const handle = await runMcpCommand({}, h.deps)
    await expect(handle.close()).rejects.toThrow('MCP command cleanup failed')
    await expect(handle.close()).rejects.toThrow('MCP command cleanup failed')
    expect(h.counts()).toEqual({ hostCloses: 1, serverCloses: 1 })
  })
})
