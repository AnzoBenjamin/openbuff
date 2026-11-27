import { expect, test } from 'bun:test'
import { PassThrough, Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@agentclientprotocol/sdk'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import { classifyActionOutput } from '@codebuff/common/util/action-outcomes'

import { AcpRemoteBackend } from '../client/acp-client'

async function withRemote(
  prompt: (connection: AgentSideConnection) => Agent['prompt'],
  control: (backend: AcpRemoteBackend) => Promise<void>,
) {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  const agentStream = ndJsonStream(
    Writable.toWeb(toClient) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(toAgent) as unknown as ReadableStream<Uint8Array>,
  )
  const clientStream = ndJsonStream(
    Writable.toWeb(toAgent) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(toClient) as unknown as ReadableStream<Uint8Array>,
  )
  new AgentSideConnection(
    (connection) => ({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }),
      newSession: () => ({ sessionId: 'fixture-session' }),
      authenticate: () => ({}),
      prompt: prompt(connection),
      cancel: async () => {},
    }),
    agentStream,
  )
  const backend = new AcpRemoteBackend({ kind: 'stream', stream: clientStream })
  try {
    await control(backend)
  } finally {
    toAgent.destroy()
    toClient.destroy()
    await backend.close()
  }
}

test('actual ACP hard stops cannot be overridden by completed metadata', async () => {
  for (const stopReason of [
    'cancelled',
    'max_tokens',
    'max_turn_requests',
  ] as const) {
    await withRemote(
      () => async () => ({
        stopReason,
        _meta: {
          'openbuff.dev': {
            runOutcome: { termination: 'completed' },
            taskAcceptance: { status: 'accepted', oracle: 'fixture' },
          },
        },
      }),
      async (backend) => {
        const result = await backend.run({
          agent: 'fixture',
          prompt: 'fixed local control',
          handleEvent: () => {},
        })
        expect(result.runOutcome?.termination).toBe(
          stopReason === 'max_tokens'
            ? 'budget_exhausted'
            : stopReason === 'max_turn_requests'
              ? 'step_exhausted'
              : 'cancelled',
        )
        expect(result.output.type).toBe('error')
      },
    )
  }
})

test('actual ACP request errors keep completed execution and rejected task separate', async () => {
  await withRemote(
    () => async () => {
      throw new RequestError(-32603, 'Task rejected', {
        'openbuff.dev': {
          runOutcome: { termination: 'completed' },
          taskAcceptance: {
            status: 'rejected',
            oracle: 'fixture',
            basis: 'expected result missing',
          },
        },
      })
    },
    async (backend) => {
      const result = await backend.run({
        agent: 'fixture',
        prompt: 'fixed local control',
        handleEvent: () => {},
      })
      expect(result.runOutcome?.termination).toBe('completed')
      expect(result.taskAcceptance?.status).toBe('rejected')
      expect(result.output.type).toBe('lastMessage')
    },
  )
})

test('actual ACP failed status survives JSON and conflicting action metadata', async () => {
  const succeededAction = {
    actionId: 'action',
    attemptId: 'attempt',
    runId: 'run',
    toolName: 'custom',
    basis: { inputHash: 'sha256:fixture' },
    outcome: 'succeeded',
    effect: {
      status: 'confirmed',
      receiptIds: ['receipt'],
      confirmedPaths: ['a.ts'],
    },
  }
  await withRemote(
    (connection) => async () => {
      await connection.sessionUpdate({
        sessionId: 'fixture-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'custom',
          status: 'pending',
        },
      })
      await connection.sessionUpdate({
        sessionId: 'fixture-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool',
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '{"message":"partial work then failure"}',
              },
            },
          ],
          _meta: { 'openbuff.dev': { actionOutcome: succeededAction } },
        },
      })
      return {
        stopReason: 'end_turn',
        _meta: {
          'openbuff.dev': {
            runOutcome: { termination: 'completed' },
            taskAcceptance: { status: 'accepted', oracle: 'recovery' },
          },
        },
      }
    },
    async (backend) => {
      const events: PrintModeEvent[] = []
      const result = await backend.run({
        agent: 'fixture',
        prompt: 'fixed local control',
        handleEvent: (event) => {
          events.push(event)
        },
      })
      const tool = events.find((event) => event.type === 'tool_result')
      expect(tool?.type).toBe('tool_result')
      if (tool?.type !== 'tool_result') throw new Error('missing ACP result')
      expect(classifyActionOutput('custom', tool.output).outcome).toBe('failed')
      expect(tool.actionOutcome).toMatchObject({
        outcome: 'failed',
        effect: succeededAction.effect,
      })
      expect(result.actionOutcomes?.[0]).toMatchObject({
        outcome: 'failed',
        effect: succeededAction.effect,
      })
      expect(result.runOutcome?.termination).toBe('completed')
      expect(result.taskAcceptance?.status).toBe('accepted')
    },
  )
})
