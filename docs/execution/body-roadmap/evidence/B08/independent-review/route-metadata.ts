import fs from 'node:fs'
import path from 'node:path'

const out = path.resolve(process.argv[2]!)
fs.mkdirSync(out, { recursive: true })
let armed = false
let refused = 0
const requests: Array<{ url: string; body: unknown }> = []
globalThis.fetch = Object.assign(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (!armed || !/^https:\/\/(vision|backup)\.independent\.invalid\/v1\/chat\/completions$/.test(url)) {
    refused++
    throw new Error('Independent route probe refuses unexpected fetch')
  }
  requests.push({ url, body: JSON.parse(String(init?.body)) })
  return url.includes('vision.')
    ? new Response(JSON.stringify({ error: { message: 'Unavailable', code: 'upstream_error' } }),
      { status: 503, headers: { 'content-type': 'application/json' } })
    : new Response('data: {"choices":[{"delta":{"content":"healthy"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
}, { preconnect() {} }) as typeof fetch
const { promptAiSdkStream } = await import('../../../../../../sdk/src/impl/llm')
const { clearProviderConfigCacheForTest } = await import('../../../../../../sdk/src/provider-config')
const config = path.join(out, 'provider.json')
const provider = (host: string, image: boolean) => ({
  type: 'openai-compatible', baseURL: `https://${host}.independent.invalid/v1`,
  models: ['model'], apiKey: 'synthetic-only',
  defaultCapabilities: { input: { image } },
})
fs.writeFileSync(config, JSON.stringify({ defaultModel: 'primary/model', visionModel: 'vision/model',
  failoverModels: ['backup/model'], providers: {
    primary: provider('primary', false), vision: provider('vision', true), backup: provider('backup', true),
  } }))
process.env.OPENBUFF_PROVIDER_CONFIG = config
clearProviderConfigCacheForTest()
const statuses: any[] = []; const waits: number[] = []; const chunks = []
let error: unknown
armed = true
try {
  for await (const chunk of promptAiSdkStream({
    apiKey: 'synthetic-only', runId: 'b08-independent', clientSessionId: 'b08-independent',
    fingerprintId: 'b08-independent', userInputId: 'b08-independent', userId: undefined,
    agentId: 'fixture', signal: new AbortController().signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect image' },
      { type: 'image', image: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: 'image/png' }] }],
    retryPolicy: { maxRetries: 2, backupMaxRetries: 0, maxTotalAttempts: 4,
      baseDelayMs: 100, maxDelayMs: 200, retryAfterMaxDelayMs: 250, maxTotalDelayMs: 600, jitterFraction: 0 },
    retrySleep: async (ms: number) => { waits.push(ms) },
    logger: { debug() {}, info() {}, warn() {}, error() {} }, trackEvent() {}, onError() {},
    sendAction(action: unknown) { statuses.push(action) },
  } as never)) chunks.push(chunk)
} catch (caught) { error = caught }
const failover = statuses.find((row) => row.action?.chunk?.status === 'failover')?.action.chunk
const ledger = requests.map((row) => row.url.includes('vision.') ? 'vision' : 'backup')
const passed = refused === 0 && !error && JSON.stringify(ledger) === JSON.stringify(['vision', 'vision', 'vision', 'backup']) &&
  JSON.stringify(waits) === JSON.stringify([100, 200]) && failover?.model === 'vision/model' && failover?.nextModel === 'backup/model'
fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify({ passed, refused, forwarded: 0,
  requests, ledger, waits, statuses, chunks, error: error instanceof Error ? error.message : error,
  expectedFailover: { model: 'vision/model', nextModel: 'backup/model' }, actualFailover: failover,
}, null, 2) + '\n')
console.log(JSON.stringify({ passed, refused, ledger, waits, actualFailover: failover }))
if (!passed) process.exitCode = 1
