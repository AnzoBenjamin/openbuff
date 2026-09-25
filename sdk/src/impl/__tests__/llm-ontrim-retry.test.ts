/**
 * Retry-idempotency tests for the non-streaming prompt paths: the
 * request-time emergency trim (and its side-effecting
 * onRequestContextTrimmed consumer) must fire once per request, not once per
 * retry attempt, even when the provider fails transiently and the shared
 * retry policy re-dispatches the request.
 */
import * as ai from 'ai'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import z from 'zod/v4'

import { userMessage } from '@codebuff/common/util/messages'

import { createHttpError } from '../../error-utils'
import { promptAiSdk, promptAiSdkStructured } from '../llm'
import * as modelProvider from '../model-provider'

import type { ParamsOf } from '@codebuff/common/types/function-params'
import type {
  PromptAiSdkFn,
  RequestContextTrimInfo,
} from '@codebuff/common/types/contracts/llm'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ModelResult } from '../model-provider'

type PromptAiSdkParams = ParamsOf<PromptAiSdkFn>

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const oversizedMessages: Message[] = [
  userMessage('old context '.repeat(10_000)),
  userMessage('middle context '.repeat(10_000)),
  userMessage('recent context '.repeat(10_000)),
]

function makeModelResult(): ModelResult {
  // Only the fields promptAiSdk/promptAiSdkStructured actually read are
  // populated; the rest is filled by the cast.
  return {
    model: { provider: 'mock-provider' },
    isChatGptOAuth: false,
    compatibility: {
      supportsTools: true,
      stripProviderMetadata: true,
      stripCacheControl: true,
    },
    reasoningEffort: undefined,
    effectiveModel: 'mock/model',
    contextWindowTokens: 2_000,
    pricing: undefined,
  } as unknown as ModelResult
}

function makePromptParams(
  overrides: Partial<PromptAiSdkParams>,
): PromptAiSdkParams {
  return {
    apiKey: 'test-key',
    runId: 'run-1',
    messages: oversizedMessages,
    clientSessionId: 'session-1',
    fingerprintId: 'fingerprint-1',
    userInputId: 'user-input-1',
    userId: 'user-1',
    sendAction: () => {},
    logger,
    trackEvent: () => {},
    signal: new AbortController().signal,
    ...overrides,
  } as PromptAiSdkParams
}

describe('non-streaming retry onTrimmed idempotency', () => {
  afterEach(() => {
    mock.restore()
  })

  test('promptAiSdk reports a context trim once per request, not once per retry', async () => {
    const trimInfos: RequestContextTrimInfo[] = []
    spyOn(modelProvider, 'getModelForRequest').mockImplementation(
      async () => makeModelResult(),
    )
    let generateTextCalls = 0
    const fakeResult = {
      text: 'mock response',
      finishReason: 'stop',
      usage: {},
      providerMetadata: undefined,
      request: undefined,
    } as unknown as Awaited<ReturnType<typeof ai.generateText>>
    const generateTextSpy = spyOn(ai, 'generateText').mockImplementation(
      (async () => {
        generateTextCalls++
        if (generateTextCalls === 1) {
          // Transient 5xx: the shared retry policy re-dispatches once.
          throw createHttpError('server error', 503)
        }
        return fakeResult
      }) as unknown as typeof ai.generateText,
    )

    const result = await promptAiSdk(
      makePromptParams({
        onRequestContextTrimmed: (info) => trimInfos.push(info),
      }),
    )

    // The trim itself is deterministic, so it must be reported exactly once
    // even though the retried request dispatched generateText twice.
    expect(generateTextCalls).toBe(2)
    expect(generateTextSpy).toHaveBeenCalledTimes(2)
    expect(trimInfos).toHaveLength(1)
    expect(result.aborted).toBe(false)
    if (!result.aborted) expect(result.value).toBe('mock response')
  })

  test('promptAiSdkStructured reports a context trim once per request, not once per retry', async () => {
    const trimInfos: RequestContextTrimInfo[] = []
    spyOn(modelProvider, 'getModelForRequest').mockImplementation(
      async () => makeModelResult(),
    )
    let generateObjectCalls = 0
    const fakeResult = {
      object: { answer: 'ok' },
      finishReason: 'stop',
      usage: {},
      providerMetadata: undefined,
      request: undefined,
    } as unknown as Awaited<ReturnType<typeof ai.generateObject>>
    spyOn(ai, 'generateObject').mockImplementation(
      (async () => {
        generateObjectCalls++
        if (generateObjectCalls === 1) {
          // Transient 5xx: the shared retry policy re-dispatches once.
          throw createHttpError('server error', 503)
        }
        return fakeResult
      }) as unknown as typeof ai.generateObject,
    )

    const result = await promptAiSdkStructured({
      ...makePromptParams({
        onRequestContextTrimmed: (info) => trimInfos.push(info),
      }),
      schema: z.object({ answer: z.string() }),
    } as unknown as Parameters<typeof promptAiSdkStructured>[0])

    expect(generateObjectCalls).toBe(2)
    expect(trimInfos).toHaveLength(1)
    expect(result.aborted).toBe(false)
    if (!result.aborted) expect(result.value).toEqual({ answer: 'ok' })
  })
})
