/**
 * Regression tests for the streamed tool-call buffer in `promptAiSdkStream`.
 *
 * Two coupled defects are covered:
 *
 * 1. The pending tool-call buffer lived outside the retry/failover loops and
 *    was only drained on the success path, so a stream that buffered a tool
 *    call and then failed left its payloads behind and the next attempt
 *    flushed them as though the failed model had produced them. The runtime
 *    executes every yielded tool-call chunk, so a stale partial edit payload
 *    would be applied a second time.
 * 2. `anyContentYielded` was set when a tool call was BUFFERED rather than
 *    YIELDED, so a stream that emitted only tool calls and then threw could
 *    never be retried or failed over — the call died emitting zero chunks
 *    (the observed "No output generated" death).
 *
 * Also pinned: the stream-only `finish` marker and the producer-side
 * transport-truncation marker it feeds. `promptAiSdkStream` yields
 * `{ type: 'finish', finishReason }` exactly once, as the LAST chunk before
 * the generator's return value, so the runtime's stream parser can annotate
 * max-token truncation on its tool-call error reports without the marker
 * ever reaching a downstream consumer. A finish reason of `'length'` (the
 * max-token cut) additionally marks the flushed tool-call chunks with
 * `transportTruncated: true` via `withTransportTruncation`; every other
 * finish reason flushes them with no marker property, covering both
 * branches of the flush ternary.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import * as ai from 'ai'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'

import { PROVIDER_CONFIG_ENV_VAR } from '../../provider-config'
import { createHttpError } from '../../error-utils'
import * as retryConfig from '../../retry-config'
import { promptAiSdkStream } from '../llm'
import * as modelProvider from '../model-provider'

import type {
  StreamChunk,
  ToolCallStreamChunk,
} from '@codebuff/common/types/contracts/llm'
import type { ModelResult } from '../model-provider'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A fullStream chunk the fake provider can emit. */
type FakeStreamChunk = StreamChunk | { type: 'finish'; finishReason: string }

function toolCallChunk(params: {
  toolCallId: string
  input: string
}): StreamChunk {
  return {
    type: 'tool-call',
    toolCallId: params.toolCallId,
    toolName: 'edit_transaction',
    input: params.input,
  }
}

/**
 * Builds the fake `streamText` result for one attempt. `failAfter` throws from
 * the async iterable mid-stream, exactly like a provider whose connection drops
 * after it already emitted chunks — the shape that leaves buffered tool calls
 * behind for the next attempt.
 */
function fakeStreamResponse(params: {
  chunks: FakeStreamChunk[]
  failAfter?: unknown
}): Awaited<ReturnType<typeof ai.streamText>> {
  const { chunks, failAfter } = params
  async function* fullStream(): AsyncGenerator<FakeStreamChunk> {
    for (const chunk of chunks) yield chunk
    if (failAfter !== undefined) throw failAfter
  }

  return {
    fullStream: fullStream(),
    finishReason: Promise.resolve('tool-calls'),
    response: Promise.resolve({ id: 'mock-response-id' }),
    request: Promise.resolve({ body: {} }),
    usage: Promise.resolve({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
    }),
    providerMetadata: Promise.resolve({}),
  } as unknown as Awaited<ReturnType<typeof ai.streamText>>
}

/** Only the fields promptAiSdkStream reads off a resolved model. */
function makeModelResult(params: { model: string }): ModelResult {
  return {
    model: { provider: 'mock-provider' },
    isChatGptOAuth: false,
    compatibility: {
      supportsTools: true,
      stripProviderMetadata: true,
      stripCacheControl: true,
    },
    reasoningEffort: undefined,
    effectiveModel: params.model,
    contextWindowTokens: 200_000,
    pricing: undefined,
  } as unknown as ModelResult
}

describe('promptAiSdkStream tool-call buffering across attempts', () => {
  let tempDir: string | undefined
  let streamTextSpy: ReturnType<typeof spyOn> | undefined
  let backoffSpy: ReturnType<typeof spyOn> | undefined
  let getModelSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    delete process.env[PROVIDER_CONFIG_ENV_VAR]
  })

  afterEach(() => {
    streamTextSpy?.mockRestore()
    streamTextSpy = undefined
    backoffSpy?.mockRestore()
    backoffSpy = undefined
    getModelSpy?.mockRestore()
    getModelSpy = undefined
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    delete process.env[PROVIDER_CONFIG_ENV_VAR]
  })

  function writeProviderConfig(params: { failoverModels?: string[] }): void {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-tool-call-buffer-'),
    )
    const configPath = path.join(tempDir, 'openbuff.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultModel: 'local/primary',
        defaultReasoningEffort: 'low',
        ...(params.failoverModels
          ? { failoverModels: params.failoverModels }
          : {}),
        providers: {
          local: {
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:11434/v1',
            models: ['primary', 'backup-a'],
          },
        },
      }),
    )
    process.env[PROVIDER_CONFIG_ENV_VAR] = configPath
  }

  function makePromptParams(): unknown {
    return {
      apiKey: 'test-key',
      runId: 'run-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
      clientSessionId: 'client-1',
      fingerprintId: 'finger-1',
      userInputId: 'input-1',
      userId: undefined,
      model: 'local/primary',
      agentId: undefined,
      sendAction: async () => {},
      logger,
      trackEvent: async () => {},
      signal: new AbortController().signal,
    }
  }

  /**
   * Drives the generator to completion, collecting the yielded tool-call
   * chunks: the full chunk objects, so tests can also assert on the
   * transport-truncation marker, not just the ids.
   */
  async function collectToolCallChunks(): Promise<ToolCallStreamChunk[]> {
    const toolCallChunks: ToolCallStreamChunk[] = []
    const iterator = promptAiSdkStream(
      makePromptParams() as never,
    )[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done) {
      const chunk = next.value as StreamChunk
      if (chunk.type === 'tool-call') toolCallChunks.push(chunk)
      next = await iterator.next()
    }
    return toolCallChunks
  }

  test('drops the failed attempt\'s buffered tool calls when the retry succeeds', async () => {
    writeProviderConfig({})
    getModelSpy = spyOn(
      modelProvider,
      'getModelForRequest',
    ).mockImplementation(async () => makeModelResult({ model: 'local/primary' }))
    backoffSpy = spyOn(
      retryConfig,
      'waitForBackoffDelay',
    ).mockImplementation(async () => {})

    // Attempt 1 buffers a PARTIAL edit payload and then loses the connection;
    // attempt 2 completes with the real tool call. The partial payload must
    // never reach the runtime on top of the good one.
    const responses = [
      fakeStreamResponse({
        chunks: [
          toolCallChunk({
            toolCallId: 'call-failed-attempt',
            input: '{"edits":[',
          }),
        ],
        failAfter: createHttpError('connection reset', 503),
      }),
      fakeStreamResponse({
        chunks: [
          toolCallChunk({ toolCallId: 'call-success', input: '{"edits":[]}' }),
          { type: 'finish', finishReason: 'tool-calls' },
        ],
      }),
    ]
    let streamTextCalls = 0
    streamTextSpy = spyOn(ai, 'streamText').mockImplementation((() => {
      const response = responses[streamTextCalls]
      streamTextCalls++
      return response
    }) as unknown as typeof ai.streamText)

    const toolCallChunks = await collectToolCallChunks()
    const toolCallIds = toolCallChunks.map((chunk) => chunk.toolCallId)

    // Buffering a tool call is not delivery, so the failure was retried...
    expect(streamTextCalls).toBe(2)
    expect(backoffSpy).toHaveBeenCalledTimes(1)
    // ...and only the successful attempt's payload reached the caller.
    expect(toolCallIds).toEqual(['call-success'])
    // The successful attempt finished with 'tool-calls' (not the max-token
    // cut), so its flushed chunks take the unmarked branch of the flush
    // ternary: no transportTruncated property at all.
    for (const chunk of toolCallChunks) {
      expect(Object.hasOwn(chunk, 'transportTruncated')).toBe(false)
    }
  })

  test('fails over after a stream that buffered a tool call and then failed', async () => {
    writeProviderConfig({ failoverModels: ['local/backup-a'] })
    const preferModelParamCalls: boolean[] = []
    getModelSpy = spyOn(
      modelProvider,
      'getModelForRequest',
    ).mockImplementation(async (modelParams) => {
      preferModelParamCalls.push(modelParams.preferModelParam === true)
      return makeModelResult({
        model: modelParams.preferModelParam ? 'local/backup-a' : 'local/primary',
      })
    })
    backoffSpy = spyOn(
      retryConfig,
      'waitForBackoffDelay',
    ).mockImplementation(async () => {})

    const responses = [
      fakeStreamResponse({
        chunks: [
          toolCallChunk({ toolCallId: 'call-primary', input: '{"edits":[' }),
        ],
        failAfter: createHttpError('invalid api key', 401),
      }),
      fakeStreamResponse({
        chunks: [
          toolCallChunk({ toolCallId: 'call-backup', input: '{"edits":[]}' }),
          { type: 'finish', finishReason: 'tool-calls' },
        ],
      }),
    ]
    let streamTextCalls = 0
    streamTextSpy = spyOn(ai, 'streamText').mockImplementation((() => {
      const response = responses[streamTextCalls]
      streamTextCalls++
      return response
    }) as unknown as typeof ai.streamText)

    const toolCallChunks = await collectToolCallChunks()
    const toolCallIds = toolCallChunks.map((chunk) => chunk.toolCallId)

    // A buffered-but-never-delivered tool call no longer blocks failover.
    expect(preferModelParamCalls).toEqual([false, true])
    // 401 is not retryable, so the primary is left immediately.
    expect(backoffSpy).not.toHaveBeenCalled()
    // Only the backup attempt's payload reached the caller.
    expect(toolCallIds).toEqual(['call-backup'])
    // The backup attempt also finished with 'tool-calls' (not the
    // max-token cut), so its flushed chunks carry no truncation marker
    // either: the other branch of the flush ternary.
    for (const chunk of toolCallChunks) {
      expect(Object.hasOwn(chunk, 'transportTruncated')).toBe(false)
    }
  })

  test('yields the stream-only finish chunk as the last yielded chunk before the return value', async () => {
    writeProviderConfig({})
    getModelSpy = spyOn(
      modelProvider,
      'getModelForRequest',
    ).mockImplementation(async () => makeModelResult({ model: 'local/primary' }))

    // The in-stream finish chunk reports 'length' (the max-token cut) while
    // the late-resolved response.finishReason says 'tool-calls': the yielded
    // marker must carry the AUTHORITATIVE in-stream reason. It must be the
    // final yield before the generator's return value, so the retry/failover
    // semantics built on anyContentYielded are untouched.
    const responses = [
      fakeStreamResponse({
        chunks: [
          toolCallChunk({ toolCallId: 'call-success', input: '{"edits":[]}' }),
          { type: 'finish', finishReason: 'length' },
        ],
      }),
    ]
    let streamTextCalls = 0
    streamTextSpy = spyOn(ai, 'streamText').mockImplementation((() => {
      const response = responses[streamTextCalls]
      streamTextCalls++
      return response
    }) as unknown as typeof ai.streamText)

    const iterator = promptAiSdkStream(
      makePromptParams() as never,
    )[Symbol.asyncIterator]()
    const yielded: StreamChunk[] = []
    let next = await iterator.next()
    while (!next.done) {
      yielded.push(next.value as StreamChunk)
      next = await iterator.next()
    }

    const finishChunks = yielded.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'finish' }> =>
        chunk.type === 'finish',
    )
    // Exactly one finish chunk, carrying the provider's in-stream reason.
    expect(finishChunks).toEqual([{ type: 'finish', finishReason: 'length' }])
    // It is the last chunk yielded before the return value, and the flushed
    // tool call was yielded ahead of it.
    expect(yielded[yielded.length - 1]).toEqual({
      type: 'finish',
      finishReason: 'length',
    })
    // The flushed tool call carries the transport-truncation marker: the
    // in-stream finish chunk reported 'length' (the max-token cut), so the
    // flush marked the buffered payload via `withTransportTruncation`.
    expect(yielded[0]).toMatchObject({
      type: 'tool-call',
      transportTruncated: true,
    })
  })
})
