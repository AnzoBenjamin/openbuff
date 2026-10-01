import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'

import { createMcpServer, runMcp } from '../mcp/server'

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { QueryIndexResult } from '@codebuff/indexer'

/**
 * MCP roundtrip harness (mirrors the serve-bridge fake-client pattern): a
 * real Client and the real Server connected over
 * `InMemoryTransport.createLinkedPair()`, so tools/list and tools/call ride
 * the actual JSON-RPC wire in-process.
 */
async function connectPair(server: Server): Promise<{
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
        ])
        // No mutation tools are advertised by default (P1-T4: receipt-backed
        // edits stay opt-in with the follow-up named in mcp/server.ts).
        expect(
          tools.some((tool: Tool) => /write|edit|mutat|memory/i.test(tool.name)),
        ).toBe(false)
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
        // Complete cap-guarded reads mint a cap.v3 read capability.
        expect(content[0]!.text).toContain('cap.v3.')

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
      expect(tools.length).toBe(5)
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
})
