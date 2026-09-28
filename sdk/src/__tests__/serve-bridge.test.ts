import { describe, expect, test } from 'bun:test'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

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
})
