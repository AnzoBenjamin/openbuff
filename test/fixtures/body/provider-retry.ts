/** Offline configured-adapter controls. Launch with a scrubbed env and --no-env-file. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const output = path.resolve(process.argv[2]!)
fs.mkdirSync(output, { recursive: true })
const configFile = path.join(output, 'provider.json')
process.env.OPENBUFF_PROVIDER_CONFIG = configFile
const requests: Array<{
  case: string
  url: string
  body: unknown
  response?: unknown
  error?: unknown
}> = []
const observations: unknown[] = []
let caseName = 'preimport'
let respond:
  | ((url: string, init?: RequestInit) => Promise<Response>)
  | undefined
let refusedFetches = 0
// Installed before imports: an unarmed or unexpected request never reaches a network.
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (
      !respond ||
      !/^https:\/\/(primary|backup|reasoning)\.b08\.invalid\/v1\/chat\/completions$/.test(
        url,
      )
    ) {
      refusedFetches++
      throw new Error('B08 fixture refused unexpected fetch')
    }
    const row: (typeof requests)[number] = {
      case: caseName,
      url,
      body: JSON.parse(String(init?.body)),
    }
    requests.push(row)
    try {
      const response = await respond(url, init)
      row.response = {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.clone().text(),
      }
      return response
    } catch (error) {
      row.error = terminal(error)
      throw error
    }
  },
  globalThis.fetch,
)

const llm = await import('../../../sdk/src/impl/llm')
const routing = await import('../../../sdk/src/impl/model-provider')
const config = await import('../../../sdk/src/provider-config')
const retry = await import('../../../sdk/src/retry-config')
const errors = await import('../../../sdk/src/error-utils')
const { jsonSchema } = await import('ai')
const { z } = await import('zod/v4')
const { parseTextWithToolCalls } =
  await import('../../../packages/agent-runtime/src/util/parse-tool-calls-from-text')

export const policy = {
  maxRetries: 2,
  backupMaxRetries: 0,
  maxTotalAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 200,
  retryAfterMaxDelayMs: 250,
  maxTotalDelayMs: 600,
  jitterFraction: 0,
}
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const provider = (host: string, extra: unknown = {}) => ({
  type: 'openai-compatible',
  baseURL: `https://${host}.b08.invalid/v1`,
  models: ['model'],
  defaultCapabilities: { context: { windowTokens: 32000 } },
  ...(extra as object),
})
function configure(
  value: unknown = {
    defaultModel: 'primary/model',
    failoverModels: ['backup/model'],
    providers: { primary: provider('primary'), backup: provider('backup') },
  },
) {
  fs.writeFileSync(configFile, JSON.stringify(value))
  config.clearProviderConfigCacheForTest()
}
function sse(events: unknown[], headers: Record<string, string> = {}) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream', ...headers },
    },
  )
}
const healthy = () =>
  sse([{ choices: [{ delta: { content: 'healthy' }, finish_reason: 'stop' }] }])
const unavailable = () => ({
  error: {
    message: 'Upstream unavailable',
    status: 503,
    code: 'upstream_error',
  },
})
const httpError = (
  headers: Record<string, string> = {},
  code = 'upstream_error',
) =>
  new Response(
    JSON.stringify({
      error: {
        message:
          code === 'content_filter'
            ? 'content policy blocked'
            : 'Upstream unavailable',
        code,
      },
    }),
    {
      status: 503,
      headers: { 'content-type': 'application/json', ...headers },
    },
  )
let waits: number[] = []
let statuses: unknown[] = []
const params = (extra: object = {}) => ({
  apiKey: 'synthetic',
  runId: 'b08',
  clientSessionId: 'b08',
  fingerprintId: 'b08',
  userInputId: 'b08',
  userId: undefined,
  agentId: 'fixture',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
  signal: new AbortController().signal,
  maxRetries: 99,
  retryPolicy: policy,
  retrySleep: async (ms: number) => {
    waits.push(ms)
  },
  logger,
  trackEvent() {},
  onError() {},
  sendAction(action: unknown) {
    statuses.push(action)
  },
  ...extra,
})
async function stream(extra: object = {}) {
  const chunks = []
  const generator = llm.promptAiSdkStream(params(extra) as never)
  for (;;) {
    const next = await generator.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}
function terminal(error: unknown) {
  const chain = [...errors.providerErrorChain(error)]
  return {
    name: (error as Error)?.name,
    message: (error as Error)?.message,
    statusCode: errors.getErrorStatusCode(error),
    code: (error as { code?: unknown })?.code,
    chain: chain.map((value) => ({
      name: value.name,
      code: value.code,
      statusCode: value.statusCode,
      responseHeaders: value.responseHeaders,
    })),
  }
}
async function control(name: string, run: () => Promise<unknown>) {
  caseName = name
  configure()
  waits = []
  statuses = []
  const first = requests.length
  const started = performance.now()
  try {
    const detail = await run()
    observations.push({
      case: name,
      passed: true,
      elapsedMs: performance.now() - started,
      requests: requests.slice(first),
      waits,
      statuses,
      detail,
    })
  } catch (error) {
    observations.push({
      case: name,
      passed: false,
      elapsedMs: performance.now() - started,
      requests: requests.slice(first),
      waits,
      statuses,
      error: terminal(error),
    })
    throw error
  } finally {
    respond = undefined
  }
}
async function failure(extra: object = {}) {
  try {
    await stream(extra)
  } catch (error) {
    return error
  }
  throw new Error('Expected terminal failure')
}
const controls: Array<[string, () => Promise<unknown>]> = []
for (const protocol of ['http', 'sse']) {
  for (const hint of [
    undefined,
    '9',
    '0',
    '-5',
    '3.5',
    'hostile',
    '9'.repeat(320),
    new Date(Date.now() + 3600000).toUTCString(),
  ]) {
    controls.push([
      `${protocol}-503-hint-${hint === undefined ? 'missing' : hint.length > 40 ? 'nonfinite' : hint.includes('GMT') ? 'http-date' : hint}`,
      async () => {
        const headers = hint === undefined ? {} : { 'retry-after': hint }
        respond = async (url) =>
          url.includes('primary')
            ? protocol === 'http'
              ? httpError(headers)
              : sse([unavailable()], headers)
            : healthy()
        const result = await stream()
        const ledger = requests
          .filter((row) => row.case === caseName)
          .map((row) => (row.url.includes('primary') ? 'primary' : 'backup'))
        assert.deepEqual(ledger, ['primary', 'primary', 'primary', 'backup'])
        assert.deepEqual(
          waits,
          hint === '9' || hint?.includes('GMT')
            ? [250, 250]
            : hint === '0'
              ? [0, 0]
              : [100, 200],
        )
        assert(result.chunks.some((chunk) => chunk.type === 'text'))
        return result
      },
    ])
  }
}
controls.push([
  'wrapped-policy-and-abort-override-status',
  async () => {
    const policyError = errors.createProviderContentPolicyError({
      statusCode: 503,
    })
    const wrapped = Object.assign(new Error('Wrapper'), {
      lastError: policyError,
    })
    assert.equal(errors.getErrorStatusCode(wrapped), 503)
    assert.equal(retry.classifyRetryableError(wrapped).retryable, false)
    const aborted = Object.assign(new Error('Aborted'), {
      name: 'AbortError',
      cause: { statusCode: 503 },
    })
    assert.equal(retry.classifyRetryableError(aborted).retryable, false)
    assert.equal(
      retry.classifyRetryableError(
        {
          lastError: {
            statusCode: 503,
            responseHeaders: { 'retry-after': '9' },
          },
        },
        policy,
      ).delayMs,
      250,
    )
    const now = 1700000000000
    assert.equal(
      retry.parseRetryAfterMs({
        header: new Date(now + 5000).toUTCString(),
        now,
        maxDelayMs: 250,
      }),
      250,
    )
    return { policy: terminal(wrapped), abort: terminal(aborted) }
  },
])
for (const protocol of ['http', 'sse'])
  controls.push([
    `${protocol}-policy-503-no-retry`,
    async () => {
      respond = async () =>
        protocol === 'http'
          ? httpError({}, 'content_filter')
          : sse([
              {
                error: {
                  message: 'content policy blocked',
                  code: 'content_filter',
                  status: 503,
                },
              },
            ])
      const error = await failure()
      assert.equal(errors.getErrorStatusCode(error), 503)
      assert.equal(
        errors.normalizeProviderContentPolicyError(error)?.code,
        'provider_content_policy',
      )
      assert.equal(requests.filter((row) => row.case === caseName).length, 1)
      assert.deepEqual(waits, [])
      return terminal(error)
    },
  ])
controls.push([
  'total-wait-exhaustion-no-backup',
  async () => {
    respond = async () => httpError({ 'retry-after': '9' })
    const error = await failure({
      retryPolicy: { ...policy, maxTotalDelayMs: 249 },
    })
    assert.equal(errors.getErrorStatusCode(error), 503)
    assert.equal(requests.filter((row) => row.case === caseName).length, 1)
    assert.deepEqual(waits, [])
    return terminal(error)
  },
])
controls.push([
  'abort-before-dispatch',
  async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    respond = async () => {
      throw new Error('Aborted dispatch admitted')
    }
    const result = await stream({ signal: controller.signal })
    assert.equal(requests.filter((row) => row.case === caseName).length, 0)
    return result
  },
])
for (const phase of ['active', 'backoff', 'real-timer'])
  controls.push([
    `abort-${phase}`,
    async () => {
      const controller = new AbortController()
      const reason = new DOMException('Cancelled', 'AbortError')
      respond = async (_url, init) => {
        if (phase === 'active') {
          controller.abort(reason)
          assert(init?.signal?.aborted)
          throw reason
        }
        return httpError()
      }
      const started = performance.now()
      const timer =
        phase === 'real-timer'
          ? setTimeout(() => controller.abort(reason), 20)
          : undefined
      const extra =
        phase === 'backoff'
          ? {
              retrySleep: async (ms: number) => {
                waits.push(ms)
                controller.abort(reason)
              },
            }
          : phase === 'real-timer'
            ? { retrySleep: undefined }
            : {}
      try {
        const error = await failure({ ...extra, signal: controller.signal })
        assert.equal(error, reason)
        assert.equal(requests.filter((row) => row.case === caseName).length, 1)
        assert(performance.now() - started < 350)
        return terminal(error)
      } finally {
        clearTimeout(timer)
      }
    },
  ])
for (const delivery of ['text', 'reasoning', 'tool', 'text-tool'])
  controls.push([
    `delivered-${delivery}-no-replay`,
    async () => {
      const tool = {
        id: 'tool-delivered',
        type: 'function',
        function: { name: 'probe', arguments: '{"value":"delivered"}' },
      }
      if (delivery === 'text-tool')
        configure({
          defaultModel: 'primary/model',
          failoverModels: ['backup/model'],
          providers: {
            primary: provider('primary', {
              compatibility: { supportsTools: false },
            }),
            backup: provider('backup'),
          },
        })
      respond = async () =>
        delivery === 'tool'
          ? sse([
              {
                choices: [
                  {
                    delta: { tool_calls: [{ ...tool, index: 0 }] },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
              unavailable(),
            ])
          : sse([
              {
                choices: [
                  {
                    delta:
                      delivery === 'reasoning'
                        ? { reasoning_content: 'delivered' }
                        : {
                            content:
                              delivery === 'text-tool'
                                ? '<codebuff_tool_call>\n{"cb_tool_name":"probe","value":"delivered"}\n</codebuff_tool_call>'
                                : 'delivered',
                          },
                    finish_reason: null,
                  },
                ],
              },
              unavailable(),
            ])
      const chunks = []
      let error: unknown
      try {
        const generator = llm.promptAiSdkStream(
          params({
            tools: {
              probe: {
                inputSchema: jsonSchema({
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                }),
              },
            },
          }) as never,
        )
        for (;;) {
          const next = await generator.next()
          if (next.done) break
          chunks.push(next.value)
          if (delivery === 'tool' && next.value.type === 'tool-call') {
            await generator.throw(
              errors.createHttpError(
                'Consumer failed after delivered tool',
                503,
              ),
            )
          }
        }
      } catch (caught) {
        error = caught
      }
      assert(
        chunks.some(
          (chunk) =>
            chunk.type ===
            (delivery === 'tool'
              ? 'tool-call'
              : delivery === 'reasoning'
                ? 'reasoning'
                : 'text'),
        ),
      )
      if (delivery === 'text-tool') {
        const parsed = parseTextWithToolCalls(
          chunks
            .filter((chunk) => chunk.type === 'text')
            .map((chunk) => (chunk.type === 'text' ? chunk.text : ''))
            .join(''),
        )
        assert.deepEqual(parsed, [
          {
            type: 'tool_call',
            toolName: 'probe',
            input: { value: 'delivered' },
          },
        ])
      }
      assert.equal(requests.filter((row) => row.case === caseName).length, 1)
      assert.deepEqual(waits, [])
      return { chunks, error: terminal(error) }
    },
  ])
controls.push([
  'buffered-tool-discard-on-retry',
  async () => {
    let count = 0
    respond = async () =>
      ++count === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'stale',
                        type: 'function',
                        function: {
                          name: 'probe',
                          arguments: '{"value":"stale"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            unavailable(),
          ])
        : healthy()
    const result = await stream({
      tools: {
        probe: {
          inputSchema: jsonSchema({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          }),
        },
      },
    })
    assert.equal(count, 2)
    assert(!result.chunks.some((chunk) => chunk.type === 'tool-call'))
    return result
  },
])
controls.push([
  'dormant-key-healthy-primary',
  async () => {
    configure({
      defaultModel: 'primary/model',
      failoverModels: ['backup/model'],
      providers: {
        primary: provider('primary'),
        backup: provider('backup', { apiKeyEnv: 'B08_DORMANT_ABSENT' }),
      },
    })
    assert.equal(process.env.B08_DORMANT_ABSENT, undefined)
    assert.deepEqual(
      routing.resolveModelContextWindows({ agentId: 'fixture' }),
      { primary: 32000, failoverFloor: 32000 },
    )
    respond = async () => healthy()
    const result = await stream()
    assert.equal(requests.filter((row) => row.case === caseName).length, 1)
    return result
  },
])
controls.push([
  'vision-metadata-skips-dormant-key-validation',
  async () => {
    configure({
      defaultModel: 'primary/model',
      providers: {
        primary: provider('primary', {
          apiKeyEnv: 'B08_DORMANT_ABSENT',
          defaultCapabilities: { input: { image: false } },
        }),
        dormant: provider('backup', {
          apiKeyEnv: 'B08_DORMANT_ABSENT',
          defaultCapabilities: { input: { image: false } },
        }),
        vision: provider('reasoning', {
          defaultCapabilities: { input: { image: true } },
        }),
      },
    })
    const selected = await routing.getModelForRequest({
      apiKey: '',
      agentId: 'fixture',
      requiresVision: true,
    })
    assert.equal(selected.effectiveModel, 'vision/model')
    return {
      effectiveModel: selected.effectiveModel,
      noKey: process.env.B08_DORMANT_ABSENT === undefined,
    }
  },
])
controls.push([
  'vision-route-cannot-reselect-excluded-oauth',
  async () => {
    configure({
      defaultModel: 'primary/model',
      visionModel: 'codex/gpt-5.5',
      providers: {
        primary: provider('primary', {
          defaultCapabilities: { input: { image: false } },
        }),
        codex: {
          type: 'chatgpt-oauth',
          models: ['gpt-5.5'],
          defaultCapabilities: { input: { image: true } },
        },
      },
    })
    let error: unknown
    try {
      await routing.getModelForRequest({
        apiKey: '',
        agentId: 'fixture',
        requiresVision: true,
        skipChatGptOAuth: true,
      })
    } catch (caught) {
      error = caught
    }
    assert.match((error as Error).message, /excluded ChatGPT\/Codex OAuth/)
    assert.equal(requests.filter((row) => row.case === caseName).length, 0)
    return terminal(error)
  },
])
controls.push([
  'selected-backup-key-error-retains-primary',
  async () => {
    configure({
      defaultModel: 'primary/model',
      failoverModels: ['backup/model'],
      providers: {
        primary: provider('primary'),
        backup: provider('backup', { apiKeyEnv: 'B08_DORMANT_ABSENT' }),
      },
    })
    respond = async () => httpError()
    const error = await failure()
    assert.match((error as Error).message, /B08_DORMANT_ABSENT/)
    assert.equal(errors.getErrorStatusCode(error), 503)
    assert.equal(requests.filter((row) => row.case === caseName).length, 3)
    assert.equal(retry.classifyRetryableError(error).retryable, false)
    return terminal(error)
  },
])
for (const id of ['local', 'custom-gateway', 'openai'])
  for (const override of [false, true])
    controls.push([
      `reasoning-${id}-${override ? 'override' : 'configured'}`,
      async () => {
        configure({
          defaultModel: { model: `${id}/model`, reasoningEffort: 'high' },
          providers: {
            [id]: provider('reasoning', {
              defaultCapabilities: {
                reasoning: {
                  supported: true,
                  efforts: ['high', 'medium', 'low'],
                },
              },
            }),
          },
        })
        respond = async () => healthy()
        await stream(
          override
            ? { providerOptions: { [id]: { reasoningEffort: 'low' } } }
            : {},
        )
        const request = requests.filter((row) => row.case === caseName)[0]
        assert.equal(
          (request.body as { reasoning_effort: string }).reasoning_effort,
          !override || id === 'openai' ? 'high' : 'low',
        )
        return request.body
      },
    ])
for (const mode of ['skip', 'rate-limit', 'skip-no-backup'])
  controls.push([
    `configured-oauth-${mode}`,
    async () => {
      configure({
        defaultModel: 'codex/gpt-5.5',
        failoverModels: mode === 'skip-no-backup' ? [] : ['backup/model'],
        providers: {
          codex: { type: 'chatgpt-oauth', models: ['gpt-5.5'] },
          backup: provider('backup'),
        },
      })
      if (mode === 'rate-limit') routing.markChatGptOAuthRateLimited()
      respond = async () => healthy()
      try {
        if (mode === 'skip-no-backup') {
          const error = await failure({ skipChatGptOAuth: true })
          assert.match((error as Error).message, /eligible BYOK/)
          assert.equal(
            requests.filter((row) => row.case === caseName).length,
            0,
          )
          return terminal(error)
        }
        const result = await stream({ skipChatGptOAuth: mode === 'skip' })
        assert.equal(requests.filter((row) => row.case === caseName).length, 1)
        assert(
          requests
            .filter((row) => row.case === caseName)[0]
            .url.includes('backup'),
        )
        return result
      } finally {
        routing.resetChatGptOAuthRateLimit()
      }
    },
  ])
for (const structured of [false, true])
  controls.push([
    `nonstream-${structured ? 'structured' : 'text'}-owned-retries`,
    async () => {
      let count = 0
      respond = async () =>
        ++count < 3
          ? httpError()
          : new Response(
              JSON.stringify({
                id: 'healthy',
                object: 'chat.completion',
                created: 0,
                model: 'model',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: structured ? '{"value":"healthy"}' : 'healthy',
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            )
      const result = structured
        ? await llm.promptAiSdkStructured({
            ...params(),
            schema: z.object({ value: z.string() }),
          } as never)
        : await llm.promptAiSdk(params() as never)
      assert.equal(count, 3)
      assert.deepEqual(waits, [100, 200])
      return result
    },
  ])
let failed = false
for (const [name, run] of controls) {
  try {
    await control(name, run)
  } catch {
    failed = true
  }
}
const result = {
  policy,
  refusedFetches,
  networkDispatch: false,
  controls: observations,
}
fs.writeFileSync(
  path.join(output, 'observations.json'),
  JSON.stringify(result, null, 2),
)
assert.equal(refusedFetches, 0)
assert.equal(failed, false, 'B08 controls failed; inspect observations.json')
console.log(
  `B08 offline controls passed: ${controls.length}; actual configured HTTP/SSE request ledger recorded`,
)
