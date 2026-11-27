import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'bun:test'
import Ajv from 'ajv'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'

import { createMcpServer, runMcp } from '../mcp/server'
import {
  createExecutionProcessRecorder,
  createControlledExecutionClock,
  createTerminalExecutionFixture,
} from './fixtures/b19-terminal-execution'
import { deriveExecutionContext } from '../services/execution-launch'
import { createConfiguredDirectHostExecution } from '../services/direct-host-execution'
import {
  ProjectIdSchema,
  QueryIdSchema,
  TaskIdSchema,
} from '@codebuff/common/types/memory-v2'

import type { McpMemoryRepository, McpServer } from '../mcp/server'
import type { QueryIndexResult } from '@codebuff/indexer'
import type {
  MemoryQueryOutcome,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
} from '@codebuff/common/types/memory-v2'

/**
 * MCP roundtrip harness (mirrors the serve-bridge fake-client pattern): a
 * real Client and the real Server connected over
 * `InMemoryTransport.createLinkedPair()`, so tools/list and tools/call ride
 * the actual JSON-RPC wire in-process.
 */
async function connectPair(server: McpServer): Promise<{
  client: Client
  close: () => Promise<void>
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mcp-test-client', version: '0.0.1' })
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()])
    },
  }
}

function makeIndexManagerStub(script?: {
  results?: QueryIndexResult[]
  throwOnQuery?: boolean
}) {
  const state = {
    waitCalls: [] as number[],
    queryCalls: [] as { query: string; options: unknown }[],
  }
  const stub = {
    waitUntilReady: async (timeoutMs?: number) => {
      state.waitCalls.push(timeoutMs ?? -1)
      return true
    },
    queryBlended: async (
      query: string,
      options: Record<string, unknown> = {},
    ) => {
      state.queryCalls.push({ query, options })
      if (script?.throwOnQuery) {
        throw new Error('boom: index query exploded')
      }
      return {
        results: script?.results ?? [],
        ready: true,
        totalIndexed: script?.results?.length ?? 0,
        indexAge: 42,
        status: {
          state: 'ready' as const,
          ready: true,
          stale: false,
          refreshing: false,
          semantic: 'disabled' as const,
          totalIndexed: script?.results?.length ?? 0,
          indexAge: 42,
          diagnostics: [],
          message: 'Index ready.',
        },
      }
    },
  }
  return { stub, state }
}

const emptyRetrievalResult = (): MemoryRetrievalResult => ({
  schemaVersion: 2,
  queryId: QueryIdSchema.parse('query:stub'),
  projectId: ProjectIdSchema.parse('project:stub'),
  generatedAt: '2025-01-01T00:00:00.000Z',
  matchedTasks: [],
  verifiedKnowledge: [],
  reusableDiscovery: [],
  rereadRequired: [],
  historicalContext: [],
  currentCoverage: [],
  degradation: { state: 'none' },
  rankingReasons: [],
})

function makeMemoryRepositoryStub(script?: {
  result?: MemoryRetrievalResult
  outcome?: MemoryQueryOutcome
}) {
  const state = { queryCalls: [] as MemoryRetrievalRequest[] }
  const stub: McpMemoryRepository = {
    query: async (request) => {
      state.queryCalls.push(request)
      if (script?.outcome) return script.outcome
      return {
        outcome: 'result',
        result: script?.result ?? emptyRetrievalResult(),
      }
    },
  }
  return { stub, state }
}

describe('createMcpServer', () => {
  test('trusted request factory binds actual MCP cancellation after search dispatch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-request-cancel-'))
    const recorder = createExecutionProcessRecorder({ autoClose: false })
    const configured = await createConfiguredDirectHostExecution({
      cwd: projectRoot,
      projectRoot,
      spawn: recorder.spawn,
      profile: {
        policy: 'full-access',
        preferredBackend: 'portable-ts',
        required: ['exact-env'],
        allowBackendFallback: false,
      },
      hostConfiguration: {
        environment: { PATH: '/usr/bin:/bin' },
        platform: process.platform,
        invocationCwd: projectRoot,
        projectRoot,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'none' },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
    })
    if (!configured.ok) throw new Error(configured.cause)
    const contexts: Array<
      NonNullable<Parameters<typeof createMcpServer>[0]['executionContext']>
    > = []
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot },
        executionContextForRequest: (signal) => {
          const operation = configured.value.hostServices.directOperation({
            signal,
          })
          if (!operation.ok) return operation
          contexts.push(operation.value.executionContext)
          return { ok: true, value: operation.value.executionContext }
        },
      }),
    )
    const stop = new AbortController()
    const pending = client.callTool(
      { name: 'code_search', arguments: { pattern: 'hello' } },
      undefined,
      { signal: stop.signal },
    )
    const outcome = pending.then(
      () => 'completed',
      () => 'cancelled',
    )
    try {
      const deadline = performance.now() + 1_000
      while (!recorder.calls[0]?.child.stdout?.listenerCount('data')) {
        if (performance.now() >= deadline)
          throw new Error('Factory search did not attach its stdout consumer')
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      stop.abort(new Error('MCP peer cancelled its search request'))
      expect(await outcome).toBe('cancelled')
      while (!contexts[0]?.signal?.aborted) {
        if (performance.now() >= deadline)
          throw new Error(
            'MCP cancellation did not reach trusted operation request',
          )
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(contexts[0].signal?.aborted).toBe(true)
      while (!recorder.calls[0].closed && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(recorder.calls[0].closed).toBe(true)
      expect(recorder.calls[0].signals).toContain('SIGTERM')
    } finally {
      await close()
      await configured.value.close()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('static execution context forwards actual MCP cancellation to search', async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), 'mcp-static-request-cancel-'),
    )
    const recorder = createExecutionProcessRecorder({ autoClose: false })
    const fixture = createTerminalExecutionFixture({
      projectRoot,
      spawn: recorder.spawn,
    })
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot },
        executionContext: fixture.context,
      }),
    )
    const stop = new AbortController()
    const pending = client.callTool(
      { name: 'code_search', arguments: { pattern: 'hello' } },
      undefined,
      { signal: stop.signal },
    )
    const outcome = pending.then(
      () => 'completed',
      () => 'cancelled',
    )
    try {
      const deadline = performance.now() + 1_000
      while (!recorder.calls[0]?.child.stdout?.listenerCount('data')) {
        if (performance.now() >= deadline)
          throw new Error(
            'Static-context search did not attach its stdout consumer',
          )
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      stop.abort(new Error('MCP peer cancelled its static-context search'))
      expect(await outcome).toBe('cancelled')
      while (!recorder.calls[0]?.closed && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(recorder.calls[0]?.closed).toBe(true)
      expect(recorder.calls[0]?.signals).toContain('SIGTERM')
    } finally {
      await close()
      fixture.dispose()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('distinct MCP queries get fresh local budgets while original finite root expiry still refuses', async () => {
    for (const kind of ['static', 'factory'] as const) {
      const clock = createControlledExecutionClock()
      const recorder = createExecutionProcessRecorder({ autoClose: false })
      const fixture = createTerminalExecutionFixture({
        ...clock,
        spawn: recorder.spawn,
        rootLimit: { kind: 'finite', durationMs: 5_000 },
      })
      const requestSignals: Array<AbortSignal | undefined> = []
      const { client, close } = await connectPair(
        createMcpServer({
          client: {},
          sessionData: { projectRoot: fixture.context.projectRoot },
          executionContext: kind === 'static' ? fixture.context : undefined,
          ...(kind === 'factory'
            ? {
                executionContextForRequest: (signal?: AbortSignal) => {
                  requestSignals.push(signal)
                  return deriveExecutionContext(
                    fixture.context,
                    `trusted.fixture.request:${randomUUID()}`,
                    { kind: 'unbounded' },
                  )
                },
              }
            : {}),
        }),
      )
      let dispatched = 0
      async function query(timeoutSeconds: number) {
        const pending = client.callTool({
          name: 'code_search',
          arguments: {
            pattern: 'hello',
            timeoutSeconds,
            executionContextForRequest: 'peer-factory',
            executionContext: 'peer-context',
            branchId: 'peer-branch',
          },
        })
        const finish = setInterval(() => {
          const call = recorder.calls[dispatched]
          if (call?.child.stdout?.listenerCount('data')) {
            dispatched++
            call.finish(1)
          }
        }, 1)
        try {
          return await pending
        } finally {
          clearInterval(finish)
        }
      }
      try {
        expect((await query(1)).isError).toBeUndefined()
        clock.advance(1_001)
        expect((await query(1)).isError).toBeUndefined()
        clock.advance(1_001)
        expect((await query(2)).isError).toBeUndefined()
        expect(recorder.calls).toHaveLength(3)
        expect(
          fixture.policyInputs.every(
            (input) => input.facts.branchId === 'mcp.code-search',
          ),
        ).toBe(true)
        clock.advance(3_000)
        const exhausted = await query(2)
        expect(exhausted.isError).toBe(true)
        expect(exhausted.structuredContent).toMatchObject({
          executionRefusal: { ok: false, reason: 'deadline-exhausted' },
        })
        expect(recorder.calls).toHaveLength(3)
        if (kind === 'factory') {
          expect(requestSignals).toHaveLength(4)
          expect(
            requestSignals.every((signal) => signal instanceof AbortSignal),
          ).toBe(true)
        }
      } finally {
        await close()
        fixture.dispose()
      }
    }
  })

  test('structured MCP results match bounded local projections and preserve read failures', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-structured-'))
    writeFileSync(join(projectRoot, 'hello.ts'), 'export const hi = 1\n')
    const { client, close } = await connectPair(
      createMcpServer({ client: {}, sessionData: { projectRoot } }),
    )
    try {
      const disabled = await client.callTool({
        name: 'query_index',
        arguments: { query: 'hello' },
      })
      const disabledText = disabled.content as { type: string; text: string }[]
      expect(disabled.structuredContent).toEqual(
        JSON.parse(disabledText[0]!.text),
      )
      const read = await client.callTool({
        name: 'read_files',
        arguments: { paths: ['hello.ts', 'missing.ts'] },
      })
      expect(read.isError).toBe(true)
      expect(read.structuredContent).toMatchObject({
        kind: 'read_files_result',
        summary: { failed: 1 },
      })
      expect(JSON.stringify(read.structuredContent)).toContain(
        'export const hi = 1',
      )
      expect(JSON.stringify(read.structuredContent)).toContain('missing.ts')
      expect(JSON.stringify(read)).not.toContain('cap.v3.')
      expect(JSON.stringify(read)).not.toContain('cap.v4.')
      expect(JSON.stringify(read.structuredContent)).toContain(
        '[REDACTED_CAPABILITY]',
      )
      const invalid = await client.callTool({
        name: 'query_index',
        arguments: { query: 42 },
      })
      expect(invalid.isError).toBe(true)
      expect(invalid.structuredContent).toMatchObject({
        kind: 'mcp_tool_error',
        schemaVersion: 1,
      })
    } finally {
      await close()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('oversized structured MCP output reports its omission rather than exceeding the response budget', async () => {
    const { stub } = makeIndexManagerStub({
      results: [
        {
          path: 'large.ts',
          score: 1,
          matchedOn: ['symbol'],
          symbols: ['x'.repeat(300_000)],
        },
      ],
    })
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot: '/nonexistent-project', index: stub },
      }),
    )
    try {
      const result = await client.callTool({
        name: 'query_index',
        arguments: { query: 'large' },
      })
      expect(result.structuredContent).toMatchObject({
        kind: 'query_index_result',
        openbuffOmission: { reason: 'response_budget', limit: 250_000 },
      })
      expect(JSON.stringify(result.structuredContent).length).toBeLessThan(
        250_000,
      )
      expect((result.content as { text: string }[])[0]!.text).toContain(
        'MCP response budget',
      )
    } finally {
      await close()
    }
  })

  test('structured result redaction preserves valid JSON for embedded credential assignments', async () => {
    const { stub } = makeIndexManagerStub({
      results: [
        {
          path: 'redaction.ts',
          score: 1,
          matchedOn: ['symbol'],
          symbols: ['OPENAI_API_KEY=fixture-secret'],
        },
      ],
    })
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot: '/nonexistent-project', index: stub },
      }),
    )
    try {
      const result = await client.callTool({
        name: 'query_index',
        arguments: { query: 'redaction' },
      })
      expect(result.isError).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
      expect(result.structuredContent).toEqual(
        JSON.parse((result.content as { text: string }[])[0]!.text),
      )
      expect(JSON.stringify(result.structuredContent)).toContain(
        '[REDACTED_SECRET]',
      )
    } finally {
      await close()
    }
  })
  test('code_search distinguishes invalid patterns from no matches over MCP', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-search-errors-'))
    writeFileSync(join(projectRoot, 'example.ts'), 'const greeting = 1\n')
    const fixture = createTerminalExecutionFixture({ projectRoot })
    const server = createMcpServer({
      client: {},
      sessionData: { projectRoot },
      executionContext: fixture.context,
    })
    const { client, close } = await connectPair(server)
    try {
      const invalidPattern = await client.callTool({
        name: 'code_search',
        arguments: { pattern: '[' },
      })
      expect(invalidPattern.isError).toBe(true)
      expect(invalidPattern.structuredContent).toMatchObject({
        kind: 'code_search_result',
        schemaVersion: 1,
      })
      expect(JSON.stringify(invalidPattern.content)).not.toContain('No matches')
      const noMatch = await client.callTool({
        name: 'code_search',
        arguments: { pattern: 'not-present-anywhere' },
      })
      expect(noMatch.isError).toBeUndefined()
      expect(JSON.stringify(noMatch.content)).toContain('0 matches')
    } finally {
      await close()
      fixture.dispose()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('code_search without captured authority preserves typed refusal despite peer authority fields', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-no-authority-'))
    const { client, close } = await connectPair(
      createMcpServer({ client: {}, sessionData: { projectRoot } }),
    )
    try {
      const result = await client.callTool({
        name: 'code_search',
        arguments: {
          pattern: 'hello',
          executionContext: { execution: { grant: true } },
          branchId: 'peer-authorized',
        },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        kind: 'code_search_result',
        executionRefusal: { ok: false, reason: 'unavailable' },
      })
      expect(JSON.stringify(result.content)).not.toContain('No matches')
    } finally {
      await close()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('code_search uses trusted MCP branch and captured options, then refuses revoked authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-authority-'))
    const recorder = createExecutionProcessRecorder({ autoClose: false })
    const fixture = createTerminalExecutionFixture({
      projectRoot,
      spawn: recorder.spawn,
    })
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot },
        executionContext: fixture.context,
      }),
    )
    try {
      const pending = client.callTool({
        name: 'code_search',
        arguments: {
          pattern: 'hello',
          branchId: 'peer-branch',
          executionContext: { execution: 'peer' },
        },
      })
      const listenerDeadline = performance.now() + 1_000
      while (!recorder.calls[0]?.child.stdout?.listenerCount('data')) {
        if (performance.now() >= listenerDeadline)
          throw new Error('Owned MCP search did not attach its stdout consumer')
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      recorder.calls[0].finish(1)
      const result = await pending
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({
        processCleanup: { status: 'complete', selectedTier: 'injected' },
      })
      expect(recorder.calls).toHaveLength(1)
      expect(recorder.calls[0]!.options.cwd).toBe(projectRoot)
      expect(recorder.calls[0]!.options.env).toMatchObject({
        PROJECT_VALUE: 'captured-value',
      })
      expect(recorder.calls[0]!.options.env).not.toHaveProperty(
        'OPENAI_API_KEY',
      )
      expect(
        fixture.policyInputs.every(
          (input) => input.facts.branchId === 'mcp.code-search',
        ),
      ).toBe(true)
      expect(fixture.policyInputs.length).toBeGreaterThan(0)
      fixture.dispose()
      const refused = await client.callTool({
        name: 'code_search',
        arguments: { pattern: 'hello' },
      })
      expect(refused.isError).toBe(true)
      expect(refused.structuredContent).toMatchObject({
        executionRefusal: { ok: false, reason: 'cancelled' },
      })
      expect(recorder.calls).toHaveLength(1)
    } finally {
      await close()
      fixture.dispose()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('tools/list returns exactly the read-only tool names', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-tools-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
      })
      const { client, close } = await connectPair(server)
      try {
        const { tools } = await client.listTools()
        expect(tools.map((tool: Tool) => tool.name)).toEqual([
          'query_index',
          'code_search',
          'read_files',
          'file_outline',
          'codebase_structure',
          'memory_search',
        ])
        // memory_search is present and read-only (the lexical Memory V2
        // query surface); no mutation tools are advertised by default
        // (P1-T4: receipt-backed edits stay opt-in behind
        // `openbuff mcp --mutations`).
        expect(
          tools.some((tool: Tool) => /write|edit|mutat/i.test(tool.name)),
        ).toBe(false)
        expect(
          tools.find((tool: Tool) => tool.name === 'memory_search')?.annotations
            ?.readOnlyHint,
        ).toBe(true)
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint).toBe(true)
          expect(tool.inputSchema.type).toBe('object')
        }
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test.each([
    ['minimal query', { query: 'hello' }, true],
    ['missing query', {}, false],
    ['empty query', { query: '' }, false],
    ['non-string query', { query: 42 }, false],
    ['maximum query length', { query: 'a'.repeat(4096) }, true],
    ['excess query length', { query: 'a'.repeat(4097) }, false],
    ['unicode query boundary', { query: '😀'.repeat(4096) }, true],
    ['unicode query excess', { query: '😀'.repeat(4097) }, false],
    ['minimum limit', { query: 'x', limit: 1 }, true],
    ['fractional limit', { query: 'x', limit: 1.9 }, true],
    ['oversized limit', { query: 'x', limit: 101 }, true],
    ['too small limit', { query: 'x', limit: 0.9 }, false],
    ['invalid limit', { query: 'x', limit: '2' }, false],
    ['minimum timeout', { query: 'x', timeoutMs: 0 }, true],
    ['fractional timeout', { query: 'x', timeoutMs: 1.9 }, true],
    ['oversized timeout', { query: 'x', timeoutMs: 30001 }, true],
    ['negative timeout', { query: 'x', timeoutMs: -0.1 }, false],
    ['invalid timeout', { query: 'x', timeoutMs: null }, false],
    ['unknown property', { query: 'x', unexpected: true }, true],
    ['empty arrays', { query: 'x', fileTypes: [], pathPrefixes: [] }, true],
    ['empty file type', { query: 'x', fileTypes: [''] }, false],
    ['long file type', { query: 'x', fileTypes: ['a'.repeat(33)] }, false],
    [
      'unicode file type boundary',
      { query: 'x', fileTypes: ['😀'.repeat(32)] },
      true,
    ],
    [
      'unicode file type excess',
      { query: 'x', fileTypes: ['😀'.repeat(33)] },
      false,
    ],
    [
      'maximum file types',
      { query: 'x', fileTypes: Array(32).fill('ts') },
      true,
    ],
    [
      'too many file types',
      { query: 'x', fileTypes: Array(33).fill('ts') },
      false,
    ],
    ['invalid file types', { query: 'x', fileTypes: ['ts', 2] }, false],
    ['empty path prefix', { query: 'x', pathPrefixes: [''] }, false],
    [
      'long path prefix',
      { query: 'x', pathPrefixes: ['x'.repeat(1025)] },
      false,
    ],
    [
      'unicode path prefix boundary',
      { query: 'x', pathPrefixes: ['😀'.repeat(1024)] },
      true,
    ],
    [
      'unicode path prefix excess',
      { query: 'x', pathPrefixes: ['😀'.repeat(1025)] },
      false,
    ],
    [
      'too many path prefixes',
      { query: 'x', pathPrefixes: Array(33).fill('src') },
      false,
    ],
    ['empty from', { query: 'x', from: '' }, false],
    ['empty to', { query: 'x', to: '' }, false],
    [
      'unicode traversal boundary',
      { query: 'x', from: '😀'.repeat(1024), to: '😀'.repeat(1024) },
      true,
    ],
    [
      'unicode traversal excess',
      { query: 'x', from: '😀'.repeat(1025) },
      false,
    ],
    ['long traversal node', { query: 'x', to: 'a'.repeat(1025) }, false],
    [
      'all graph options',
      { query: 'x', mode: 'references', from: 'a', to: 'b' },
      true,
    ],
    ['invalid mode', { query: 'x', mode: 'bogus' }, false],
  ] as Array<[string, Record<string, unknown>, boolean]>)(
    'query_index schema matches dispatch: %s',
    async (_label, args, accepted) => {
      const { stub, state } = makeIndexManagerStub()
      const { client, close } = await connectPair(
        createMcpServer({
          client: {},
          sessionData: { projectRoot: '/nonexistent-project', index: stub },
        }),
      )
      try {
        const { tools } = await client.listTools()
        const schema = tools.find(
          (tool: Tool) => tool.name === 'query_index',
        )!.inputSchema
        const validate = new Ajv().compile(schema)
        const result = await client.callTool({
          name: 'query_index',
          arguments: args,
        })
        expect(result.isError === true).toBe(!accepted)
        expect(state.queryCalls).toHaveLength(accepted ? 1 : 0)
        expect(state.waitCalls).toHaveLength(accepted ? 1 : 0)
        expect(validate(args)).toBe(accepted)
      } finally {
        await close()
      }
    },
  )

  test('query_index floors and caps options while discarding peer authority fields', async () => {
    const { stub, state } = makeIndexManagerStub()
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot: '/nonexistent-project', index: stub },
      }),
    )
    try {
      const { tools } = await client.listTools()
      const schema = tools.find(
        (tool: Tool) => tool.name === 'query_index',
      )!.inputSchema
      const args = {
        query: 'alpha',
        limit: 101.9,
        timeoutMs: 30001.9,
        fileTypes: ['ts'],
        pathPrefixes: ['src'],
        mode: 'neighbors',
        from: 'start',
        to: 'end',
        executionContext: { execution: { grant: true } },
        executionContextForRequest: 'peer-factory',
        branchId: 'peer-branch',
      }
      expect(new Ajv().compile(schema)(args)).toBe(true)
      const result = await client.callTool({
        name: 'query_index',
        arguments: args,
      })
      expect(result.isError).toBeUndefined()
      expect(state.waitCalls).toEqual([30000])
      expect(state.queryCalls).toEqual([
        {
          query: 'alpha',
          options: {
            limit: 100,
            fileTypes: ['ts'],
            pathPrefixes: ['src'],
            mode: 'neighbors',
            from: 'start',
            to: 'end',
          },
        },
      ])
      const fractional = await client.callTool({
        name: 'query_index',
        arguments: { query: 'beta', limit: 2.9, timeoutMs: 0.9 },
      })
      expect(fractional.isError).toBeUndefined()
      expect(state.waitCalls).toEqual([30000, 0])
      expect(state.queryCalls[1]).toEqual({
        query: 'beta',
        options: { limit: 2 },
      })
      const defaults = await client.callTool({
        name: 'query_index',
        arguments: { query: 'gamma' },
      })
      expect(defaults.isError).toBeUndefined()
      expect(state.waitCalls).toEqual([30000, 0, 2000])
      expect(state.queryCalls[2]).toEqual({ query: 'gamma', options: {} })
    } finally {
      await close()
    }
  })

  test('query_index validates input before reporting a disabled index', async () => {
    const { client, close } = await connectPair(
      createMcpServer({
        client: {},
        sessionData: { projectRoot: '/nonexistent-project' },
      }),
    )
    try {
      const invalid = await client.callTool({
        name: 'query_index',
        arguments: { query: '' },
      })
      expect(invalid.isError).toBe(true)
      const result = await client.callTool({
        name: 'query_index',
        arguments: { query: 'valid', limit: 2.5 },
      })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({
        kind: 'query_index_result',
        ready: false,
      })
    } finally {
      await close()
    }
  })

  test('tools/call query_index delegates to IndexManager.queryBlended and returns content', async () => {
    const { stub, state } = makeIndexManagerStub({
      results: [
        {
          path: 'src/a.ts',
          score: 3.5,
          matchedOn: ['symbol'],
          symbols: ['alpha'],
        },
      ],
    })
    const server = createMcpServer({
      client: {},
      sessionData: { projectRoot: '/nonexistent-project', index: stub },
    })
    const { client, close } = await connectPair(server)
    try {
      const result = await client.callTool({
        name: 'query_index',
        arguments: { query: 'alpha', limit: 5, fileTypes: ['ts'] },
      })
      expect(result.isError).toBeUndefined()
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.type).toBe('text')
      const payload = JSON.parse(content[0]!.text) as {
        kind: string
        results: { path: string; matchedOn: string[] }[]
        totalIndexed: number
      }
      expect(payload.kind).toBe('query_index_result')
      expect(payload.totalIndexed).toBe(1)
      expect(payload.results[0]?.path).toBe('src/a.ts')
      // The call shape the indexer saw (bounded options pass through).
      expect(state.waitCalls).toEqual([2_000])
      expect(state.queryCalls).toEqual([
        { query: 'alpha', options: { limit: 5, fileTypes: ['ts'] } },
      ])
    } finally {
      await close()
    }
  })

  test('tools/call memory_search delegates to the Memory V2 lexical query surface', async () => {
    const { stub, state } = makeMemoryRepositoryStub({
      result: {
        ...emptyRetrievalResult(),
        matchedTasks: [
          {
            taskId: TaskIdSchema.parse('task:stub'),
            title: 'Fix auth flow',
            status: 'completed',
            summary: 'Rotated tokens to fix the auth flow.',
            score: 0.8,
            reasons: [
              {
                code: 'lexical-match',
                contribution: 0.8,
                detail: 'token overlap on auth flow',
              },
            ],
          },
        ],
      },
    })
    const server = createMcpServer({
      client: {},
      sessionData: {
        projectRoot: '/nonexistent-project',
        memory: {
          repository: stub,
          projectId: ProjectIdSchema.parse('project:stub'),
        },
      },
    })
    const { client, close } = await connectPair(server)
    try {
      const result = await client.callTool({
        name: 'memory_search',
        arguments: {
          query: 'auth flow',
          limit: 5,
          paths: ['src/auth.ts'],
          kinds: ['source'],
        },
      })
      expect(result.isError).toBeUndefined()
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.type).toBe('text')
      const payload = JSON.parse(content[0]!.text) as {
        kind: string
        retrieval: string
        ready: boolean
        totalResults: number
        results: { category: string; taskId?: string; title?: string }[]
        message: string
      }
      expect(payload.kind).toBe('memory_search_result')
      // Honest lexical-only marker: never a semantic-recall claim (P8-T8).
      expect(payload.retrieval).toBe('lexical')
      expect(payload.message).toContain('semantic')
      expect(payload.ready).toBe(true)
      expect(payload.totalResults).toBe(1)
      expect(payload.results[0]?.category).toBe('matched-task')
      expect(payload.results[0]?.taskId).toBe('task:stub')
      expect(payload.results[0]?.title).toBe('Fix auth flow')
      // The request shape the repository saw (bounded, schema-valid input).
      expect(state.queryCalls).toHaveLength(1)
      const request = state.queryCalls[0]!
      expect(request.schemaVersion).toBe(2)
      expect(request.query).toBe('auth flow')
      expect(request.projectId).toBe(ProjectIdSchema.parse('project:stub'))
      expect(request.maxResultsPerCategory).toBe(5)
      expect(request.selectors).toEqual([{ kind: 'file', path: 'src/auth.ts' }])
      expect(request.artifactKinds).toEqual(['source'])
      expect(request.includeHistorical).toBe(true)
      expect(request.sessionId).toMatch(/^session:/)
      expect(request.queryId).toMatch(/^query:/)

      // Invalid input fails closed at validation, never reaching the repository.
      const badInput = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'auth', kinds: ['bogus'] },
      })
      expect(badInput.isError).toBe(true)
      const badContent = badInput.content as { type: string; text: string }[]
      expect(badContent[0]!.text).toContain('Invalid input')
      expect(state.queryCalls).toHaveLength(1)
    } finally {
      await close()
    }
  })

  test('tools/call memory_search without a repository returns an honest disabled payload', async () => {
    const server = createMcpServer({
      client: {},
      sessionData: { projectRoot: '/nonexistent-project' },
    })
    const { client, close } = await connectPair(server)
    try {
      const result = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'anything' },
      })
      expect(result.isError).toBeUndefined()
      const content = result.content as { type: string; text: string }[]
      const payload = JSON.parse(content[0]!.text) as {
        kind: string
        retrieval: string
        ready: boolean
        totalResults: number
        results: unknown[]
        message: string
      }
      expect(payload.kind).toBe('memory_search_result')
      expect(payload.retrieval).toBe('lexical')
      expect(payload.ready).toBe(false)
      expect(payload.totalResults).toBe(0)
      expect(payload.results).toEqual([])
      expect(payload.message).toContain('No Memory V2 repository')
    } finally {
      await close()
    }
  })

  test('tools/call read_files is cap-guarded and returns file content', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-read-'))
    try {
      writeFileSync(join(projectRoot, 'hello.ts'), 'export const hi = 1\n')
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
      })
      const { client, close } = await connectPair(server)
      try {
        const result = await client.callTool({
          name: 'read_files',
          arguments: { paths: ['hello.ts'] },
        })
        expect(result.isError).toBeUndefined()
        const content = result.content as { type: string; text: string }[]
        expect(content[0]?.type).toBe('text')
        expect(content[0]!.text).toContain('export const hi = 1')
        // Complete cap-guarded reads mint a cap.v4 read capability, but the
        // token itself is REDACTED over MCP (SEC-1): the output reports the
        // minted capability without ever carrying the live token.
        expect(content[0]!.text).toContain('[READ_CAPABILITY')
        expect(content[0]!.text).toContain('[REDACTED_CAPABILITY]')
        expect(content[0]!.text).not.toContain('cap.v3.')
        expect(content[0]!.text).not.toContain('cap.v4.')

        // Outside-project escapes fail closed (error content, never a crash).
        const escape = await client.callTool({
          name: 'read_files',
          arguments: { paths: ['../../etc/passwd'] },
        })
        const escapeContent = escape.content as { type: string; text: string }[]
        expect(escapeContent[0]!.text).toContain('outside_project')

        // A missing file surfaces its error status without failing the call.
        const missing = await client.callTool({
          name: 'read_files',
          arguments: { paths: ['nope.ts'] },
        })
        const missingContent = missing.content as {
          type: string
          text: string
        }[]
        expect(missingContent[0]!.text).toContain('not_found')
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('an unknown tool name returns a structured MCP error, not a crash', async () => {
    const server = createMcpServer({
      client: {},
      sessionData: { projectRoot: '/nonexistent-project' },
    })
    const { client, close } = await connectPair(server)
    try {
      let caught: unknown
      try {
        await client.callTool({ name: 'delete_everything', arguments: {} })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(McpError)
      expect((caught as McpError).message).toContain('Unknown tool')
      // The server survived the unknown call: the wire is still alive.
      const { tools } = await client.listTools()
      expect(tools.length).toBe(6)
    } finally {
      await close()
    }
  })

  test('a throwing tool handler returns isError content instead of crashing', async () => {
    const { stub } = makeIndexManagerStub({ throwOnQuery: true })
    const server = createMcpServer({
      client: {},
      sessionData: { projectRoot: '/nonexistent-project', index: stub },
    })
    const { client, close } = await connectPair(server)
    try {
      const result = await client.callTool({
        name: 'query_index',
        arguments: { query: 'alpha' },
      })
      expect(result.isError).toBe(true)
      const content = result.content as { type: string; text: string }[]
      expect(content[0]!.text).toContain('boom: index query exploded')

      // Invalid input fails closed at validation, never reaching the indexer.
      const badInput = await client.callTool({
        name: 'query_index',
        arguments: { query: 42 },
      })
      expect(badInput.isError).toBe(true)
      const badContent = badInput.content as { type: string; text: string }[]
      expect(badContent[0]!.text).toContain('Invalid input')
    } finally {
      await close()
    }
  })

  test('runMcp returns an idempotent close handle (non-stdio factory seam)', async () => {
    // runMcp's stdio transport is exercised by the CLI gate; here we only
    // pin that createMcpServer hands the SAME configured server instance a
    // host can connect to its own transport (the seam runMcp composes).
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-runmcp-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
        serverName: 'openbuff-test',
      })
      const { client, close } = await connectPair(server)
      try {
        expect(client.getServerVersion()?.name).toBe('openbuff-test')
        expect(client.getServerCapabilities()?.tools).toBeDefined()
      } finally {
        await close()
      }
      expect(typeof runMcp).toBe('function')
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('apply_edits is not listed and fails closed when mutations are off', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-mutations-off-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
      })
      const { client, close } = await connectPair(server)
      try {
        const { tools } = await client.listTools()
        expect(tools.some((tool: Tool) => tool.name === 'apply_edits')).toBe(
          false,
        )
        let caught: unknown
        try {
          await client.callTool({
            name: 'apply_edits',
            arguments: {
              edits: [{ path: 'x.ts', content: 'export const x = 1\n' }],
            },
          })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(McpError)
        expect((caught as McpError).message).toContain('Unknown tool')
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('apply_edits is listed and writes files when mutations are on', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-mutations-on-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
        mutations: true,
      })
      const { client, close } = await connectPair(server)
      try {
        const { tools } = await client.listTools()
        const applyEdits = tools.find(
          (tool: Tool) => tool.name === 'apply_edits',
        )
        expect(applyEdits).toBeDefined()
        expect(applyEdits?.annotations?.readOnlyHint).toBe(false)
        expect(applyEdits?.annotations?.destructiveHint).toBe(true)

        const result = await client.callTool({
          name: 'apply_edits',
          arguments: {
            edits: [{ path: 'note.txt', content: 'hello from apply_edits\n' }],
          },
        })
        expect(result.isError).toBeUndefined()
        const content = result.content as { type: string; text: string }[]
        expect(content[0]?.type).toBe('text')
        const results = JSON.parse(content[0]!.text) as {
          path: string
          applied: boolean
        }[]
        expect(results).toEqual([{ path: 'note.txt', applied: true }])
        // The real WorkspaceMutationBroker committed the write to the project.
        expect(readFileSync(join(projectRoot, 'note.txt'), 'utf8')).toBe(
          'hello from apply_edits\n',
        )
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('apply_edits overwrite gate: an existing file REQUIRES the current content hash', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-gate-'))
    try {
      writeFileSync(join(projectRoot, 'tracked.ts'), 'export const a = 1\n')
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
        mutations: true,
      })
      const { client, close } = await connectPair(server)
      try {
        // (a) Overwrite WITHOUT expectedHash → structured invalid-params
        // rejection, nothing written.
        let caught: unknown
        try {
          await client.callTool({
            name: 'apply_edits',
            arguments: {
              edits: [{ path: 'tracked.ts', content: 'export const a = 2\n' }],
            },
          })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(McpError)
        expect((caught as McpError).message).toContain(
          'expectedHash is required',
        )
        expect(readFileSync(join(projectRoot, 'tracked.ts'), 'utf8')).toBe(
          'export const a = 1\n',
        )

        // (b) WRONG hash → rejected, file untouched.
        const staleHash = createHash('sha256')
          .update('stale content the client imagined')
          .digest('hex')
        caught = undefined
        try {
          await client.callTool({
            name: 'apply_edits',
            arguments: {
              edits: [
                {
                  path: 'tracked.ts',
                  content: 'export const a = 2\n',
                  expectedHash: staleHash,
                },
              ],
            },
          })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(McpError)
        expect((caught as McpError).message).toContain(
          'does not match the current content',
        )
        expect(readFileSync(join(projectRoot, 'tracked.ts'), 'utf8')).toBe(
          'export const a = 1\n',
        )

        // (c) CORRECT hash → the overwrite succeeds.
        const correctHash = createHash('sha256')
          .update('export const a = 1\n')
          .digest('hex')
        const result = await client.callTool({
          name: 'apply_edits',
          arguments: {
            edits: [
              {
                path: 'tracked.ts',
                content: 'export const a = 2\n',
                expectedHash: correctHash,
              },
            ],
          },
        })
        expect(result.isError).toBeUndefined()
        expect(readFileSync(join(projectRoot, 'tracked.ts'), 'utf8')).toBe(
          'export const a = 2\n',
        )
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('apply_edits create path: a null/absent hash creates the file; a non-null hash on a create is rejected', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-create-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
        mutations: true,
      })
      const { client, close } = await connectPair(server)
      try {
        // A null expectedHash is a create.
        const created = await client.callTool({
          name: 'apply_edits',
          arguments: {
            edits: [
              {
                path: 'fresh.ts',
                content: 'export const fresh = true\n',
                expectedHash: null,
              },
            ],
          },
        })
        expect(created.isError).toBeUndefined()
        expect(readFileSync(join(projectRoot, 'fresh.ts'), 'utf8')).toBe(
          'export const fresh = true\n',
        )

        // A non-null hash on a file that does not exist claims knowledge of
        // content that cannot exist → structured rejection, nothing created.
        let caught: unknown
        try {
          await client.callTool({
            name: 'apply_edits',
            arguments: {
              edits: [
                {
                  path: 'never-existed.ts',
                  content: 'export const nope = 1\n',
                  expectedHash: createHash('sha256')
                    .update('ghost')
                    .digest('hex'),
                },
              ],
            },
          })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(McpError)
        expect((caught as McpError).message).toContain('must be null')
        expect(existsSync(join(projectRoot, 'never-existed.ts'))).toBe(false)
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('apply_edits refuses sensitive paths with a structured error naming the refusal', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-sensitive-'))
    try {
      const server = createMcpServer({
        client: {},
        sessionData: { projectRoot },
        mutations: true,
      })
      const { client, close } = await connectPair(server)
      try {
        for (const target of ['.env', 'id_rsa', '.npmrc']) {
          let caught: unknown
          try {
            await client.callTool({
              name: 'apply_edits',
              arguments: {
                edits: [{ path: target, content: 'SECRET=leak\n' }],
              },
            })
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(McpError)
          expect((caught as McpError).message).toContain('sensitive path')
          expect((caught as McpError).message).toContain(target)
          expect(existsSync(join(projectRoot, target))).toBe(false)
        }
      } finally {
        await close()
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('createMcpServer returns the structural McpServer handle (connect/close public surface)', () => {
    // Pins the deliberate type-level narrowing: the public SDK handle is the
    // structural `McpServer` (connect/close only), NOT the concrete MCP SDK
    // `Server`. See the migration note on the `McpServer` interface.
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-server-surface-'))
    try {
      const server: McpServer = createMcpServer({
        client: {},
        sessionData: { projectRoot },
      })
      expect(typeof server.connect).toBe('function')
      expect(typeof server.close).toBe('function')
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

function lifecycleHarness(
  options: { connectError?: Error; cleanupError?: Error } = {},
) {
  const input = new EventEmitter()
  let serverCloses = 0
  let ownerCloses = 0
  let finishCleanup: () => void = () => {}
  const cleanupBarrier = new Promise<void>((resolve) => {
    finishCleanup = resolve
  })
  const server = {
    onclose: undefined as (() => void) | undefined,
    connect: async () => {
      if (options.connectError) throw options.connectError
    },
    close: async () => {
      serverCloses++
      server.onclose?.()
    },
  }
  const controller = new AbortController()
  const start = () =>
    runMcp(
      {
        client: {},
        sessionData: { projectRoot: '/fixture' },
        signal: controller.signal,
        onClose: async () => {
          ownerCloses++
          await cleanupBarrier
          if (options.cleanupError) throw options.cleanupError
        },
      },
      { createServer: () => server, createTransport: () => ({}), input },
    )
  return {
    input,
    server,
    controller,
    start,
    finishCleanup,
    counts: () => ({ serverCloses, ownerCloses }),
  }
}

describe('runMcp owned transport lifetime', () => {
  test('real MCP transport peer closure joins the trusted owner callback', async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const input = new EventEmitter()
    const client = new Client({ name: 'owned-lifetime-peer', version: '1' })
    let ownerCloses = 0
    const [handle] = await Promise.all([
      runMcp(
        {
          client: {},
          sessionData: { projectRoot: '/fixture' },
          onClose: async () => {
            ownerCloses++
          },
        },
        { createTransport: () => serverTransport, input },
      ),
      client.connect(clientTransport),
    ])
    await client.close()
    await handle.close()
    expect(ownerCloses).toBe(1)
    expect(input.listenerCount('end')).toBe(0)
  })

  test('cancellation starts owner cleanup during pending connect and closes the eventual transport', async () => {
    const h = lifecycleHarness()
    let finishConnect: () => void = () => {}
    const connecting = new Promise<void>((resolve) => {
      finishConnect = resolve
    })
    h.server.connect = () => connecting
    const starting = h.start()
    await Promise.resolve()
    h.controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.counts().ownerCloses).toBe(1)
    h.finishCleanup()
    finishConnect()
    const handle = await starting
    await handle.close()
    expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
  })

  for (const ending of [
    'end',
    'close',
    'server-close',
    'abort',
    'manual',
  ] as const) {
    test(`joins owner cleanup once on ${ending} and removes lifetime listeners`, async () => {
      const h = lifecycleHarness()
      const handle = await h.start()
      expect(h.counts()).toEqual({ serverCloses: 0, ownerCloses: 0 })
      if (ending === 'server-close') h.server.onclose?.()
      else if (ending === 'abort') h.controller.abort()
      else if (ending !== 'manual') h.input.emit(ending)
      const first = handle.close()
      expect(handle.close()).toBe(first)
      let finished = false
      void first.then(() => {
        finished = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(finished).toBe(false)
      h.finishCleanup()
      await first
      expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
      expect(h.input.listenerCount('end')).toBe(0)
      expect(h.input.listenerCount('close')).toBe(0)
      h.controller.abort()
      h.input.emit('end')
      expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
    })
  }

  test('failed connect still joins server and owner, retaining startup and cleanup errors', async () => {
    const startup = new Error('connect fixture failed')
    const cleanup = new Error('cleanup fixture failed')
    const h = lifecycleHarness({ connectError: startup, cleanupError: cleanup })
    h.finishCleanup()
    let error: unknown
    try {
      await h.start()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBe(startup)
    expect((error as AggregateError).errors[1]).toBeInstanceOf(AggregateError)
    expect(
      ((error as AggregateError).errors[1] as AggregateError).errors,
    ).toContain(cleanup)
    expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
    expect(h.input.listenerCount('end')).toBe(0)
  })

  test('automatic EOF retains cleanup rejection for explicit close', async () => {
    const cleanup = new Error('unknown process cleanup')
    const h = lifecycleHarness({ cleanupError: cleanup })
    const handle = await h.start()
    h.finishCleanup()
    h.input.emit('end')
    let error: unknown
    try {
      await handle.close()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toContain(cleanup)
    await expect(handle.close()).rejects.toBe(error)
    expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
  })

  test('pre-aborted lifetime does not connect but joins cleanup', async () => {
    const h = lifecycleHarness()
    h.controller.abort()
    h.finishCleanup()
    const handle = await h.start()
    await handle.close()
    expect(h.counts()).toEqual({ serverCloses: 1, ownerCloses: 1 })
  })
})
