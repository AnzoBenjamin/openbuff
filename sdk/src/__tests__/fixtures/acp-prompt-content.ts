import { expect } from 'bun:test'
import { RequestError } from '@agentclientprotocol/sdk'
import { createServeBridge } from '../../serve/bridge'
import { AcpSessionData } from '../../services/acp/session-data'
import type { AcpPromptHandler } from '../../services/acp/acp-agent'
import type { OpenbuffClientOptions, RunOptions } from '../../run'

export type AcpPromptTestTurn = Parameters<AcpPromptHandler>[0]
export function createAcpPromptContentControl(projectRoot?: string) {
  const runs: Array<RunOptions & OpenbuffClientOptions> = []
  const updates: unknown[] = [],
    marked: unknown[] = []
  const sessionData = new AcpSessionData()
  const { promptHandler } = createServeBridge({
    client: {
      async run(options) {
        runs.push(options)
        return { output: { type: 'lastMessage', value: [] } }
      },
    },
    sessionData,
    projectRoot,
    onSessionUpdate: async (update) => {
      updates.push(update)
    },
    markClientMcpServers: (servers) => {
      marked.push(servers)
    },
  })
  const input = (
    extra: Partial<AcpPromptTestTurn> = {},
  ): AcpPromptTestTurn => ({
    sessionId: 'content-control',
    promptText: 'exact prompt',
    signal: new AbortController().signal,
    update: async () => {},
    ...extra,
  })
  return { promptHandler, input, runs, updates, marked, sessionData }
}
export async function expectAcpPromptRefusal(
  pending: Promise<unknown>,
  code: string,
  reason: string,
) {
  let failure: unknown
  try {
    await pending
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(RequestError)
  const rpc = failure as RequestError
  expect(rpc.code).toBe(-32602)
  expect(rpc.data).toMatchObject({ 'openbuff.dev': { code, reason } })
  const nextStep = (rpc.data as Record<string, { nextStep: string }>)[
    'openbuff.dev'
  ].nextStep
  expect(typeof nextStep).toBe('string')
  expect(nextStep.length).toBeGreaterThan(10)
}
export const acpPromptTestImage = {
  type: 'image',
  mimeType: 'image/png',
  data: Buffer.from('inline image bytes').toString('base64'),
} as const
