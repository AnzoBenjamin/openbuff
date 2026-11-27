import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import { createHeadlessSessionStore } from '../utils/headless-sessions'

let root: string,
  project: string,
  configDir: string,
  config: string,
  schemaFile: string
let requests: Record<string, unknown>[], server: ReturnType<typeof Bun.serve>
const inheritedHome = process.env.HOME
const entry =
  process.env.OPENBUFF_TEST_HEADLESS_EXECUTABLE ??
  path.resolve(import.meta.dir, '../binary-entry.ts')
const sourceEntry = entry.endsWith('.ts')
const canary =
  'CONTINUATION_CANARY: never remove the audit log; preserve value 7049.'
const expected = { answer: 'fixture-answer' }
let evidence: Record<string, unknown>[]

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'headless-continue-wire-')),
  )
  project = path.join(root, 'project')
  configDir = path.join(root, 'config')
  fs.mkdirSync(project)
  fs.mkdirSync(configDir, { mode: 0o700 })
  requests = []
  evidence = []
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const chunk = (
        delta: unknown,
        finish_reason: string | null,
        usage?: unknown,
      ) =>
        `data: ${JSON.stringify({
          id: `headless-fixture-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      return new Response(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `tool-${requests.length}`,
                type: 'function',
                function: {
                  name: 'set_output',
                  arguments: JSON.stringify(expected),
                },
              },
            ],
          },
          null,
        ) +
          chunk({}, 'tool_calls', {
            prompt_tokens: 50,
            completion_tokens: 5,
            total_tokens: 55,
          }) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  config = path.join(configDir, 'provider-config.json')
  schemaFile = path.join(root, 'schema.json')
  fs.writeFileSync(
    schemaFile,
    JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }),
  )
  writeConfig()
})
afterEach(() => {
  const evidenceDir = process.env.OPENBUFF_TEST_HEADLESS_EVIDENCE_DIR
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(
      path.join(
        evidenceDir,
        `${sourceEntry ? 'source' : 'executable'}-${crypto.randomUUID()}.json`,
      ),
      JSON.stringify(
        {
          entry,
          entrySha256: createHash('sha256')
            .update(fs.readFileSync(entry))
            .digest('hex'),
          parentHomeUnchanged: process.env.HOME === inheritedHome,
          observations: evidence,
          requests,
        },
        null,
        2,
      ),
    )
  }
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})
function writeConfig(apiKeyEnv?: string) {
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/default',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `${apiKeyEnv ? 'https' : 'http'}://127.0.0.1:${server.port}/v1`,
          models: ['default', 'selected'],
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
        },
      },
    }),
  )
}
function childEnvironment(): NodeJS.ProcessEnv {
  return {
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
  }
}
async function execute(args: string[], stdin?: string, helper?: string) {
  const selected = helper ?? entry
  const source = helper !== undefined || sourceEntry
  const child = spawn(
    source ? process.execPath : selected,
    source ? ['--no-env-file', '--no-install', selected, ...args] : args,
    { cwd: project, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const out: Buffer[] = [],
    err: Buffer[] = []
  child.stdout.on('data', (bytes) => out.push(Buffer.from(bytes)))
  child.stderr.on('data', (bytes) => err.push(Buffer.from(bytes)))
  child.stdin.end(stdin)
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    const result = {
      code,
      signal: child.signalCode,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }
    evidence.push({ args, ...result })
    return result
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
}
const events = (stdout: string): Record<string, unknown>[] =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const runArgs = (prompt: string) => [
  'run',
  '--json',
  '--output-schema',
  schemaFile,
  '--timeout',
  '15',
  '-p',
  prompt,
]

// Every provider response is owned/fake. The oracle is actual request context,
// valid JSON delivery and durable bytes, not an empirical model-memory claim.
describe('actual headless continuation consumer', () => {
  test('plain stdin with --model and --output-schema emits exactly one schema-valid JSON result', async () => {
    const result = await execute(
      ['run', '--model', 'fixture/selected', '--output-schema', schemaFile],
      `${canary}\n`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.signal).toBeNull()
    // Parse the entire stdout, not an event line or an extracted substring.
    expect(JSON.parse(result.stdout)).toEqual(expected)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.model === 'selected')).toBe(true)
    expect(JSON.stringify(requests[0]!.messages)).toContain(canary)
  }, 25_000)

  test('stdin/model/schema run persists; a new process continues all prior context without inheriting the model override', async () => {
    const first = await execute(
      [
        'run',
        '--json',
        '--model',
        'fixture/selected',
        '--output-schema',
        schemaFile,
        '--timeout',
        '15',
      ],
      canary,
    )
    expect(first.code, first.stderr).toBe(0)
    const firstEvents = events(first.stdout)
    expect(firstEvents.at(-1)).toMatchObject({
      type: 'result',
      output: expected,
    })
    expect(
      firstEvents.filter((event) => event.type === 'usage').at(-1),
    ).toMatchObject({
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      complete: true,
    })
    const sessionId = first.stderr.match(
      /^openbuff run: session ([a-zA-Z0-9._-]+)/m,
    )?.[1]
    expect(sessionId).toBeDefined()
    expect(first.stderr).not.toContain('could not be saved')
    const firstRequestCount = requests.length
    expect(firstRequestCount).toBeGreaterThan(0)
    expect(requests.every((request) => request.model === 'selected')).toBe(true)
    const second = await execute([
      ...runArgs('Recall the prior constraint and its exact value.'),
      '--continue',
    ])
    expect(second.code, second.stderr).toBe(0)
    expect(events(second.stdout).at(-1)).toMatchObject({
      type: 'result',
      output: expected,
    })
    const continued = requests.slice(firstRequestCount)
    expect(continued.length).toBeGreaterThan(0)
    expect(continued.every((request) => request.model === 'default')).toBe(true)
    expect(JSON.stringify(continued[0].messages)).toContain(canary)
    expect(JSON.stringify(continued[0].messages)).toContain(
      'Recall the prior constraint',
    )
    expect(second.stderr).toContain(`session ${sessionId}`)
    const store = createHeadlessSessionStore({
      projectRoot: project,
      configDir,
    })
    const file = path.join(store.directory, sessionId!, 'state.json')
    const bytes = fs.readFileSync(file)
    const record = JSON.parse(bytes.toString('utf8'))
    expect(
      JSON.stringify(
        record.runState.sessionState.mainAgentState.messageHistory,
      ),
    ).toContain(canary)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(store.directory, sessionId!, '.lock'))).toBe(
      false,
    )
    evidence.push({
      sessionId,
      snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
      history: record.runState.sessionState.mainAgentState.messageHistory,
      mode: fs.statSync(file).mode & 0o777,
      released: !fs.existsSync(path.join(store.directory, sessionId!, '.lock')),
    })
  }, 50_000)

  test('an explicit session ID is a real continuation, while a busy cross-process owner refuses provider entry', async () => {
    const first = await execute(runArgs(canary))
    expect(first.code, first.stderr).toBe(0)
    const sessionId = first.stderr.match(
      /^openbuff run: session ([a-zA-Z0-9._-]+)/m,
    )?.[1]
    expect(sessionId).toBeDefined()
    const lease = await createHeadlessSessionStore({
      projectRoot: project,
      configDir,
    }).acquire({ continue: true, continueId: sessionId })
    const before = requests.length
    try {
      const busy = await execute([
        ...runArgs('Must not dispatch while occupied.'),
        `--continue=${sessionId}`,
      ])
      expect(busy.code).toBe(1)
      expect(events(busy.stdout).at(-1)).toMatchObject({
        type: 'error',
        runOutcome: { cause: { code: 'headless_session_unavailable' } },
      })
      expect(requests.length).toBe(before)
    } finally {
      await lease.close()
    }
    const next = await execute([
      ...runArgs('Continue after owner release.'),
      `--continue=${sessionId}`,
    ])
    expect(next.code, next.stderr).toBe(0)
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(canary)
  }, 65_000)

  test('missing continuation does not create a journal, a conversation, or a provider request', async () => {
    const result = await execute([...runArgs('Must not start.'), '--continue'])
    expect(result.code).toBe(1)
    expect(events(result.stdout).at(-1)).toMatchObject({
      type: 'error',
      runOutcome: { cause: { code: 'headless_session_unavailable' } },
    })
    expect(requests).toHaveLength(0)
    expect(
      fs.existsSync(
        createHeadlessSessionStore({ projectRoot: project, configDir })
          .directory,
      ),
    ).toBe(false)
  }, 25_000)

  test('a missing key produces the exact same readiness message as the TUI and no provider request', async () => {
    writeConfig('OPENBUFF_N12_MISSING_FIXTURE_KEY')
    const helper = path.join(root, 'readiness.ts')
    const module = path.resolve(
      import.meta.dir,
      '../utils/openbuff-provider.ts',
    )
    fs.writeFileSync(
      helper,
      `console.log = console.error; console.info = console.error;\nconst { getOpenbuffProviderReadiness } = await import(${JSON.stringify(module)});\nprocess.stdout.write(JSON.stringify(getOpenbuffProviderReadiness({ agent: 'base2', agentMode: 'DEFAULT' })));\n`,
    )
    const tui = await execute([], undefined, helper)
    expect(tui.code, tui.stderr).toBe(0)
    const expectedReadiness = JSON.parse(tui.stdout) as {
      ok: boolean
      message: string
    }
    expect(expectedReadiness.ok).toBe(false)
    expect(expectedReadiness.message).toContain(
      'OPENBUFF_N12_MISSING_FIXTURE_KEY',
    )
    const result = await execute(runArgs('Must not start without credentials.'))
    expect(result.code).toBe(1)
    expect(events(result.stdout).at(-1)?.message).toBe(
      expectedReadiness.message,
    )
    expect(requests).toHaveLength(0)
    expect(
      fs.existsSync(
        createHeadlessSessionStore({ projectRoot: project, configDir })
          .directory,
      ),
    ).toBe(false)
  }, 45_000)
})
