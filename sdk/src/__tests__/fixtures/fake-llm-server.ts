/**
 * Local fake LLM provider for wire tests (N01, N07). It speaks the Anthropic
 * Messages SSE protocol on `/v1/messages` and the OpenAI chat-completions SSE
 * protocol on `.../chat/completions`, records every request body, and can
 * return scripted failures. Seeded from
 * `.agents/sessions/product-audit-2026-11-12/verification/probes/runtime/p7-cache.ts`.
 *
 * The Anthropic side simulates prompt caching: each request's content is
 * flattened into blocks in Anthropic's cache order (tools, system, messages);
 * the prefix ending at each `cache_control` breakpoint is written to the
 * cache, and a later request whose prefix matches a written one reports those
 * tokens as `cache_read_input_tokens`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createProviderHostContext, loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'

import type { ProviderHostContext } from '../../host-config'

export type CapturedRequest = Readonly<{
  url: string
  path: string
  headers: Record<string, string>
  text: string
  body: Record<string, unknown>
}>

/** A scripted reply. Anything not scripted gets a normal success stream. */
export type ScriptedReply =
  | Readonly<{ kind: 'status'; status: number; body?: unknown; headers?: Record<string, string> }>
  | Readonly<{ kind: 'sse-overloaded' }>

export type FakeLlmServer = Readonly<{
  baseURL: string
  requests: CapturedRequest[]
  /** Replies consumed in order, one per request; later requests succeed. */
  script: ScriptedReply[]
  /** Reported `cache_read_input_tokens` per Anthropic request, in order. */
  cacheReads: number[]
  stop(): void
}>

const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

/** Rough token estimate; the simulation only needs a stable size. */
const tokens = (text: string) => Math.ceil(text.length / 4)

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'cache_control') out[key] = withoutCacheControl(entry)
    }
    return out
  }
  return value
}

/** Anthropic cache order: tools, then system, then message blocks. */
function anthropicBlocks(body: Record<string, unknown>): Array<{ key: string; breakpoint: boolean }> {
  const blocks: Array<{ key: string; breakpoint: boolean }> = []
  const push = (scope: string, block: unknown) => {
    const breakpoint = !!(block && typeof block === 'object' && 'cache_control' in block)
    blocks.push({ key: `${scope}:${JSON.stringify(withoutCacheControl(block))}`, breakpoint })
  }
  for (const toolDef of (body.tools as unknown[] | undefined) ?? []) push('tool', toolDef)
  const system = body.system
  if (typeof system === 'string') push('system', { type: 'text', text: system })
  else for (const block of (system as unknown[] | undefined) ?? []) push('system', block)
  for (const message of (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []) {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as unknown[])
    for (const block of content) push(message.role, block)
  }
  return blocks
}

function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => { out[name] = value })
  return out
}

export function startFakeLlmServer(): FakeLlmServer {
  const requests: CapturedRequest[] = []
  const script: ScriptedReply[] = []
  const cacheReads: number[] = []
  const written = new Map<string, number>()

  const anthropicSuccess = (body: Record<string, unknown>) => {
    const blocks = anthropicBlocks(body)
    let prefix = ''
    let cacheRead = 0
    const prefixes: Array<{ key: string; size: number }> = []
    for (const block of blocks) {
      prefix += block.key
      if (block.breakpoint) prefixes.push({ key: prefix, size: tokens(prefix) })
    }
    for (const candidate of prefixes) {
      const size = written.get(candidate.key)
      if (size !== undefined) cacheRead = Math.max(cacheRead, size)
    }
    for (const candidate of prefixes) written.set(candidate.key, candidate.size)
    cacheReads.push(cacheRead)
    const total = tokens(prefix)
    return (
      sse('message_start', {
        message: {
          id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-fake', content: [],
          stop_reason: null,
          usage: { input_tokens: Math.max(0, total - cacheRead), cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      }) +
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
      sse('content_block_stop', { index: 0 }) +
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      sse('message_stop', {})
    )
  }

  const openAiSuccess = () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    return chunk({ role: 'assistant', content: 'ok' }, null) +
      chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) +
      'data: [DONE]\n\n'
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text()
      const url = new URL(req.url)
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) as Record<string, unknown> } catch { /* non-JSON body */ }
      requests.push({ url: req.url, path: url.pathname, headers: headersRecord(req.headers), text, body })
      const anthropic = url.pathname.endsWith('/v1/messages')
      const reply = script.shift()
      if (reply?.kind === 'status') {
        return new Response(JSON.stringify(reply.body ?? { type: 'error', error: { type: 'api_error', message: `status ${reply.status}` } }), {
          status: reply.status,
          headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
        })
      }
      if (reply?.kind === 'sse-overloaded') {
        const stream = sse('message_start', {
          message: { id: 'msg_overloaded', type: 'message', role: 'assistant', model: 'claude-fake', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
        }) + sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(anthropic ? anthropicSuccess(body) : openAiSuccess(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    script,
    cacheReads,
    stop: () => server.stop(true),
  }
}

/**
 * Capture a real host configuration snapshot from a provider config written
 * to a temp file (explicit selection, no globals, no ambient environment).
 */
export function providerContextFor(config: unknown): { context: ProviderHostContext; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-fake-llm-'))
  const configDir = path.join(root, 'config')
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(configDir)
  fs.mkdirSync(projectRoot)
  const configPath = path.join(configDir, 'provider.json')
  fs.writeFileSync(configPath, JSON.stringify(config))
  const result = loadHostConfigSnapshot({
    fs: nodeConfigReadFs,
    inputs: {
      environment: {},
      platform: process.platform,
      invocationCwd: projectRoot,
      projectRoot,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: configPath, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
  if (result.status !== 'complete') throw new Error(result.cause)
  return {
    context: createProviderHostContext(result.snapshot),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
