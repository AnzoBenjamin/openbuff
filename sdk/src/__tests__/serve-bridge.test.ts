import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  test('non-text payloads reach onSessionUpdate while text still streams via update', async () => {
    const sessionData = new AcpSessionData()
    const received: unknown[] = []
    const client = makeFakeClient({
      events: [
        {
          type: 'tool_call',
          toolCallId: 't1',
          toolName: 'read_files',
          input: { path: 'src/a.ts' },
        },
        { type: 'text', text: 'visible' },
      ],
    })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      onSessionUpdate: (payload) => {
        received.push(payload)
      },
    })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    // Text still streams through update (sanitized); the mapped tool card
    // goes through the new seam instead. The §6.1 baseline
    // capabilities_changed (sent before the first turn) and the §6.4 idle
    // gate_state notification (sent after the first message chunk) ride the
    // seam alongside it.
    expect(updates).toEqual(['visible'])
    expect(received).toHaveLength(3)
    expect(received[0]).toMatchObject({
      method: '_openbuff.dev/capabilities_changed',
    })
    expect(received[1]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      kind: 'read',
      status: 'pending',
      // No projectRoot option supplied, so the location stays relative.
      locations: [{ path: 'src/a.ts' }],
    })
    expect(received[2]).toMatchObject({
      method: '_openbuff.dev/gate_state',
    })
  })

  test('without onSessionUpdate, non-text payloads are dropped (Wave-1 behavior)', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({
      events: [
        { type: 'tool_start', toolCallId: 't1' },
        {
          type: 'tool_result',
          toolCallId: 't1',
          toolName: 'read_files',
          output: [{ type: 'json', value: { ok: true } }],
        },
        { type: 'phase', phase: 'planning' },
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

  test('eventsMode full forwards telemetry variants as _openbuff.dev/event payloads', async () => {
    const sessionData = new AcpSessionData()
    const received: unknown[] = []
    const phaseEvent: PrintModeEvent = { type: 'phase', phase: 'planning' }
    const client = makeFakeClient({ events: [phaseEvent] })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      eventsMode: 'full',
      onSessionUpdate: (payload) => {
        received.push(payload)
      },
    })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    expect(updates).toEqual([])
    // The §6.1 baseline capabilities_changed precedes the telemetry ext
    // notification: a session with no stored map gets the honest P1 default
    // before its first turn.
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({
      method: '_openbuff.dev/capabilities_changed',
      params: { capabilities: { kind: 'openbuff.capabilities', version: 1 } },
    })
    expect(received[1]).toEqual({
      method: '_openbuff.dev/event',
      params: { sessionId: 's1', event: phaseEvent },
    })
  })

  test('eventsMode full forwards subagent text through the sanitized update seam', async () => {
    const sessionData = new AcpSessionData()
    const received: unknown[] = []
    const client = makeFakeClient({
      events: [{ type: 'text', text: 'child says cap.v3.1.2.ABCdef here', agentId: 'agent-2' }],
    })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      eventsMode: 'full',
      onSessionUpdate: (payload) => {
        received.push(payload)
      },
    })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    // Subagent text is an agent_message_chunk, so it crosses via update —
    // sanitized like every other forwarded chunk. The §6.1 baseline
    // capabilities_changed and §6.4 idle gate_state notifications ride the
    // seam; subagent text itself does not.
    expect(updates).toHaveLength(1)
    expect(updates[0]).not.toContain('cap.v3.')
    expect(updates[0]).toContain('[REDACTED_CAPABILITY]')
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({
      method: '_openbuff.dev/capabilities_changed',
    })
    expect(received[1]).toMatchObject({
      method: '_openbuff.dev/gate_state',
    })
  })

  test('NEW-3: host-injected credentialValues are held back and redacted across chunk boundaries', async () => {
    const sessionData = new AcpSessionData()
    const secret = 'sk-super-secret-value-42'
    const client = makeFakeClient({
      events: [
        { type: 'text', text: 'key is ' },
        { type: 'text', text: `${secret} ok` },
      ],
    })
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      credentialValues: [secret],
    })
    const { updates, update } = collectUpdates()

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update,
      signal: new AbortController().signal,
    })

    const joined = updates.join('')
    // No single frame, and no concatenation of frames, carries the secret:
    // the value-level no-split invariant only holds because the HOST injected
    // the configured credential values through ServeBridgeOptions.
    expect(joined).not.toContain(secret)
    expect(joined).toContain('[REDACTED_SECRET]')
    expect(joined).toContain('key is')
  })

  test('§6.1: the baseline capability map derives journal flags from the store (an in-memory store advertises no resume/replay)', async () => {
    const sessionData = new AcpSessionData()
    const client = makeFakeClient({})
    const { promptHandler } = createServeBridge({ client, sessionData })

    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })

    const map = sessionData.getCapabilities('s1')
    expect(map).toBeDefined()
    // A purely in-memory store must not advertise resume/replay that
    // session/load cannot honor.
    expect(map!.journal).toEqual({ resume: false, replay: false })
    expect(map!.sandbox).toEqual({
      tier: 'lexical',
      enforced: false,
      network: 'unrestricted',
    })
    expect(map!.gate).toEqual({ enabled: true })
  })

  test('§6.1: a journal-backed store honestly advertises resume/replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-bridge-journal-'))
    try {
      const sessionData = new AcpSessionData({ journalDir: dir })
      const client = makeFakeClient({})
      const { promptHandler } = createServeBridge({ client, sessionData })

      await promptHandler({
        sessionId: 's1',
        promptText: 'hi',
        update: async () => {},
        signal: new AbortController().signal,
      })

      expect(sessionData.getCapabilities('s1')?.journal).toEqual({
        resume: true,
        replay: true,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
