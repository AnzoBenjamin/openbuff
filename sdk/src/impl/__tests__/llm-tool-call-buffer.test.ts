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

import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
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

  /** Drives the generator to completion, collecting yielded tool-call ids. */
  async function collectToolCallIds(): Promise<string[]> {
    const toolCallIds: string[] = []
    const iterator = promptAiSdkStream(
      makePromptParams() as never,
    )[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done) {
      const chunk = next.value as StreamChunk
      if (chunk.type === 'tool-call') toolCallIds.push(chunk.toolCallId)
      next = await iterator.next()
    }
    return toolCallIds
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

    const toolCallIds = await collectToolCallIds()

    // Buffering a tool call is not delivery, so the failure was retried...
    expect(streamTextCalls).toBe(2)
    expect(backoffSpy).toHaveBeenCalledTimes(1)
    // ...and only the successful attempt's payload reached the caller.
    expect(toolCallIds).toEqual(['call-success'])
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

    const toolCallIds = await collectToolCallIds()

    // A buffered-but-never-delivered tool call no longer blocks failover.
    expect(preferModelParamCalls).toEqual([false, true])
    // 401 is not retryable, so the primary is left immediately.
    expect(backoffSpy).not.toHaveBeenCalled()
    // Only the backup attempt's payload reached the caller.
    expect(toolCallIds).toEqual(['call-backup'])
  })
})
