import { describe, expect, test } from 'bun:test'

import { runMcpCommand, type McpCommandArgs, type RunMcpDeps } from '../mcp-command'

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
  const deps: RunMcpDeps = {
    runMcpImpl: async (options) => {
      captured.sessionData = options.sessionData
      return { close: async () => {} }
    },
    makeClient: () => ({ fileSystem: { readFile: async () => null } as unknown as McpServerClient['fileSystem'] }),
    makeIndex: () => undefined,
    makeMemory,
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
    let queried: Awaited<ReturnType<NonNullable<McpSessionData['memory']>['repository']['query']>> | undefined
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

    await runMcpCommand(args, harness.deps)

    const memory = harness.sessionData()?.memory
    expect(memory).toBeDefined()
    expect(memory?.projectId).toBe(PROJECT_ID)
    // The fake lexical surface answers a real-shaped query outcome.
    const outcome = await memory?.repository.query(fakeQueryRequest())
    expect(queried).toBeDefined()
    expect(outcome?.outcome).toBe('result')
    expect(harness.stderrLines.join('\n')).not.toContain('memory_search disabled')
  })

  test('a null makeMemory omits sessionData.memory (fail open to disabled payload)', async () => {
    const harness = makeHarness(async () => null)

    await runMcpCommand(args, harness.deps)

    // The memory key is simply absent: the SDK's memory_search then answers
    // its honest disabled payload, and the command must not throw.
    expect(harness.sessionData()?.memory).toBeUndefined()
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
        line.includes('memory_search disabled (memory provider failed: sqlite open failed)'),
      ),
    ).toBe(true)
  })
})