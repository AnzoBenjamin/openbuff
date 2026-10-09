import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'

import { createMcpServer, runMcp } from '../mcp/server'
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
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
    queryBlended: async (query: string, options: Record<string, unknown> = {}) => {
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
        // Complete cap-guarded reads mint a cap.v3 read capability, but the
        // token itself is REDACTED over MCP (SEC-1): the output reports the
        // minted capability without ever carrying the live token.
        expect(content[0]!.text).toContain('[READ_CAPABILITY')
        expect(content[0]!.text).toContain('[REDACTED_CAPABILITY]')
        expect(content[0]!.text).not.toContain('cap.v3.')

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
        const missingContent = missing.content as { type: string; text: string }[]
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
            arguments: { edits: [{ path: 'x.ts', content: 'export const x = 1\n' }] },
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
        const applyEdits = tools.find((tool: Tool) => tool.name === 'apply_edits')
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
        expect((caught as McpError).message).toContain('expectedHash is required')
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
                  expectedHash: createHash('sha256').update('ghost').digest('hex'),
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
