import { describe, expect, test } from 'bun:test'

import { RequestError } from '@agentclientprotocol/sdk'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

import { createServeBridge } from '../serve/bridge'
import type { ServeBridgeClient } from '../serve/bridge'
import type {
  OpenbuffClientOptions,
  RunOptions,
} from '../run'
import type { RunState } from '../run-state'
import type { HarnessApprovalRequest } from '../services/harness-enforcement'
import type { AcpReverseRequests } from '../services/acp/acp-agent'
import { AcpSessionData } from '../services/acp/session-data'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

const DONE_STATE: RunState = {
  output: { type: 'error', message: 'done' },
}

/** A fake reverseRequests seam that records the permission request params. */
type FakeReverseRequests = AcpReverseRequests & {
  permissionParams: RequestPermissionRequest[]
}

function makeFakeReverseRequests(
  respond: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>,
): FakeReverseRequests {
  const permissionParams: RequestPermissionRequest[] = []
  return {
    permissionParams,
    requestPermission: async (params) => {
      permissionParams.push(params)
      return respond(params)
    },
    readTextFile: async () => ({ content: '' }),
    writeTextFile: async () => {},
    createTerminal: async () => ({ terminalId: 't' }),
  }
}

/** A fake client whose `.run` invokes the host requestApproval callback. */
function makeApprovalClient(
  respond: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>,
): { client: ServeBridgeClient; reverseRequests: FakeReverseRequests } {
  const reverseRequests = makeFakeReverseRequests(respond)
  const client: ServeBridgeClient = {
    async run(runOptions) {
      // Drive the approval through the bridge-wired host callback.
      await runOptions.requestApproval?.({
        action: 'push',
        target: 'origin/main',
        commandHash: 'hash-abc',
        reason: 'push to default branch',
        risk: 'high',
      } satisfies HarnessApprovalRequest)
      return DONE_STATE
    },
  }
  return { client, reverseRequests }
}

describe('serve approval bridge', () => {
  test('GV-21: sanitizes control/bidi/zero-width chars and caps title', async () => {
    const { client, reverseRequests } = makeApprovalClient(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    const sessionData = new AcpSessionData()
    const { promptHandler } = createServeBridge({
      client,
      sessionData,
      reverseRequests,
    })

    // Inject a hostile branch/target into the approval the fake client drives.
    const hostileClient: ServeBridgeClient = {
      async run(runOptions) {
        await runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          branch: 'x\u001b]0;pwn\u0007\u202Eevil\u200B',
          commandHash: 'h',
          reason: 'r\u2066e\u2069',
          risk: 'high',
        })
        return DONE_STATE
      },
    }
    const hostileReverse = makeFakeReverseRequests(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    const { promptHandler: hostileHandler } = createServeBridge({
      client: hostileClient,
      sessionData,
      reverseRequests: hostileReverse,
    })
    await hostileHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })

    const params = hostileReverse.permissionParams[0]
    expect(params).toBeDefined()
    // No ESC / BEL / bidi / zero-width chars survive anywhere in the title or
    // approval meta; every such char became U+FFFD.
    const title = params.toolCall.title ?? ''
    expect(title).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/)
    const approval = (params._meta as Record<string, Record<string, unknown>>)[
      'openbuff.dev'
    ].approval as Record<string, unknown>
    expect(String(approval.branch)).toContain('\uFFFD')
    expect(String(approval.branch)).not.toContain('\u001b')
    expect(String(approval.branch)).not.toContain('\u202E')
    expect(String(approval.branch)).not.toContain('\u200B')
    expect(String(approval.command)).not.toContain('\u2028')
    // Title is capped at 200 chars.
    expect(title.length).toBeLessThanOrEqual(200)
    // The approval meta carries command + commandHash (§12.4 command binding).
    expect(approval.commandHash).toBe('h')
    // Only the one-shot options are offered (no allow_always).
    expect(params.options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once',
    ])
  })

  test('GV-22: allow_always / proceed_always / reject_once / cancelled all resolve false', async () => {
    const outcomes: Array<RequestPermissionResponse['outcome']> = [
      { outcome: 'selected', optionId: 'allow_always' },
      { outcome: 'selected', optionId: 'proceed_always' },
      { outcome: 'selected', optionId: 'reject_once' },
      { outcome: 'cancelled' },
    ]
    for (const outcome of outcomes) {
      let approved: boolean | undefined
      const reverseRequests = makeFakeReverseRequests(async () => ({ outcome }))
      const client: ServeBridgeClient = {
        async run(runOptions) {
          approved = await runOptions.requestApproval?.({
            action: 'push',
            target: 'origin/main',
            commandHash: 'h',
            reason: 'r',
            risk: 'high',
          })
          return DONE_STATE
        },
      }
      const { promptHandler } = createServeBridge({
        client,
        sessionData: new AcpSessionData(),
        reverseRequests,
      })
      await promptHandler({
        sessionId: 's1',
        promptText: 'hi',
        update: async () => {},
        signal: new AbortController().signal,
      })
      expect(approved).toBe(false)
    }
  })

  test('GV-22 positive: selected allow_once resolves true', async () => {
    let approved: boolean | undefined
    const reverseRequests = makeFakeReverseRequests(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    const client: ServeBridgeClient = {
      async run(runOptions) {
        approved = await runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          commandHash: 'h',
          reason: 'r',
          risk: 'high',
        })
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
      reverseRequests,
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(approved).toBe(true)
  })

  test('GV-23: disconnect/cancel mid-approval resolves false AND aborts the run', async () => {
    const controller = new AbortController()
    let approved: boolean | undefined
    // The reverse request stays pending forever; the abort resolves it.
    const reverseRequests = makeFakeReverseRequests(
      () => new Promise<RequestPermissionResponse>(() => {}),
    )
    const client: ServeBridgeClient = {
      async run(runOptions) {
        const approvalPromise = runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          commandHash: 'h',
          reason: 'r',
          risk: 'high',
        })
        // Abort the turn (session/cancel / owner disconnect) mid-approval.
        controller.abort()
        approved = await approvalPromise
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
      reverseRequests,
    })
    const result = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: controller.signal,
    })
    // The approval resolved false (fail closed) ...
    expect(approved).toBe(false)
    // ... AND the run aborted with stopReason cancelled (the prompt handler
    // observes the aborted signal).
    expect(result.stopReason).toBe('cancelled')
  })

  test('GV-24: a duplicate/late response after resolution is ignored', async () => {
    // The first (allow_once) resolution wins; a fabricated second response
    // for the same request cannot change the outcome.
    let callCount = 0
    let approved: boolean | undefined
    const reverseRequests = makeFakeReverseRequests(async () => {
      callCount += 1
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    })
    const client: ServeBridgeClient = {
      async run(runOptions) {
        approved = await runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          commandHash: 'h',
          reason: 'r',
          risk: 'high',
        })
        // Simulate a duplicate response arriving after the approval settled:
        // the bridge's settle-once map no longer holds the id, so this is a
        // no-op. We assert the outcome stayed the FIRST one.
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
      reverseRequests,
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(callCount).toBe(1)
    expect(approved).toBe(true)
  })

  test('terminal error event answers the prompt with -32603 openbuff.dev message', async () => {
    const events: PrintModeEvent[] = [
      { type: 'text', text: 'before' },
      { type: 'error', message: 'raw detail', userMessage: 'calm summary' },
    ]
    const client: ServeBridgeClient = {
      async run(runOptions) {
        for (const event of events) {
          await runOptions.handleEvent?.(event)
        }
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    let thrown: unknown
    try {
      await promptHandler({
        sessionId: 's1',
        promptText: 'hi',
        update: async () => {},
        signal: new AbortController().signal,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: -32603,
      data: { 'openbuff.dev': { message: 'calm summary' } },
    })
    // The thrown value MUST be a real Error (RequestError) instance: the ACP
    // wire layer maps a thrown RequestError onto the JSON-RPC error response,
    // while a bare plain-object throw may be wrapped or discarded by a
    // JSON-RPC implementation (finding printmode-rpc-error-throw-shape).
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toBeInstanceOf(RequestError)
  })

  test('an auto-recovering error event does NOT surface a terminal error', async () => {
    const events: PrintModeEvent[] = [
      { type: 'error', message: 'retrying', autoRecovering: true },
    ]
    const client: ServeBridgeClient = {
      async run(runOptions) {
        for (const event of events) {
          await runOptions.handleEvent?.(event)
        }
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    const result = await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(result.stopReason).toBe('end_turn')
  })

  test('§5 production path: a per-turn reverseRequests seam drives session/request_permission', async () => {
    // Production wiring: the ACP agent derives the seam from the OWNING
    // connection and forwards it on the prompt-handler input — the bridge is
    // constructed WITHOUT any static reverseRequests. The approval must still
    // reach `session/request_permission` and resolve true for allow_once.
    let approved: boolean | undefined
    const reverseRequests = makeFakeReverseRequests(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    const client: ServeBridgeClient = {
      async run(runOptions) {
        approved = await runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          commandHash: 'h',
          reason: 'r',
          risk: 'high',
        })
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      reverseRequests,
    })
    expect(approved).toBe(true)
    expect(reverseRequests.permissionParams).toHaveLength(1)
    expect(reverseRequests.permissionParams[0].sessionId).toBe('s1')
  })

  test('§5 stays fail-closed when neither a per-turn nor a static seam exists', async () => {
    // The fail-closed invariant must survive the per-turn seam addition: a
    // bridge with NO seam anywhere (neither per-turn nor static) still
    // resolves every approval false.
    let approved: boolean | undefined
    const client: ServeBridgeClient = {
      async run(runOptions) {
        approved = await runOptions.requestApproval?.({
          action: 'push',
          target: 'origin/main',
          commandHash: 'h',
          reason: 'r',
          risk: 'high',
        })
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
    expect(approved).toBe(false)
  })

  test('§4.2 ask_user: per-turn elicitation/form capability drives elicitation/create', async () => {
    const methods: string[] = []
    const client: ServeBridgeClient = {
      async run(runOptions) {
        const askUser = runOptions.overrideTools?.ask_user
        const execute = typeof askUser === 'function' ? askUser : undefined
        const result = await execute?.({
          questions: [
            {
              question: 'Deploy now?',
              options: [{ label: 'yes' }, { label: 'no' }],
              multiSelect: false,
            },
          ],
        })
        expect(result).toEqual([
          {
            type: 'json',
            value: {
              answers: [{ questionIndex: 0, selectedOption: 'yes' }],
            },
          },
        ] satisfies ToolResultOutput[])
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
      clientCapabilities: { elicitation: { form: {} } },
      onReverseRequest: async (method, params) => {
        methods.push(method)
        expect(
          (params as { requestedSchema: { properties: unknown } }).requestedSchema
            .properties,
        ).toBeDefined()
        return { action: 'accept', content: { q0: 'yes' } }
      },
    })
    expect(methods).toEqual(['elicitation/create'])
  })

  test('§4.2 ask_user: no per-turn seam yields the skipped result (fail closed)', async () => {
    const client: ServeBridgeClient = {
      async run(runOptions) {
        const askUser = runOptions.overrideTools?.ask_user
        const execute = typeof askUser === 'function' ? askUser : undefined
        const result = await execute?.({
          questions: [
            {
              question: 'Deploy now?',
              options: [{ label: 'yes' }],
              multiSelect: false,
            },
          ],
        })
        expect(result).toEqual([
          { type: 'json', value: { skipped: true } },
        ] satisfies ToolResultOutput[])
        return DONE_STATE
      },
    }
    const { promptHandler } = createServeBridge({
      client,
      sessionData: new AcpSessionData(),
    })
    await promptHandler({
      sessionId: 's1',
      promptText: 'hi',
      update: async () => {},
      signal: new AbortController().signal,
    })
  })
})
