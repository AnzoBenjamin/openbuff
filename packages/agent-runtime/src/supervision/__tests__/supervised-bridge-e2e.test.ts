/**
 * P2-T8b: supervised-child RPC bridge END-TO-END tests over a REAL child
 * process (bun child-entry.ts spawned by the real supervisor via the default
 * seam), with MINIMAL real parent deps behind the bridge.
 *
 * THE proof the bridge works: a real bun child runs the REAL agent loop with
 * its callback deps supplied over the ndjson Unix-socket bridge and settles
 * `outcome === 'ok'` with `receipt.status === 'completed'`.
 *
 * Every test is wrapped in a bounded wall-clock race so a bridge bug shows
 * as a timeout FAILURE, never a hung test run. Linux-only (real processes,
 * unix sockets). Total wall-time budget: < ~30s.
 */
import { buildSupervisedBridgeHandlers } from '../parent-bridge-server'
import { buildDefaultSpawnSupervised } from '../supervised-spawn'

import { describe, expect, it } from 'bun:test'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { SettledSubagentResult, SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { SupervisedBridgeHandlerDeps } from '../parent-bridge-server'

const E2E_TIMEOUT_MS = 20_000
const CHILD_DEADLINE_MS = 15_000

/** Fails the test (instead of hanging) when the seam does not settle in time. */
async function settleBounded(
  seam: (request: SupervisedSpawnRequest) => Promise<SettledSubagentResult>,
  request: SupervisedSpawnRequest,
): Promise<SettledSubagentResult> {
  return Promise.race([
    seam(request),
    Bun.sleep(E2E_TIMEOUT_MS).then(() => {
      throw new Error(
        `supervised bridge e2e did not settle within ${E2E_TIMEOUT_MS}ms — a bridge bug would hang here`,
      )
    }),
  ])
}

/**
 * Minimal REAL deps for the parent-side handler table: every bridged dep
 * answers successfully so a loop that only prompts (no tools) can finish.
 */
function buildMinimalBridgeDeps(): SupervisedBridgeHandlerDeps {
  return {
    promptAiSdk: async () => ({ aborted: false, value: 'ok' }),
    promptAiSdkStream: async function* () {
      yield { type: 'text', text: 'ok' }
      return { aborted: false, value: 'ok' }
    },
    promptAiSdkStructured: async () => ({ aborted: false, value: {} }),
    sendAction: async () => null,
    requestToolCall: async () => null,
    requestFiles: async () => [],
    requestOptionalFile: async () => null,
    requestMcpToolData: async () => null,
    handleStepsLogChunk: () => {},
    sendSubagentChunk: () => {},
    trackEvent: () => {},
    fetch: globalThis.fetch,
    startAgentRun: async () => ({ agentRunId: 'ar-1', agentRunContext: {} }),
    finishAgentRun: async () => ({ agentRunContext: {} }),
    addAgentStep: async () => null,
    fetchAgentFromDatabase: async () => null,
    consumeCreditsWithFallback: async () => ({ success: true }),
    apiKey: 'test-key',
  } as unknown as SupervisedBridgeHandlerDeps
}

/**
 * Smallest valid AgentTemplate requiring NO tools. Built as a plain
 * JSON-serializable object because it crosses the request-file transport
 * (localAgentTemplates is `unknown` on the wire contract).
 */
function buildMinimalTemplate(id: string): Record<string, unknown> {
  return {
    id,
    displayName: 'Bridge Echo Test',
    mcpServers: {},
    toolNames: [],
    programmaticToolNames: [],
    spawnableAgents: [],
    systemPrompt: 'You are a test agent. Reply with OK and finish.',
    instructionsPrompt: 'Reply with OK and finish.',
    stepPrompt: 'Reply with OK and finish.',
    inputSchema: {},
    includeMessageHistory: false,
    inheritParentSystemPrompt: false,
    outputMode: 'last_message',
    handleSteps: undefined,
  }
}

function makeBridgeRequest(
  overrides: Partial<SupervisedSpawnRequest> = {},
): SupervisedSpawnRequest {
  return {
    agentType: 'test-bridge-echo',
    prompt: 'Reply with OK and finish',
    spawnParams: undefined,
    child: { agentId: 'bridge-e2e-agent-1' },
    timeoutMs: CHILD_DEADLINE_MS,
    localAgentTemplates: {
      'test-bridge-echo': buildMinimalTemplate('test-bridge-echo'),
    },
    ...overrides,
  }
}

describe('supervised bridge e2e (P2-T8b, real child, linux-only)', () => {
  it.skipIf(process.platform !== 'linux')(
    'a real bun child completes the REAL agent loop over the bridge (outcome ok, receipt completed)',
    async () => {
      const seam = buildDefaultSpawnSupervised(
        {},
        buildSupervisedBridgeHandlers(buildMinimalBridgeDeps()),
      )
      // The seam removes its own sandbox in a finally; just verify no throw.
      const result = await settleBounded(seam, makeBridgeRequest())
      expect(result.outcome).toBe('ok')
      const receipt = result.receipt as AgentReceipt
      expect(receipt?.status).toBe('completed')
      expect(receipt?.outcome).toBe('ok')
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'a THUNK handler-table source starts the bridge exactly like a direct table (lazy-load discipline)',
    async () => {
      // The SDK composition root supplies the handler table as a thunk so it
      // never statically imports parent-bridge-server.ts; the thunk must be
      // invoked on the flag-on spawn path and the bridge must work end-to-end.
      let thunkInvoked = false
      const seam = buildDefaultSpawnSupervised({}, async () => {
        thunkInvoked = true
        return buildSupervisedBridgeHandlers(buildMinimalBridgeDeps())
      })
      const result = await settleBounded(seam, makeBridgeRequest())
      expect(thunkInvoked).toBe(true)
      expect(result.outcome).toBe('ok')
      const receipt = result.receipt as AgentReceipt
      expect(receipt?.status).toBe('completed')
      expect(receipt?.outcome).toBe('ok')
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'a handler table missing promptAiSdk settles a structured failed receipt naming the gap',
    async () => {
      // A RAW partial handler table: promptAiSdk has no parent handler, so
      // the bridged call gets the structured 'not supplied' failure and the
      // child must settle honestly (failed receipt), never hang.
      const seam = buildDefaultSpawnSupervised({}, {
        trackEvent: async () => null,
      } as unknown as Parameters<typeof buildDefaultSpawnSupervised>[1])
      const result = await settleBounded(seam, makeBridgeRequest())
      expect(result.outcome).toBe('ok') // transport-level: one valid envelope
      const receipt = result.receipt as AgentReceipt
      expect(receipt?.status).toBe('failed')
      expect(receipt?.outcome).toBe('crashed')
      const serialized = JSON.stringify(receipt)
      const namesTheGap =
        serialized.includes('promptAiSdk') || serialized.includes('not supplied')
      expect(namesTheGap).toBe(true)
    },
  )
})
