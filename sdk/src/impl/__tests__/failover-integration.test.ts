import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, spyOn, test, beforeEach, afterEach } from 'bun:test'
import { APICallError, NoOutputGeneratedError } from 'ai'
import type { LanguageModel } from 'ai'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'

import * as modelProvider from '../model-provider'
import * as retryConfig from '../../retry-config'
import { promptAiSdkStream } from '../llm'
import { resolveModelsToTry } from '../failover'
import {
  PROVIDER_CONFIG_ENV_VAR,
  providerConfigFileSchema,
  resolveConfiguredAgentModelConfig,
} from '../../provider-config'
import type { LoadedProviderConfig } from '../../provider-config'

// Env isolation helpers — copied from sdk/src/__tests__/model-provider.test.ts.
const originalEnv = { ...process.env }

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
}

describe('failover loop contract (composed)', () => {
  beforeEach(() => {
    resetEnv()
    delete process.env[PROVIDER_CONFIG_ENV_VAR]
  })

  afterEach(() => {
    resetEnv()
  })

  // Build a validated LoadedProviderConfig via providerConfigFileSchema.parse
  // so the fixture is type-checked against the real config schema (mirrors the
  // resolver-test fixture style in model-provider.test.ts). The primary is
  // deliberately repeated in failoverModels to exercise the dedup path.
  function makeLoadedConfig(): LoadedProviderConfig {
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/primary',
      defaultReasoningEffort: 'low',
      failoverModels: ['local/primary', 'local/backup-a', 'local/backup-b'],
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['primary', 'backup-a', 'backup-b'],
        },
      },
    })
    return { sourceFilePaths: [], config }
  }

  test('resolveModelsToTry dedupes a repeated primary and preserves failover order', () => {
    const loadedConfig = makeLoadedConfig()
    expect(resolveModelsToTry('local/primary', loadedConfig)).toEqual([
      'local/primary',
      'local/backup-a',
      'local/backup-b',
    ])
  })

  test('resolveConfiguredAgentModelConfig with preferModelParam keeps each backup model (pre-M8.1 bypass)', () => {
    const loadedConfig = makeLoadedConfig()
    const models = resolveModelsToTry('local/primary', loadedConfig)
    // Skip the primary (index 0); assert each backup wins over defaultModel
    // routing. The pre-M8.1 bug would have re-resolved every backup to
    // `local/primary`, making failover a no-op.
    for (const backup of models.slice(1)) {
      expect(
        resolveConfiguredAgentModelConfig({
          model: backup,
          loadedConfig,
          preferModelParam: true,
        }),
      ).toEqual({ model: backup, reasoningEffort: 'low' })
    }
  })

  test('resolveConfiguredAgentModelConfig without preferModelParam honors defaultModel for the primary', () => {
    const loadedConfig = makeLoadedConfig()
    expect(
      resolveConfiguredAgentModelConfig({
        model: 'local/primary',
        loadedConfig,
      }),
    ).toEqual({ model: 'local/primary', reasoningEffort: 'low' })
  })

  test('resolveModelsToTry returns a single-element list when failoverModels is unset (no-failover baseline)', () => {
    // No failoverModels configured: the loop should have exactly one attempt
    // (the primary) and never enter the failover branch.
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/primary',
      defaultReasoningEffort: 'low',
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['primary'],
        },
      },
    })
    const loadedConfig: LoadedProviderConfig = {
      sourceFilePaths: [],
      config,
    }
    expect(resolveModelsToTry('local/primary', loadedConfig)).toEqual([
      'local/primary',
    ])
  })

  test('resolveModelsToTry dedupes a failover model that repeats a non-default primary (agentId-routed primary)', () => {
    // Covers the case where the primary is resolved from agentId routing
    // (not defaultModel). The dedup filter is `model !== primaryModel`, so a
    // failoverModels entry that coincidentally repeats the agent-routed primary
    // must be dropped — otherwise the loop would wastefully retry the same
    // model that just failed.
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/default-model',
      defaultReasoningEffort: 'low',
      failoverModels: ['local/agent-routed', 'local/backup-a'],
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['default-model', 'agent-routed', 'backup-a'],
        },
      },
    })
    const loadedConfig: LoadedProviderConfig = {
      sourceFilePaths: [],
      config,
    }
    // The primary is `local/agent-routed` (e.g. resolved by
    // resolveConfiguredAgentModelConfig from an agentId), NOT the
    // defaultModel `local/default-model`. The failoverModels list repeats it
    // at index 0; the dedup must drop it, leaving only `local/backup-a`.
    expect(resolveModelsToTry('local/agent-routed', loadedConfig)).toEqual([
      'local/agent-routed',
      'local/backup-a',
    ])
  })

  test('resolveModelsToTry returns an empty list when primaryModel is undefined and failoverModels is unset', () => {
    // Edge case that motivated the `effectiveRequestedModel` resolution in
    // llm.ts: when `params.model` is undefined (e.g. bundled agents whose
    // model is deferred to openbuff.json routing) AND no agentId is available
    // to resolve a primary, resolveModelsToTry returns []. Without the
    // up-front resolution, the loop never executes and the post-loop
    // `throw lastError` surfaces as "Agent run error: undefined".
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/default-model',
      defaultReasoningEffort: 'low',
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['default-model'],
        },
      },
    })
    const loadedConfig: LoadedProviderConfig = {
      sourceFilePaths: [],
      config,
    }
    expect(resolveModelsToTry(undefined, loadedConfig)).toEqual([])
  })

  test('resolveModelsToTry dedupes ALL failover entries that repeat the primary when failoverModels contains the primary multiple times', () => {
    // Guards against a misconfigured list with duplicate primaries: if
    // failoverModels repeats the primary multiple times, every occurrence must
    // be dropped (not just the first). The dedup filter is `model !==
    // primaryModel` applied to every entry, so duplicates are all filtered out —
    // the loop should never wastefully retry the same model that just failed.
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/primary',
      defaultReasoningEffort: 'low',
      failoverModels: [
        'local/primary',
        'local/primary',
        'local/backup-a',
        'local/primary',
        'local/backup-b',
      ],
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['primary', 'backup-a', 'backup-b'],
        },
      },
    })
    const loadedConfig: LoadedProviderConfig = {
      sourceFilePaths: [],
      config,
    }
    expect(resolveModelsToTry('local/primary', loadedConfig)).toEqual([
      'local/primary',
      'local/backup-a',
      'local/backup-b',
    ])
  })

  test('resolveModelsToTry dedupes duplicate entries within failoverModels itself (misconfigured list with duplicate backups)', () => {
    // Guards against a misconfigured list with duplicate backups: if
    // failoverModels repeats a backup model multiple times, every duplicate
    // after the first must be dropped (preserving first-seen order). Without
    // this dedup the loop would wastefully retry the same backup model twice
    // — burning a second provider request against a model that already failed
    // identically. The primary is distinct from the backups here to isolate
    // the within-list dedup from the primary-dedup path.
    const config = providerConfigFileSchema.parse({
      defaultModel: 'local/primary',
      defaultReasoningEffort: 'low',
      failoverModels: ['local/backup-a', 'local/backup-a', 'local/backup-b'],
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: ['primary', 'backup-a', 'backup-b'],
        },
      },
    })
    const loadedConfig: LoadedProviderConfig = {
      sourceFilePaths: [],
      config,
    }
    expect(resolveModelsToTry('local/primary', loadedConfig)).toEqual([
      'local/primary',
      'local/backup-a',
      'local/backup-b',
    ])
  })
})

/**
 * Block 2 — `promptAiSdkStream` loop-level integration.
 *
 * Implemented loop-level test: drive the real `promptAiSdkStream` export with
 * `getModelForRequest` spied via the namespace object (Bun intercepts the
 * named-import call site in llm.ts), asserting (a) preferModelParam=false
 * (primary) then true (backup) at the M8.1 seam, (b) failover on a primary
 * 401 (failover-eligible, NOT retryable — see isRetryableStatusCode), and
 * (c) the backup's text content yielded plus a successful PromptResult.
 *
 * The previously-concerned seam fragility was resolved without changing any
 * behavior: the fake LanguageModel builds its parts from the ai package's own
 * streamText semantics, and the spy is verified by the assertion that the
 * FIRST call carries preferModelParam=false — the loop cannot reach the
 * backup path without the spy intercepting.
 *
 * Historical blockers addressed:
 *
 * 1. Spy interception is verified observationally: the FIRST spied call must
 *    carry preferModelParam=false — the loop cannot reach the backup path
 *    without the spy intercepting the llm.ts call site.
 *
 * 2. The fake LanguageModel models run through the ai package's own
 *    streamText semantics: the error model rejects with a real APICallError
 *    carrying statusCode 401 (failover-eligible, not retryable), and the
 *    backup model yields a text-delta/finish stream pair.
 *
 * 3. The promptAiSdkStream param surface is filled out minimally but
 *    completely (apiKey, runId, messages, session ids, sendAction, logger,
 *    trackEvent, signal), matching the published PromptAiSdkStreamFn input.
 */

const testLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Backup-side stub: doStream returns a LanguageModelV2 stream (AI SDK 5
 * rejects specificationVersion 'v1' models outright via
 * AI_UnsupportedModelVersionError, so the fake must implement v2).
 */
function makeStreamModel(text: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test-provider',
    modelId: 'test-model',
    doStream: async () => {
      const parts = [
        { type: 'stream-start' },
        { type: 'text-start', id: 'txt-1' },
        { type: 'text-delta', id: 'txt-1', delta: text },
        { type: 'text-end', id: 'txt-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ] as LanguageModelV2StreamPart[]
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      })
      return { stream, rawCall: { rawPrompt: null, rawSettings: {} } }
    },
  } as unknown as LanguageModel
}

/**
 * Primary-side stub: doStream returns a stream that sends stream-start and
 * then an in-stream error part carrying a real NoOutputGeneratedError, then
 * closes cleanly. The fake surfaces the error through the stream itself —
 * llm.ts's error-chunk handler re-throws `chunkValue.error`, which lands in
 * the same catch block as the production path, where the AI SDK rejects
 * `response.finishReason` with this exact error after a clean-closed
 * content-free stream (e.g. the merged default request timeout aborting a
 * hung provider stream before any content chunk). Note: this fixture does
 * NOT reproduce the finishReason-rejection path itself; the AI SDK's
 * step-transform flush would otherwise resolve a stream-start-only stream
 * as a successful empty step (recordedSteps=1, finishReason 'unknown').
 */
function makeEmptyStreamModel(): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test-provider',
    modelId: 'test-model',
    doStream: async () => {
      const parts = [
        { type: 'stream-start' },
        {
          type: 'error',
          error: new NoOutputGeneratedError({
            message: 'No output generated. Check the stream for errors.',
          }),
        },
      ] as LanguageModelV2StreamPart[]
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      })
      return { stream, rawCall: { rawPrompt: null, rawSettings: {} } }
    },
  } as unknown as LanguageModel
}

/** Primary-side stub: doStream rejects with a failover-eligible
 *  (non-retryable) 401 APICallError. */
function makeAuthErrorModel(): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test-provider',
    modelId: 'test-model',
    doStream: async () => {
      throw new APICallError({
        message: 'Invalid API key provided',
        url: 'http://127.0.0.1:11434/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      })
    },
  } as unknown as LanguageModel
}
describe('promptAiSdkStream failover loop (integration)', () => {
  let tempDir: string | undefined
  let spiedGetModelForRequest: ReturnType<typeof spyOn> | undefined
  let spiedWaitForBackoffDelay: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    resetEnv()
    delete process.env[PROVIDER_CONFIG_ENV_VAR]
  })

  afterEach(() => {
    spiedGetModelForRequest?.mockRestore()
    spiedGetModelForRequest = undefined
    spiedWaitForBackoffDelay?.mockRestore()
    spiedWaitForBackoffDelay = undefined
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    resetEnv()
  })

  test('advances to backup on primary 401, records preferModelParam [false, true], yields backup content', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-failover-'))
    const configPath = path.join(tempDir, 'openbuff.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultModel: 'local/primary',
        defaultReasoningEffort: 'low',
        failoverModels: ['local/backup-a'],
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

    // Spy the getModelForRequest export whose named import llm.ts binds at
    // module load. Call 1 (primary attempt): a failover-eligible 401 error
    // model. Call 2 (backup attempt): the success stream model.
    const preferModelParamCalls: boolean[] = []
    spiedGetModelForRequest = spyOn(
      modelProvider,
      'getModelForRequest',
    ).mockImplementation(async (params) => {
      preferModelParamCalls.push(params.preferModelParam === true)
      const base = {
        isChatGptOAuth: false,
        compatibility: {
          supportsTools: true,
          stripProviderMetadata: false,
          stripCacheControl: false,
          stringifyTextContent: false,
          supportsRequiredToolChoice: true,
          supportsStopSequences: true,
        },
      }
      if (params.preferModelParam) {
        return {
          ...base,
          model: makeStreamModel('backup-content'),
          effectiveModel: 'local/backup-a',
        }
      }
      return {
        ...base,
        model: makeAuthErrorModel(),
        effectiveModel: 'local/primary',
      }
    })

    const promptParams = {
      apiKey: 'test-key',
      runId: 'run-1',
      // AI SDK 5 rejects an empty prompt (AI_InvalidPromptError), so the
      // failover loop test needs at least one user message. CodebuffMessage
      // content is an array of typed blocks (string content would crash
      // getMessagesForModelContext's content.some at llm.ts:808).
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'failover probe' }] },
      ] as never[],
      clientSessionId: 'client-1',
      fingerprintId: 'finger-1',
      userInputId: 'input-1',
      userId: undefined,
      model: 'local/primary' as const,
      agentId: undefined,
      sendAction: async () => {},
      logger: testLogger,
      trackEvent: async () => {},
      signal: new AbortController().signal,
    }

    // Drive the async generator manually so BOTH the yielded text chunks and
    // the generator's return value (a PromptResult) are observable.
    const textChunks: string[] = []
    const iterator = promptAiSdkStream(promptParams as never)[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done) {
      const chunk = next.value as { type: string; text?: string }
      if (chunk.type === 'text' && typeof chunk.text === 'string') {
        textChunks.push(chunk.text)
      }
      next = await iterator.next()
    }
    const result = next.value as { aborted: boolean; value?: string | null }

    // M8.1 failover seam: exactly two model resolutions, the primary without
    // preferModelParam bypass and the backup with it set.
    expect(preferModelParamCalls).toEqual([false, true])
    // The backup's text was streamed through to the caller.
    expect(textChunks.join('')).toContain('backup-content')
    // The generator returns a successful PromptResult (promptSuccess shape).
    expect(result.aborted).toBe(false)
  })

  test('retries and failovers over an empty stream (NoOutputGeneratedError), then yields backup content', async () => {
    // Regression for the empty-stream kill: in production the AI SDK rejects
    // `response.finishReason` with NoOutputGeneratedError ("No output
    // generated. Check the stream for errors.") when the provider opens a
    // stream, sends zero content chunks, and closes cleanly — e.g. the merged
    // default request timeout aborting a hung provider stream before any
    // content chunk. That error has no HTTP status and is not a network
    // error, so before the fix the first attempt threw immediately: no
    // backoff waits, no failover, and spawned editor children died with
    // 'Agent run error: No output generated.'
    //
    // The fake model below surfaces NoOutputGeneratedError as an in-stream
    // error part instead; llm.ts's error-chunk handler re-throws it into the
    // same catch block as the production path (it does not reproduce the
    // finishReason rejection itself). With the fix, the empty-stream error is
    // retried like a transient error (MAX_RETRIES_PER_MESSAGE backoff waits)
    // before the outer loop failovers to the backup model.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-failover-'))
    const configPath = path.join(tempDir, 'openbuff.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultModel: 'local/primary',
        defaultReasoningEffort: 'low',
        failoverModels: ['local/backup-a'],
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

    // Intercept the backoff wait so the retry path is observable (call
    // count) without real sleeps, mirroring the getModelForRequest spy.
    const backoffDelayCalls: number[] = []
    spiedWaitForBackoffDelay = spyOn(
      retryConfig,
      'waitForBackoffDelay',
    ).mockImplementation(async (params) => {
      backoffDelayCalls.push(params.delayMs)
    })

    const preferModelParamCalls: boolean[] = []
    spiedGetModelForRequest = spyOn(
      modelProvider,
      'getModelForRequest',
    ).mockImplementation(async (params) => {
      preferModelParamCalls.push(params.preferModelParam === true)
      const base = {
        isChatGptOAuth: false,
        compatibility: {
          supportsTools: true,
          stripProviderMetadata: false,
          stripCacheControl: false,
          stringifyTextContent: false,
          supportsRequiredToolChoice: true,
          supportsStopSequences: true,
        },
      }
      if (params.preferModelParam) {
        return {
          ...base,
          model: makeStreamModel('backup-content'),
          effectiveModel: 'local/backup-a',
        }
      }
      return {
        ...base,
        model: makeEmptyStreamModel(),
        effectiveModel: 'local/primary',
      }
    })

    const promptParams = {
      apiKey: 'test-key',
      runId: 'run-1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'empty stream probe' }] },
      ] as never[],
      clientSessionId: 'client-1',
      fingerprintId: 'finger-1',
      userInputId: 'input-1',
      userId: undefined,
      model: 'local/primary' as const,
      agentId: undefined,
      sendAction: async () => {},
      logger: testLogger,
      trackEvent: async () => {},
      signal: new AbortController().signal,
    }

    const textChunks: string[] = []
    const iterator = promptAiSdkStream(promptParams as never)[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done) {
      const chunk = next.value as { type: string; text?: string }
      if (chunk.type === 'text' && typeof chunk.text === 'string') {
        textChunks.push(chunk.text)
      }
      next = await iterator.next()
    }
    const result = next.value as { aborted: boolean; value?: string | null }

    // The primary was attempted 4 times (initial + 3 retries), then the
    // backup attempt carries preferModelParam=true (M8.1 failover seam).
    expect(preferModelParamCalls).toEqual([false, false, false, false, true])
    // The empty-stream error took the retry path: one backoff wait per retry
    // (3 retries) instead of an immediate throw.
    expect(backoffDelayCalls.length).toBe(3)
    // The backup's text was streamed through to the caller.
    expect(textChunks.join('')).toContain('backup-content')
    expect(result.aborted).toBe(false)
  })
})
