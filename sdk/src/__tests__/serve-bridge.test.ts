import { describe, expect, test } from 'bun:test'

import { originOf } from '@codebuff/common/mcp/client'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { McpServer } from '@agentclientprotocol/sdk'

import { createServeBridge } from '../serve/bridge'
import type { ServeBridgeClient } from '../serve/bridge'
import type {
  FilesystemMutationEvent,
  OpenbuffClientOptions,
  RunOptions,
} from '../run'
import type { RunState } from '../run-state'
import { AcpSessionData } from '../services/acp/session-data'

const DONE_STATE: RunState = {
  output: { type: 'error', message: 'done' },
}

/**
 * A fake client whose `.run` invokes the passed handleEvent/onFilesystemMutation
 * in order, then resolves a RunState-ish object. No run-loop process spawning.
 */
function makeFakeClient(script: {
  events?: PrintModeEvent[]
  mutations?: FilesystemMutationEvent[]
  beforeResolve?: (runOptions: RunOptions & OpenbuffClientOptions) => void
}): ServeBridgeClient {
  return {
    async run(runOptions) {
      for (const event of script.events ?? []) {
        await runOptions.handleEvent?.(event)
      }
      for (const mutation of script.mutations ?? []) {
        await runOptions.onFilesystemMutation?.(mutation)
      }
      script.beforeResolve?.(runOptions)
      return DONE_STATE
    },
  }
}

function collectUpdates() {
  const updates: string[] = []
  return {
    updates,
    update: async (chunkText: string) => {
      updates.push(chunkText)
    },
  }
}

describe('createServeBridge', () => {
  test('forwards a plain assistant text chunk (sanitized) to update', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({
      events: [{ type: 'text', text: 'hello world' }],
    })
    const { promptHandler } = createServeBridge({ client, sessionData })
    const { updates, update } = collectUpdates()

    const result = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    expect(updates).toEqual(['hello world'])
    expect(result.stopReason).toBe('end_turn')
  })

  test('a chunk containing a cap.v3 token reaches update already redacted', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({
      events: [{ type: 'text', text: 'token cap.v3.1.2.ABCdef here' }],
    })
    const { promptHandler } = createServeBridge({ client, sessionData })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]).not.toContain('cap.v3.')
    expect(updates[0]).toContain('[REDACTED_CAPABILITY]')
  })

  test('tool_call and tool_result events are NOT forwarded (structural drop)', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({
      events: [
        { type: 'tool_call', toolCallId: 't1', toolName: 'read_files', input: {} },
        {
          type: 'tool_result',
          toolCallId: 't1',
          toolName: 'read_files',
          output: [],
        },
        { type: 'text', text: 'visible' },
      ],
    })
    const { promptHandler } = createServeBridge({ client, sessionData })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    expect(updates).toEqual(['visible'])
  })

  test('an onFilesystemMutation event is recorded as a projected receipt row', async () => {
    const sessionData = new AcpSessionData()
    const mutation: FilesystemMutationEvent = {
      toolName: 'edit_transaction',
      callId: 'c1',
      operationId: 'op-9',
      workspaceRevision: 5,
      workspaceSnapshotId: 'snap-1',
      actions: [
        { action: 'create', path: 'src/a.ts', beforeHash: null, afterHash: 'h1' },
        {
          action: 'move',
          path: 'src/b.ts',
          destinationPath: 'src/c.ts',
          beforeHash: 'h0',
          afterHash: 'h2',
        },
      ],
    }
    const client = makeFakeClient({ mutations: [mutation] })
    const { promptHandler } = createServeBridge({ client, sessionData })
    const { update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    const { receipts } = sessionData.getReceipts('s1')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].operationId).toBe('op-9')
    expect(receipts[0].paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(receipts[0].actionIds).toEqual(['op-9:0', 'op-9:1'])
  })

  test('a forwarded chunk containing a <gate-state> block updates the store gate phase', async () => {
    const sessionData = new AcpSessionData()
    const block = `<gate-state>${JSON.stringify({
      gate: 'validation',
      status: 'running',
      details: '',
    })}</gate-state>`
    const client = makeFakeClient({
      events: [{ type: 'text', text: `progress ${block}` }],
    })
    const { promptHandler } = createServeBridge({ client, sessionData })
    const { update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    expect(sessionData.getGateState('s1').phase).toBe('validating')
  })

  test('returns end_turn normally and cancelled when the signal aborts before run resolves', async () => {
    const sessionData = new AcpSessionData()

    const normalClient = makeFakeClient({})
    const { promptHandler: normalHandler } = createServeBridge({
      client: normalClient,
      sessionData,
    })
    const normal = await normalHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(normal.stopReason).toBe('end_turn')

    const controller = new AbortController()
    const abortingClient = makeFakeClient({
      beforeResolve: (runOptions) => {
        // Abort the run's own signal mid-run, before run() resolves.
        expect(runOptions.signal).toBe(controller.signal)
        controller.abort()
      },
    })
    const { promptHandler: abortingHandler } = createServeBridge({
      client: abortingClient,
      sessionData,
    })
    const cancelled = await abortingHandler({
      sessionId: 's2',
      promptText: 'hi',
      update: async () => {},
      signal: controller.signal,
    })
    expect(cancelled.stopReason).toBe('cancelled')
  })

  test('runs the client with a custom agentId when provided', async () => {
    const sessionData = new AcpSessionData()
    let captured: (RunOptions & OpenbuffClientOptions) | undefined
    const client = makeFakeClient({
      beforeResolve: (runOptions) => {
        captured = runOptions
      },
    })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      agentId: 'my-agent',
    })

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })

    expect(captured?.agent).toBe('my-agent')
  })

  test('defaults the client agentId to base when unset', async () => {
    const sessionData = new AcpSessionData()
    let captured: (RunOptions & OpenbuffClientOptions) | undefined
    const client = makeFakeClient({
      beforeResolve: (runOptions) => {
        captured = runOptions
      },
    })
    const { promptHandler } = createServeBridge({ client, sessionData })

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })

    expect(captured?.agent).toBe('base')
  })

  test('marks client-advertised MCP servers client-origin at ingest and skips acp', async () => {
    const sessionData = new AcpSessionData()
    let marked: Record<string, MCPConfig> | undefined
    const client = makeFakeClient({})
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      markClientMcpServers: (record) => {
        marked = record
      },
    })
    const mcpServers: McpServer[] = [
      {
        name: 'local',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'TOKEN', value: '$SECRET' }],
      },
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer abc' }],
      },
      { type: 'acp', name: 'acp-srv', serverId: 'acp-1' },
    ]

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      mcpServers,
    })

    expect(marked).toBeDefined()
    // The acp-type server has no core transport equivalent and is skipped.
    expect(Object.keys(marked!).sort()).toEqual(['local', 'remote'])
    expect(marked!['acp-srv']).toBeUndefined()

    expect(marked!.local).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      // ACP env is used literally at 'client' origin (no $VAR expansion).
      env: { TOKEN: '$SECRET' },
    })
    expect(marked!.remote).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      params: {},
      headers: { Authorization: 'Bearer abc' },
    })

    for (const config of Object.values(marked!)) {
      expect(originOf(config)).toBe('client')
    }
  })

  test('does not call markClientMcpServers for empty or absent mcpServers', async () => {
    const sessionData = new AcpSessionData()
    let called = false
    const client = makeFakeClient({})
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      markClientMcpServers: () => {
        called = true
      },
    })

    const empty = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      mcpServers: [],
    })
    expect(called).toBe(false)
    expect(empty.stopReason).toBe('end_turn')

    const absent = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(called).toBe(false)
    expect(absent.stopReason).toBe('end_turn')
  })

  test('never marks when markClientMcpServers is absent but the run still proceeds', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({})
    const { promptHandler } = createServeBridge({ client, sessionData })

    const result = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      mcpServers: [{ name: 'local', command: 'node', args: [], env: [] }],
    })

    expect(result.stopReason).toBe('end_turn')
  })

  test('attaches marked client MCP servers to client.run at client origin (same identity)', async () => {
    const sessionData = new AcpSessionData()
    let marked: Record<string, MCPConfig> | undefined
    let captured: (RunOptions & OpenbuffClientOptions) | undefined
    const client = makeFakeClient({
      beforeResolve: (runOptions) => {
        captured = runOptions
      },
    })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      markClientMcpServers: (record) => {
        marked = record
      },
    })
    const mcpServers: McpServer[] = [
      {
        name: 'local',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'TOKEN', value: '$SECRET' }],
      },
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer abc' }],
      },
      { type: 'acp', name: 'acp-srv', serverId: 'acp-1' },
    ]

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      mcpServers,
    })

    expect(captured?.mcpServers).toBeDefined()
    // The acp-type server has no core transport equivalent and is skipped.
    expect(Object.keys(captured!.mcpServers!).sort()).toEqual([
      'local',
      'remote',
    ])
    for (const config of Object.values(captured!.mcpServers!)) {
      expect(originOf(config)).toBe('client')
    }
    // The exact same marked object reaches both the run seam and the host hook,
    // proving the identity-keyed WeakMap origin marks survive the attach.
    expect(captured!.mcpServers).toBe(marked)
  })

  test('passes no mcpServers to client.run when none are advertised, and still runs', async () => {
    const sessionData = new AcpSessionData()
    let captured: (RunOptions & OpenbuffClientOptions) | undefined
    let ran = false
    const client = makeFakeClient({
      beforeResolve: (runOptions) => {
        captured = runOptions
        ran = true
      },
    })
    const { promptHandler } = createServeBridge({ client, sessionData })

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      mcpServers: [],
    })
    expect(ran).toBe(true)
    expect(captured?.mcpServers).toBeUndefined()

    // A second dispatch with NO mcpServers at all. Use a FRESH capture var so
    // TS control-flow does not narrow a reused-then-reset variable to
    // `undefined` (the closure re-assignment is invisible to the type checker,
    // which would otherwise make `.mcpServers` an access on `never`).
    let capturedAbsent: (RunOptions & OpenbuffClientOptions) | undefined
    let ranAbsent = false
    const clientAbsent = makeFakeClient({
      beforeResolve: (runOptions) => {
        capturedAbsent = runOptions
        ranAbsent = true
      },
    })
    const { promptHandler: promptHandlerAbsent } = createServeBridge({
      client: clientAbsent,
      sessionData,
    })
    await promptHandlerAbsent({
      sessionId: 's2',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(ranAbsent).toBe(true)
    expect(capturedAbsent?.mcpServers).toBeUndefined()
  })
})
