import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect } from 'node:net'
import { PassThrough, Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type { PromptRequest, Stream } from '@agentclientprotocol/sdk'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

import { OpenbuffClient } from '../client'
import { createServeBridge } from '../serve/bridge'
import { runServe } from '../serve/serve'
import { createAcpAgent } from '../services/acp/acp-agent'
import type { AcpPromptHandler } from '../services/acp/acp-agent'
import { AcpSessionData } from '../services/acp/session-data'
import { silentLogger, startFakeLlmServer } from './fixtures/fake-llm-server'
import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type { OpenbuffClientOptions, RunOptions } from '../run'

const linux = process.platform === 'linux' ? describe : describe.skip
const home = process.env.HOME
let root: string, project: string, config: string, provider: FakeLlmServer
const restores: Array<() => void> = []
const cleanup: Array<() => Promise<void> | void> = []
let externalRequests = 0
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/d1cAAAAASUVORK5CYII='
const agent: AgentDefinition = {
  id: 'acp-prompt-wire',
  displayName: 'ACP prompt wire',
  toolNames: [],
  systemPrompt: 'Describe user attachments. Do not use tools.',
  programmaticConfig: { progressiveToolDisclosure: true, fullToolSurface: [] },
}
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'acp-content-wire-')),
  )
  project = path.join(root, 'project')
  fs.mkdirSync(path.join(project, 'nested'), { recursive: true })
  fs.writeFileSync(
    path.join(project, 'notes.txt'),
    'ACTUAL-FILE-BYTES café\nsecond line\n',
  )
  provider = startFakeLlmServer()
  config = path.join(root, 'provider.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `${provider.baseURL}/v1`,
          models: ['model'],
          defaultCapabilities: { input: { image: true } },
        },
      },
    }),
  )
  const actualFetch = globalThis.fetch
  externalRequests = 0
  const network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(
          args[0] instanceof Request ? args[0].url : String(args[0]),
        )
        if (url.origin !== provider.baseURL) {
          externalRequests++
          throw new Error('External requests are forbidden')
        }
        return actualFetch(...args)
      },
      {
        preconnect() {
          throw new Error('Unexpected preconnect')
        },
      },
    ),
  )
  restores.push(() => network.mockRestore())
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  provider.stop()
  for (const restore of restores.splice(0).reverse()) restore()
  fs.rmSync(root, { recursive: true, force: true })
  expect(externalRequests).toBe(0)
  expect(process.env.HOME).toBe(home)
})
function client() {
  return new OpenbuffClient({
    cwd: project,
    agentDefinitions: [agent],
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 10_000,
    logger: silentLogger,
    handleEvent() {},
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: project,
      projectRoot: project,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true },
      trust: {
        ancestorConfig: false,
        projectReadableRoots: false,
        projectConfig: 'untrusted',
      },
    },
  })
}
function stream(output: PassThrough, input: PassThrough): Stream {
  return ndJsonStream(
    Writable.toWeb(output) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(input) as unknown as ReadableStream<Uint8Array>,
  )
}
function acp(onTurn?: (input: Parameters<AcpPromptHandler>[0]) => void) {
  const toAgent = new PassThrough(),
    toClient = new PassThrough()
  const actualClient = client()
  let runs = 0
  const { promptHandler } = createServeBridge({
    projectRoot: project,
    agentId: agent.id,
    sessionData: new AcpSessionData(),
    client: {
      run(options) {
        runs++
        return actualClient.run(options)
      },
    },
  })
  new AgentSideConnection(
    (connection) =>
      createAcpAgent({
        projectRoot: project,
        promptHandler: (input) => {
          onTurn?.(input)
          return promptHandler(input)
        },
        connection,
      }),
    stream(toClient, toAgent),
  )
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => {
        throw new Error('No permission requests')
      },
    }),
    stream(toAgent, toClient),
  )
  cleanup.push(() => {
    toAgent.destroy()
    toClient.destroy()
  })
  return { connection, runs: () => runs }
}
async function rejected(
  pending: Promise<unknown>,
  code: string,
  reason: string,
) {
  let failure: unknown
  try {
    await pending
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(RequestError)
  expect((failure as RequestError).code).toBe(-32602)
  expect((failure as RequestError).data).toMatchObject({
    'openbuff.dev': { code, reason, nextStep: expect.any(String) },
  })
}

linux('actual ACP → serve bridge → source SDK provider wire', () => {
  test('file bytes and the inline image reach a single user-role provider request in order', async () => {
    const c = acp()
    const initialized = await c.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(initialized.agentCapabilities?.promptCapabilities).toMatchObject({
      image: true,
      embeddedContext: true,
      audio: false,
    })
    const { sessionId } = await c.connection.newSession({
      cwd: path.join(project, 'nested'),
      mcpServers: [],
    })
    const result = await c.connection.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'BEFORE-RESOURCE\n' },
        {
          type: 'resource_link',
          uri: pathToFileURL(path.join(project, 'notes.txt')).href,
          name: 'notes.txt',
        },
        { type: 'image', mimeType: 'image/png', data: png },
        { type: 'text', text: '\nAFTER-IMAGE' },
      ],
    })
    expect(result.stopReason).toBe('end_turn')
    expect(c.runs()).toBe(1)
    expect(provider.requests).toHaveLength(1)
    const request = provider.requests[0]
    expect(request.path).toBe('/v1/chat/completions')
    const messages = request.body.messages as Array<{
      role: string
      content:
        | string
        | Array<{ type: string; text?: string; image_url?: { url: string } }>
    }>
    const user = messages.find(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('ACTUAL-FILE-BYTES'),
    )
    expect(user).toBeDefined()
    if (!user)
      throw new Error('No provider user message contains the attached file')
    const parts = user.content as Exclude<typeof user.content, string>
    expect(Array.isArray(parts)).toBe(true)
    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'text',
      'image_url',
      'text',
    ])
    expect(parts[0].text).toContain('BEFORE-RESOURCE')
    expect(parts[1].text).toContain('ACTUAL-FILE-BYTES café\nsecond line\n')
    expect(parts[1].text).toMatch(/user-provided.*resource/i)
    expect(parts[1].text).toMatch(/untrusted input.*no edit authority/i)
    expect(parts[2].image_url?.url).toBe(`data:image/png;base64,${png}`)
    expect(parts[3].text).toContain('AFTER-IMAGE')
    expect(
      JSON.stringify(messages.filter((message) => message.role !== 'user')),
    ).not.toContain('ACTUAL-FILE-BYTES')
    expect(request.headers.authorization).toBeUndefined()
    const tools = request.body.tools as Array<{ function: { name: string } }>
    expect(tools.map((tool) => tool.function.name).sort()).toEqual([
      'tool_load',
      'tool_search',
    ])
  }, 15_000)

  test('unsupported, missing, outside, symlink, oversize and malformed data fail over actual ACP with zero SDK/provider runs', async () => {
    const c = acp()
    await c.connection.initialize({ protocolVersion: PROTOCOL_VERSION })
    const { sessionId } = await c.connection.newSession({
      cwd: project,
      mcpServers: [],
    })
    const outside = path.join(root, 'outside.txt')
    const alias = path.join(project, 'alias.txt')
    const large = path.join(project, 'large.txt')
    fs.writeFileSync(outside, 'OUTSIDE-NEVER-SENT')
    fs.symlinkSync(outside, alias)
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1))
    const cases: Array<[PromptRequest['prompt'], string, string]> = [
      [
        [{ type: 'audio', mimeType: 'audio/wav', data: 'YQ==' }],
        'unsupported_prompt_content',
        'unsupported_block',
      ],
      [
        [
          {
            type: 'resource_link',
            name: 'missing',
            uri: pathToFileURL(path.join(project, 'missing.txt')).href,
          },
        ],
        'prompt_resource_unavailable',
        'file_missing',
      ],
      [
        [
          {
            type: 'resource_link',
            name: 'outside',
            uri: pathToFileURL(outside).href,
          },
        ],
        'prompt_resource_denied',
        'outside_project',
      ],
      [
        [
          {
            type: 'resource_link',
            name: 'alias',
            uri: pathToFileURL(alias).href,
          },
        ],
        'prompt_resource_denied',
        'unsafe_path',
      ],
      [
        [
          {
            type: 'resource_link',
            name: 'large',
            uri: pathToFileURL(large).href,
          },
        ],
        'limit_exceeded',
        'file_too_large',
      ],
      [
        [{ type: 'image', mimeType: 'image/png', data: 'not-base64!' }],
        'invalid_prompt_content',
        'invalid_base64',
      ],
      [
        [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) }],
        'limit_exceeded',
        'prompt_too_large',
      ],
    ]
    for (const [prompt, code, reason] of cases) {
      await rejected(c.connection.prompt({ sessionId, prompt }), code, reason)
      expect(c.runs()).toBe(0)
      expect(provider.requests).toEqual([])
    }
  }, 15_000)

  test('actual ACP cancel during capture closes the file and starts no SDK/provider request', async () => {
    let turnSignal: AbortSignal | undefined
    const c = acp((input) => {
      turnSignal = input.signal
    })
    await c.connection.initialize({ protocolVersion: PROTOCOL_VERSION })
    const { sessionId } = await c.connection.newSession({
      cwd: project,
      mcpServers: [],
    })
    const actualOpen = fs.promises.open.bind(fs.promises)
    let release: () => void = () => {},
      arrived: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const opened = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const handles: fs.promises.FileHandle[] = []
    const observer = spyOn(fs.promises, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await actualOpen(...args)
        handles.push(handle)
        if (String(args[0]).endsWith('/notes.txt')) {
          arrived()
          await gate
        }
        return handle
      },
    )
    restores.push(() => observer.mockRestore())
    const pending = c.connection.prompt({
      sessionId,
      prompt: [
        {
          type: 'resource_link',
          uri: pathToFileURL(path.join(project, 'notes.txt')).href,
          name: 'notes.txt',
        },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    })
    try {
      await Promise.race([
        opened,
        pending.then(() => {
          throw new Error('Missing resource capture')
        }),
      ])
      if (!turnSignal) throw new Error('No captured ACP turn signal')
      const aborted = new Promise<void>((resolve) => {
        turnSignal!.addEventListener('abort', () => resolve(), { once: true })
      })
      await c.connection.cancel({ sessionId })
      await aborted
    } finally {
      release()
    }
    expect((await pending).stopReason).toBe('cancelled')
    expect(c.runs()).toBe(0)
    expect(provider.requests).toEqual([])
    for (const handle of handles) expect(handle.fd).toBe(-1)
  })

  test('runServe binds its default containment root into the real socket bridge once', async () => {
    const runs: Array<RunOptions & OpenbuffClientOptions> = []
    const socketPath = path.join(root, 'serve.sock'),
      token = 'owned-rich-content-test'
    const cwd = spyOn(process, 'cwd').mockReturnValue(project)
    let serving: ReturnType<typeof runServe>
    try {
      serving = runServe({
        transport: { kind: 'socket', socketPath, token },
        sessionData: new AcpSessionData(),
        credentialEnv: { OPENBUFF_PROVIDER_CONFIG: config },
        client: {
          async run(options) {
            runs.push(options)
            return { output: { type: 'lastMessage', value: [] } }
          },
        },
        logger: silentLogger,
      })
    } finally {
      cwd.mockRestore()
    }
    cleanup.push(() => serving.close())
    const socket = connect(socketPath)
    cleanup.push(() => {
      socket.destroy()
    })
    socket.write(`${JSON.stringify({ type: 'openbuff.serve.auth', token })}\n`)
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => {
          throw new Error('No approvals')
        },
      }),
      ndJsonStream(
        Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
      ),
    )
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION })
    const { sessionId } = await connection.newSession({
      cwd: project,
      mcpServers: [],
    })
    await connection.prompt({
      sessionId,
      prompt: [
        {
          type: 'resource_link',
          uri: pathToFileURL(path.join(project, 'notes.txt')).href,
          name: 'notes.txt',
        },
      ],
    })
    expect(runs).toHaveLength(1)
    expect(runs[0].prompt).toContain('ACTUAL-FILE-BYTES café\nsecond line\n')
    expect(runs[0].content?.[0].type).toBe('text')
    expect(provider.requests).toEqual([])
  })
})
