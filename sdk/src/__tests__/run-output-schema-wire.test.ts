import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { OpenbuffClient } from '../client'
import { silentLogger } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

let root: string,
  config: string,
  schemaFile: string,
  requests: Array<Record<string, unknown>>,
  server: ReturnType<typeof Bun.serve>
let observedEvents: PrintModeEvent[]
let reportUsage: boolean
const expected = { answer: 'wire-confirmed' }
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'output-schema-wire-')),
  )
  requests = []
  observedEvents = []
  reportUsage = true
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const chunks = [
        {
          tool_calls: [
            {
              index: 0,
              id: `schema-tool-${requests.length}`,
              type: 'function',
              function: { name: 'set_output', arguments: '' },
            },
          ],
        },
        {
          tool_calls: [
            { index: 0, function: { arguments: JSON.stringify(expected) } },
          ],
        },
      ]
      return new Response(
        chunks
          .map(
            (delta) =>
              `data: ${JSON.stringify({ id: 'fixture-output', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          )
          .join('') +
          `data: ${JSON.stringify({ id: 'fixture-output', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], ...(reportUsage ? { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } } : {}) })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  config = path.join(root, 'config.json')
  schemaFile = path.join(root, 'schema.json')
  fs.writeFileSync(schemaFile, JSON.stringify(schema))
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          models: ['model'],
        },
      },
    }),
  )
})
afterEach(() => {
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})
const agent: AgentDefinition = {
  id: 'schema-wire-agent',
  displayName: 'Schema wire agent',
  toolNames: [],
  systemPrompt: 'Return the requested result.',
  programmaticConfig: { progressiveToolDisclosure: true, fullToolSurface: [] },
}
function client() {
  return new OpenbuffClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    logger: silentLogger,
    handleEvent(event) {
      observedEvents.push(event)
    },
    runTimeoutMs: 10_000,
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}
describe('actual schema output provider and source CLI controls', () => {
  test('a prompt-only root exposes only reporting plus its prior tools and receives the actual schema', async () => {
    const result = await client().run({
      agent,
      prompt: 'Return an answer.',
      outputSchema: schema,
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(result.output).toEqual({ type: 'structuredOutput', value: expected })
    expect(requests).toHaveLength(1)
    expect(
      observedEvents.filter((event) => event.type === 'usage'),
    ).toHaveLength(1)
    expect(
      observedEvents.find((event) => event.type === 'usage'),
    ).toMatchObject({
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      complete: true,
    })
    const tools = requests[0].tools as Array<{ function: { name: string } }>
    expect(tools.map((tool) => tool.function.name).sort()).toEqual([
      'set_output',
      'tool_load',
      'tool_search',
    ])
    expect(JSON.stringify(requests[0].messages)).toContain('Output Schema')
    expect(JSON.stringify(requests[0].messages)).toContain('answer')
  })
  test('missing provider usage remains unknown instead of a zero count', async () => {
    reportUsage = false
    const result = await client().run({
      agent,
      prompt: 'Return an answer.',
      outputSchema: schema,
    })
    expect(result.runOutcome?.termination).toBe('completed')
    const usage = observedEvents.find((event) => event.type === 'usage')
    expect(usage).toMatchObject({ complete: false })
    expect(
      usage && 'inputTokens' in usage ? usage.inputTokens : undefined,
    ).toBeUndefined()
    expect(
      usage && 'outputTokens' in usage ? usage.outputTokens : undefined,
    ).toBeUndefined()
    expect(requests).toHaveLength(1)
  })
  test('a throwing usage observer does not retry or fail a completed provider response', async () => {
    const result = await client().run({
      agent,
      prompt: 'Return an answer.',
      outputSchema: schema,
      handleEvent(event) {
        if (event.type === 'usage') throw new Error('display observer failed')
      },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(requests).toHaveLength(1)
  })

  test('run-scoped schema is captured before asynchronous host dependencies can change it', async () => {
    const chosen = structuredClone(schema)
    const pending = client().run({
      agent,
      prompt: 'Return an answer.',
      outputSchema: chosen,
    })
    chosen.required.push('later-required')
    const result = await pending
    expect(result.output).toEqual({ type: 'structuredOutput', value: expected })
  })
  for (const json of [false, true])
    test(`actual source CLI prints a schema-valid final result (event mode ${json})`, async () => {
      const configDir = path.join(root, `cli-${json}`)
      fs.mkdirSync(configDir)
      const entry = path.resolve(
        import.meta.dir,
        '../../../cli/src/binary-entry.ts',
      )
      const child = spawn(
        process.execPath,
        [
          '--no-env-file',
          '--no-install',
          entry,
          'run',
          '--agent',
          'base2',
          '--model',
          'fixture/model',
          '--output-schema',
          schemaFile,
          '--timeout',
          '15',
          ...(json ? ['--json'] : []),
          '-p',
          'Return the requested answer through set_output.',
        ],
        {
          cwd: root,
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            USER: process.env.USER,
            OPENBUFF_CONFIG_DIR: configDir,
            OPENBUFF_PROVIDER_CONFIG: config,
            OPENBUFF_PROCESS_SUPERVISION: '0',
            OPENBUFF_TELEMETRY: '0',
            DO_NOT_TRACK: '1',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      child.stdout.on('data', (bytes) => stdout.push(Buffer.from(bytes)))
      child.stderr.on('data', (bytes) => stderr.push(Buffer.from(bytes)))
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('close', resolve)
          child.once('error', reject)
        })
        expect(code, Buffer.concat(stderr).toString('utf8')).toBe(0)
        const text = Buffer.concat(stdout).toString('utf8').trim()
        if (json) {
          const events = text.split('\n').map((line) => JSON.parse(line))
          expect(events.at(-1)).toMatchObject({
            type: 'result',
            output: expected,
          })
          expect(
            events.filter((event) => event.type === 'result'),
          ).toHaveLength(1)
        } else expect(JSON.parse(text)).toEqual(expected)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((request) => request.model === 'model')).toBe(
          true,
        )
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
    }, 25_000)
})
