// Fake Anthropic-compatible server + real promptAiSdkStream; counts cache_control in request body.
import fs from 'node:fs'
import { promptAiSdkStream } from '/home/ben/Code/CLI/openbuff/sdk/src/impl/llm'
import { clearProviderConfigCacheForTest } from '/home/ben/Code/CLI/openbuff/sdk/src/provider-config'
import { convertCbToModelMessages } from '/home/ben/Code/CLI/openbuff/common/src/util/messages'

const bodies: any[] = []
const server = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const text = await req.text()
    bodies.push({ url: req.url, headers: Object.fromEntries(req.headers), text })
    const ev = (type: string, data: any) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const sse =
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fake', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
      ev('content_block_stop', { index: 0 }) +
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', {})
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  },
})
const cfg = '/tmp/verify-runtime/p7/provider.json'
fs.writeFileSync(cfg, JSON.stringify({
  defaultModel: 'fakeanth/claude-fake',
  providers: { fakeanth: { type: 'anthropic-compatible', baseURL: `http://127.0.0.1:${server.port}`, models: ['claude-fake'] } },
}))
process.env.OPENBUFF_PROVIDER_CONFIG = cfg
clearProviderConfigCacheForTest()
const logger = { debug() {}, info() {}, warn() {}, error: (...a: any[]) => console.error('LOGERR', JSON.stringify(a).slice(0, 300)) }
const big = 'stable project context line. '.repeat(400)
const messages: any[] = [
  { role: 'user', content: [{ type: 'text', text: big }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
  { role: 'user', content: [{ type: 'text', text: 'second turn ' + big }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ack2' }] },
  { role: 'user', content: [{ type: 'text', text: 'now do the task' }] },
]
const chunks: any[] = []
for await (const c of promptAiSdkStream({
  apiKey: 'fixture', runId: 'v7', clientSessionId: 'v7', fingerprintId: 'v7', userInputId: 'v7',
  userId: undefined, agentId: 'fixture', system: 'You are a coding agent. ' + big,
  messages, includeCacheControl: true, signal: new AbortController().signal, maxRetries: 0,
  logger, trackEvent() {}, sendAction() {}, onError(e: any) { console.error('ONERR', String(e)) },
} as never)) chunks.push(c)
server.stop(true)
console.log('chunks', chunks.map((c) => c.type).join(','))
console.log('requests', bodies.length, bodies.map((b) => b.url))
for (const b of bodies) {
  fs.writeFileSync('/tmp/verify-runtime/p7/request-body.json', b.text)
  console.log('anthropic request: cache_control occurrences =', (b.text.match(/cache_control/g) ?? []).length,
    '| cacheControl occurrences =', (b.text.match(/cacheControl/g) ?? []).length,
    '| anthropic-beta header =', b.headers['anthropic-beta'] ?? null, '| body bytes =', b.text.length)
}
// Control: the converter itself does place anchors when asked.
const conv = convertCbToModelMessages({ messages, includeCacheControl: true } as any)
console.log('control convertCbToModelMessages(includeCacheControl:true) anchors =', (JSON.stringify(conv).match(/cache_?[cC]ontrol/g) ?? []).length)
process.exit(0)
