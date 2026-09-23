import { openrouterModels } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  ABORT_ERROR_MESSAGE,
  promptAborted,
  promptSuccess,
} from '@codebuff/common/util/error'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  buildFallbackChain,
  promptFlashWithFallbacks,
} from '../gemini-with-fallbacks'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'

describe('promptFlashWithFallbacks', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  const baseParams = {
    model: openrouterModels.openrouter_gemini2_5_flash,
    runId: 'test-run-id',
    clientSessionId: 'test-client-session',
    fingerprintId: 'test-fingerprint',
    userInputId: 'test-user-input',
    userId: 'test-user-id',
    // Injectable no-op sleep: retry backoff must never really sleep in tests.
    sleep: async () => {},
  }

  /** HTTP-classified error the gating reads `statusCode` from. */
  const statusError = (message: string, statusCode: number): Error => {
    const error = new Error(message) as Error & { statusCode: number }
    error.statusCode = statusCode
    return error
  }

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL }
  })

  afterEach(() => {
    mock.restore()
  })

  describe('abort handling', () => {
    it('should throw immediately when finetuned model returns aborted', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.resolve(promptAborted('User cancelled')),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Should only be called once (no fallback attempts)
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should throw immediately when main Gemini call returns aborted', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.resolve(promptAborted()),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Should only be called once (no fallback to Claude/GPT-4o)
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should throw immediately when fallback call returns aborted', async () => {
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(() => {
        callCount++
        if (callCount <= 2) {
          // Primary Gemini leg: both attempts fail with a retryable 5xx
          return Promise.reject(statusError('Gemini API error', 503))
        }
        // Fallback leg attempt returns aborted
        return Promise.resolve(promptAborted('User cancelled during fallback'))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Primary leg exhausted (2 attempts) + fallback attempt
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(3)
    })

    it('should not fall back when finetuned model is aborted even if other models available', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.resolve(promptAborted()),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          useGPT4oInsteadOfClaude: true,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Should only be called once - no fallback to Gemini or GPT-4o
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('does not escalate to the fallback chain when the signal aborts during the final failed finetuned attempt', async () => {
      const controller = new AbortController()
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock((promptParams: { model?: string }) => {
        callCount++
        if (promptParams.model === 'gemini-2.0-flash-exp') {
          if (callCount === 2) {
            // The abort lands during the final failed finetuned attempt.
            controller.abort()
          }
          return Promise.reject(statusError('finetuned unavailable', 503))
        }
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          // Non-abort-aware injected sleep: the loop-level gate, not the
          // sleep, must stop the retry/escalation after an observed abort.
          sleep: async () => {},
          signal: controller.signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Both finetuned attempts ran, but no Gemini/Claude fallback dispatch:
      // no further attempt is dispatched after an observed abort.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(2)
    })

    it('does not dispatch the retry after an abort observed during a non-abort-aware backoff sleep on the finetuned leg', async () => {
      const controller = new AbortController()
      const sleep = mock(async () => {
        // The abort lands during the backoff sleep; this injected sleep is
        // not abort-aware and resolves anyway.
        controller.abort()
      })
      agentRuntimeImpl.promptAiSdk = mock((promptParams: { model?: string }) => {
        if (promptParams.model === 'gemini-2.0-flash-exp') {
          return Promise.reject(statusError('finetuned unavailable', 503))
        }
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          sleep,
          signal: controller.signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Only the first finetuned attempt: the retry (and any fallback-chain
      // escalation) must never be dispatched after the abort was observed.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('does not dispatch the retry after an abort observed during a non-abort-aware backoff sleep on a fallback-chain leg', async () => {
      const controller = new AbortController()
      const sleep = mock(async () => {
        // The abort lands during the primary leg's backoff sleep; this
        // injected sleep is not abort-aware and resolves anyway.
        controller.abort()
      })
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.reject(statusError('Gemini API error', 503)),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          vertexModel: 'vertex/gemini-2.5-flash',
          sleep,
          signal: controller.signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Only the first primary-leg attempt: the post-backoff retry (and any
      // Vertex/Claude fallback escalation) must never be dispatched after
      // the abort was observed during the injected sleep.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should not fall back when native AbortError is thrown', async () => {
      // Simulate native AbortError thrown by fetch/AI SDK when AbortSignal is triggered
      const nativeAbortError = new DOMException(
        'signal is aborted without reason',
        'AbortError',
      )
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.reject(nativeAbortError),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow()

      // Should only be called once - native AbortError should not trigger fallback
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should not fall back when Error with name AbortError is thrown', async () => {
      // Some libraries throw Error with name set to AbortError
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      agentRuntimeImpl.promptAiSdk = mock(() => Promise.reject(abortError))

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow()

      // Should only be called once - AbortError by name should not trigger fallback
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should fall back from finetuned model to Gemini on non-abort error', async () => {
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(() => {
        callCount++
        if (callCount === 1) {
          // First call (finetuned) fails with non-abort error
          return Promise.reject(new Error('Finetuned model error'))
        }
        // Second call (Gemini) succeeds
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        useFinetunedModel: 'gemini-2.0-flash-exp' as any,
        signal: new AbortController().signal,
      })

      expect(result).toBe('Gemini response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(2)
    })

    it('should fall back from Gemini to Claude after the primary leg exhausts its retries', async () => {
      const calledModels: Array<string | undefined> = []
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(
        (promptParams: { model?: string }) => {
          callCount++
          calledModels.push(promptParams.model)
          if (callCount <= 2) {
            // Primary Gemini leg: both attempts fail with a retryable 5xx
            return Promise.reject(statusError('Gemini error', 503))
          }
          // Claude fallback leg succeeds
          return Promise.resolve(promptSuccess('Claude response'))
        },
      )

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        signal: new AbortController().signal,
      })

      expect(result).toBe('Claude response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(3)
      expect(calledModels.slice(0, 2)).toEqual([
        openrouterModels.openrouter_gemini2_5_flash,
        openrouterModels.openrouter_gemini2_5_flash,
      ])
      expect(calledModels[2]).toBe(
        openrouterModels.openrouter_claude_3_5_haiku,
      )
    })

    it('should fall back from Gemini to GPT-4o when useGPT4oInsteadOfClaude is true', async () => {
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(() => {
        callCount++
        if (callCount <= 2) {
          // Primary Gemini leg: both attempts fail with a retryable 5xx
          return Promise.reject(statusError('Gemini error', 503))
        }
        return Promise.resolve(promptSuccess('GPT-4o response'))
      })

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        useGPT4oInsteadOfClaude: true,
        signal: new AbortController().signal,
      })

      expect(result).toBe('GPT-4o response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(3)
    })
  })

  describe('successful responses', () => {
    it('should return response from finetuned model when successful', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.resolve(promptSuccess('Finetuned model response')),
      )

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        useFinetunedModel: 'gemini-2.0-flash-exp' as any,
        signal: new AbortController().signal,
      })

      expect(result).toBe('Finetuned model response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('should return response from main Gemini when successful', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.resolve(promptSuccess('Gemini response')),
      )

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        signal: new AbortController().signal,
      })

      expect(result).toBe('Gemini response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })
  })

  describe('error-class gating (M3-T4)', () => {
    it('fails fast on content-policy errors: no retry, no escalation', async () => {
      const policyError = statusError('blocked by policy', 400)
      ;(policyError as unknown as { code: string }).code =
        'provider_content_policy'
      agentRuntimeImpl.promptAiSdk = mock(() => Promise.reject(policyError))

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('blocked by policy')

      // Exactly one attempt: no same-leg retry and no fallback escalation.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('fails fast on 4xx client errors: no retry, no escalation', async () => {
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.reject(statusError('bad request', 400)),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('bad request')

      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('fails fast on finetuned-leg content-policy errors: no fallback escalation', async () => {
      const policyError = statusError('blocked by policy', 400)
      ;(policyError as unknown as { code: string }).code =
        'provider_content_policy'
      agentRuntimeImpl.promptAiSdk = mock((promptParams: { model?: string }) => {
        if (promptParams.model === 'gemini-2.0-flash-exp') {
          return Promise.reject(policyError)
        }
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('blocked by policy')

      // Exactly one attempt: the finetuned refusal is not escalated to the
      // Gemini/Claude fallback chain (M3-T4 fail-fast contract).
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('fails fast on finetuned-leg 4xx client errors: no fallback escalation', async () => {
      agentRuntimeImpl.promptAiSdk = mock((promptParams: { model?: string }) => {
        if (promptParams.model === 'gemini-2.0-flash-exp') {
          return Promise.reject(statusError('finetuned bad request', 400))
        }
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          useFinetunedModel: 'gemini-2.0-flash-exp' as any,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('finetuned bad request')

      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('still escalates retryable finetuned-leg errors to the fallback chain', async () => {
      agentRuntimeImpl.promptAiSdk = mock((promptParams: { model?: string }) => {
        if (promptParams.model === 'gemini-2.0-flash-exp') {
          return Promise.reject(statusError('finetuned unavailable', 503))
        }
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        useFinetunedModel: 'gemini-2.0-flash-exp' as any,
        signal: new AbortController().signal,
      })

      expect(result).toBe('Gemini response')
      // Retry budget (reliability finding finetuned-leg-no-retry-budget): the
      // finetuned leg gets MAX_ATTEMPTS_PER_LEG (2) attempts before
      // escalating, then the primary Gemini leg succeeds on its first attempt.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(3)
    })

    it('honors a valid Retry-After header for the retry delay (invalid headers fail closed to backoff)', async () => {
      const sleep = mock(async (_ms: number) => {})
      agentRuntimeImpl.promptAiSdk = mock(() => {
        const error = statusError('rate limited', 429)
        ;(error as unknown as { responseHeaders: Record<string, string> }).responseHeaders =
          { 'retry-after': '2' }
        return Promise.reject(error)
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          sleep,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('rate limited')

      // Both fallback legs exhaust MAX_ATTEMPTS_PER_LEG (2) attempts each;
      // each leg sleeps once, honoring the Retry-After hint (2s in ms).
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(4)
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(sleep.mock.calls[0]?.[0]).toBe(2000)
      expect(sleep.mock.calls[1]?.[0]).toBe(2000)
    })
  })

  describe('Vertex leg + costMode routing (M3-T4)', () => {
    it('builds the documented chain: primary, vertex, costMode-routed Claude', () => {
      expect(
        buildFallbackChain({
          model: 'gemini-2.5-flash',
          costMode: 'max',
          vertexModel: 'vertex/gemini-2.5-flash',
        }),
      ).toEqual([
        { kind: 'primary', model: 'gemini-2.5-flash' },
        { kind: 'vertex', model: 'vertex/gemini-2.5-flash' },
        {
          kind: 'fallback',
          model: openrouterModels.openrouter_claude_sonnet_4_5,
        },
      ])

      // Without 'max' costMode the final leg is the Haiku model; without a
      // vertexModel the Vertex leg is omitted.
      const plain = buildFallbackChain({ model: 'gemini-2.5-flash' })
      expect(plain.map((leg) => leg.kind)).toEqual(['primary', 'fallback'])
      expect(plain[1].model).toBe(
        openrouterModels.openrouter_claude_3_5_haiku,
      )
    })

    it('routes through the Vertex leg when the primary Gemini leg fails', async () => {
      const calledModels: string[] = []
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(
        (promptParams: { model?: string }) => {
          callCount++
          calledModels.push(promptParams.model ?? '')
          if (callCount <= 2) {
            return Promise.reject(statusError('Gemini API error', 503))
          }
          return Promise.resolve(promptSuccess('Vertex response'))
        },
      )

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        vertexModel: 'vertex/gemini-2.5-flash',
        signal: new AbortController().signal,
      })

      expect(result).toBe('Vertex response')
      expect(calledModels).toEqual([
        openrouterModels.openrouter_gemini2_5_flash,
        openrouterModels.openrouter_gemini2_5_flash,
        'vertex/gemini-2.5-flash',
      ])
    })
  })

  describe('abort-aware retry backoff', () => {
    it('propagates an abort that is already set before the first dispatch (default sleep)', async () => {
      const controller = new AbortController()
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.reject(statusError('Gemini API error', 503)),
      )

      controller.abort()

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          // No injected sleep: the default sleep itself must observe
          // params.signal and reject instead of waiting out the backoff.
          signal: controller.signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // Loop-level abort gates (reliability finding
      // gemini-chain-legs-missing-post-backoff-abort-gate): an abort observed
      // before the first attempt means NO provider request is dispatched at
      // all — the loop-top gate fires before any dispatch.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(0)
    })

    it('propagates an abort that lands during the post-failure backoff (default sleep)', async () => {
      const controller = new AbortController()
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(() => {
        callCount++
        // Abort after the first failed attempt is observed: the abort lands
        // during the backoff wait that follows it.
        if (callCount === 1) {
          queueMicrotask(() => controller.abort())
        }
        return Promise.reject(statusError('Gemini API error', 503))
      })

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          // No injected sleep: the default sleep must observe params.signal
          // and reject instead of waiting out the backoff.
          signal: controller.signal,
        }),
      ).rejects.toThrow(ABORT_ERROR_MESSAGE)

      // The abort surfaced from the backoff sleep itself: no retry attempt
      // was dispatched after the first failure.
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(1)
    })

    it('threads the caller signal into the injected sleep for abort-aware backoff', async () => {
      const controller = new AbortController()
      const sleep = mock(
        async (_ms: number, _signal?: AbortSignal) => {},
      )
      agentRuntimeImpl.promptAiSdk = mock(() =>
        Promise.reject(statusError('Gemini API error', 503)),
      )

      await expect(
        promptFlashWithFallbacks({
          ...agentRuntimeImpl,
          ...baseParams,
          messages: [],
          sleep,
          signal: controller.signal,
        }),
      ).rejects.toThrow('Gemini API error')

      // One sleep per retry leg (MAX_ATTEMPTS_PER_LEG - 1 per leg, two legs),
      // and each receives the caller's signal so it can honor aborts.
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(sleep.mock.calls[0]?.[1]).toBe(controller.signal)
      expect(sleep.mock.calls[1]?.[1]).toBe(controller.signal)
    })

    it('returns a success obtained inside the loop instead of throwing lastError', async () => {
      let callCount = 0
      agentRuntimeImpl.promptAiSdk = mock(() => {
        callCount++
        if (callCount === 1) {
          // First attempt of the primary leg fails with a retryable 5xx.
          return Promise.reject(statusError('Gemini error', 503))
        }
        // The retry succeeds: the recorded success must be returned, never
        // replaced by the earlier recorded error.
        return Promise.resolve(promptSuccess('Gemini response'))
      })

      const result = await promptFlashWithFallbacks({
        ...agentRuntimeImpl,
        ...baseParams,
        messages: [],
        signal: new AbortController().signal,
      })

      expect(result).toBe('Gemini response')
      expect(agentRuntimeImpl.promptAiSdk).toHaveBeenCalledTimes(2)
    })
  })
})
