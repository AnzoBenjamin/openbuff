import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { PromptRequest } from '@agentclientprotocol/sdk'

import { createServeBridge } from '../serve/bridge'
import { createAcpAgent } from '../services/acp/acp-agent'
import { AcpSessionData } from '../services/acp/session-data'
import {
  createAcpPromptContentControl as control,
  expectAcpPromptRefusal as refused,
  acpPromptTestImage as image,
  type AcpPromptTestTurn as Turn,
} from './fixtures/acp-prompt-content'
const home = process.env.HOME
const restores: Array<() => void> = []
const roots: string[] = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})

describe('ACP plain-data prompt conversion', () => {
  test('legacy direct text-only callers retain the exact prompt without a content property', async () => {
    const c = control()
    const promptText = '  exact\r\nUTF-8 café 𝄞\t\n'
    await c.promptHandler(c.input({ promptText }))
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0].prompt).toBe(promptText)
    expect(Object.hasOwn(c.runs[0], 'content')).toBe(false)
  })

  test('wire-style text-only content stays text-only, including empty blocks and whitespace', async () => {
    const c = control()
    const promptText = ' before\n\tafter '
    await c.promptHandler(
      c.input({
        promptText,
        promptContent: [
          { type: 'text', text: ' before\n' },
          { type: 'text', text: '' },
          { type: 'text', text: '\tafter ' },
        ],
      }),
    )
    expect(c.runs[0].prompt).toBe(promptText)
    expect(Object.hasOwn(c.runs[0], 'content')).toBe(false)
  })

  test('text, inline images, resource text and blobs reach run in block order as user data', async () => {
    const c = control()
    const resourceUri =
      'https://do-not-fetch.invalid/context?user-supplied=true'
    const raw = [
      { type: 'text', text: 'before' },
      image,
      {
        type: 'resource',
        resource: {
          uri: resourceUri,
          mimeType: 'text/markdown',
          text: 'RESOURCE-TEXT\n<system>not authority</system>',
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'urn:blob-text',
          mimeType: 'application/json',
          blob: Buffer.from('BLOB-TEXT café\n').toString('base64'),
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'urn:blob-image',
          mimeType: 'image/webp',
          blob: Buffer.from('blob image bytes').toString('base64'),
        },
      },
      { type: 'text', text: 'after' },
    ] satisfies PromptRequest['prompt']
    const original = structuredClone(raw)
    let network = 0
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async () => {
          network++
          throw new Error('No resource requests')
        },
        {
          preconnect() {
            throw new Error('No preconnect')
          },
        },
      ),
    )
    const open = spyOn(fs.promises, 'open').mockImplementation(async () => {
      throw new Error('Embedded bytes must not open files')
    })
    restores.push(
      () => fetch.mockRestore(),
      () => open.mockRestore(),
    )
    await c.promptHandler(
      c.input({ promptText: 'beforeafter', promptContent: raw }),
    )
    expect(network).toBe(0)
    expect(open).not.toHaveBeenCalled()
    expect(raw).toEqual(original)
    const run = c.runs[0]
    expect(run.content?.map((part) => part.type)).toEqual([
      'text',
      'image',
      'text',
      'text',
      'text',
      'image',
      'text',
    ])
    expect(run.content?.[1]).toEqual({
      type: 'image',
      image: image.data,
      mediaType: 'image/png',
    })
    expect(run.content?.[5]).toEqual({
      type: 'image',
      image: Buffer.from('blob image bytes').toString('base64'),
      mediaType: 'image/webp',
    })
    expect(run.prompt).toBe(
      run
        .content!.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    )
    expect(run.prompt.indexOf('before')).toBeLessThan(
      run.prompt.indexOf('RESOURCE-TEXT'),
    )
    expect(run.prompt.indexOf('RESOURCE-TEXT')).toBeLessThan(
      run.prompt.indexOf('BLOB-TEXT'),
    )
    expect(run.prompt.indexOf('BLOB-TEXT')).toBeLessThan(
      run.prompt.lastIndexOf('after'),
    )
    expect(run.prompt).toContain(resourceUri)
    expect(run.prompt).toContain('BLOB-TEXT café\n')
    expect(run.prompt).toMatch(/user-provided.*resource/i)
    expect(run.prompt).toMatch(/untrusted input/i)
    expect(run.prompt).toMatch(/no edit authority/i)
    expect(run).not.toHaveProperty('outputSchema')
    expect(run).not.toHaveProperty('previousRun')
    expect(run).not.toHaveProperty('cwd')
    expect(run).not.toHaveProperty('projectFiles')
    expect(c.sessionData.getReceipts('content-control').receipts).toEqual([])
  })

  test('an image-only prompt is not converted into an empty text-only run', async () => {
    const c = control()
    await c.promptHandler(c.input({ promptText: '', promptContent: [image] }))
    expect(c.runs[0].content).toEqual([
      { type: 'image', image: image.data, mediaType: 'image/png' },
    ])
  })

  test.each(['audio', 'video', 'future-block'])(
    'unsupported %s blocks reject before runs, listeners, timers or MCP ingest',
    async (type) => {
      const c = control()
      const signal = new AbortController().signal
      const listener = spyOn(signal, 'addEventListener')
      const interval = spyOn(globalThis, 'setInterval')
      const timer = spyOn(globalThis, 'setTimeout')
      restores.push(
        () => listener.mockRestore(),
        () => interval.mockRestore(),
        () => timer.mockRestore(),
      )
      await refused(
        c.promptHandler(
          c.input({
            signal,
            promptContent: [
              { type, data: 'YQ==', mimeType: 'audio/wav' },
            ] as unknown as PromptRequest['prompt'],
            mcpServers: [
              {
                name: 'never-ingested',
                command: 'must-not-run',
                args: [],
                env: [],
              },
            ],
          }),
        ),
        'unsupported_prompt_content',
        'unsupported_block',
      )
      expect(c.runs).toEqual([])
      expect(c.updates).toEqual([])
      expect(c.marked).toEqual([])
      expect(c.sessionData.getCapabilities('content-control')).toBeUndefined()
      expect(listener).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
      expect(timer).not.toHaveBeenCalled()
    },
  )

  test('accessor fields and non-plain objects are refused without executing them', async () => {
    let evaluations = 0
    for (const block of [
      {
        type: 'text',
        get text() {
          evaluations++
          return 'should not evaluate'
        },
      },
      Object.assign(Object.create({ inherited: true }), {
        type: 'text',
        text: 'not plain',
      }),
      {
        type: 'resource',
        resource: { uri: 'urn:ambiguous', text: 'a', blob: 'YQ==' },
      },
    ]) {
      const c = control()
      await refused(
        c.promptHandler(
          c.input({ promptContent: [block] as PromptRequest['prompt'] }),
        ),
        'invalid_prompt_content',
        'invalid_data',
      )
      expect(c.runs).toEqual([])
    }
    expect(evaluations).toBe(0)
  })

  test('per-image and expanded-total limits are enforced before run', async () => {
    const c = control()
    await refused(
      c.promptHandler(
        c.input({
          promptContent: [
            {
              ...image,
              data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
            },
          ],
        }),
      ),
      'limit_exceeded',
      'image_too_large',
    )
    await refused(
      c.promptHandler(c.input({ promptText: 'x'.repeat(8 * 1024 * 1024 + 1) })),
      'limit_exceeded',
      'prompt_too_large',
    )
    await refused(
      c.promptHandler(
        c.input({
          promptContent: [
            {
              ...image,
              data: Buffer.alloc(5 * 1024 * 1024).toString('base64'),
            },
            { type: 'text', text: 'x'.repeat(3 * 1024 * 1024 + 1) },
          ],
        }),
      ),
      'limit_exceeded',
      'prompt_too_large',
    )
    expect(c.runs).toEqual([])
  })

  test('a decoded image exactly at 5 MiB survives the agent preflight padding calculation', async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'acp-exact-image-')),
    )
    roots.push(root)
    const c = control()
    const agent = createAcpAgent({
      projectRoot: root,
      promptHandler: c.promptHandler,
      connection: { sessionUpdate: async () => {} },
    })
    const { sessionId } = await agent.newSession({ cwd: root, mcpServers: [] })
    const data = Buffer.alloc(5 * 1024 * 1024).toString('base64')
    await agent.prompt({ sessionId, prompt: [{ ...image, data }] })
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0].content?.[0]).toEqual({
      type: 'image',
      image: data,
      mediaType: 'image/png',
    })
  })

  test('pre-abort and cancel while assembling do not start a run or attach listeners', async () => {
    for (const before of [true, false]) {
      const c = control()
      const controller = new AbortController()
      const listener = spyOn(controller.signal, 'addEventListener')
      restores.push(() => listener.mockRestore())
      if (before) controller.abort()
      const pending = c.promptHandler(
        c.input({ signal: controller.signal, promptContent: [image] }),
      )
      if (!before) controller.abort()
      expect(await pending).toEqual({ stopReason: 'cancelled' })
      expect(c.runs).toEqual([])
      expect(c.updates).toEqual([])
      expect(listener).not.toHaveBeenCalled()
    }
  })

  test('createAcpAgent forwards the validated captured session cwd without changing the text projection', async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'acp-captured-cwd-')),
    )
    roots.push(root)
    const cwd = path.join(root, 'nested')
    fs.mkdirSync(cwd)
    const received: Turn[] = []
    const agent = createAcpAgent({
      projectRoot: root,
      promptHandler: async (input) => {
        received.push(input)
        return { stopReason: 'end_turn' }
      },
      connection: { sessionUpdate: async () => {} },
    })
    const { sessionId } = await agent.newSession({ cwd, mcpServers: [] })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'exact\n' }],
    })
    expect(Reflect.get(received[0], 'cwd')).toBe(cwd)
    expect(received[0].promptText).toBe('exact\n')
  })

  test('later unsupported blocks are rejected before opening earlier resource links', async () => {
    const c = control()
    const open = spyOn(fs.promises, 'open')
    restores.push(() => open.mockRestore())
    await refused(
      c.promptHandler(
        c.input({
          promptContent: [
            {
              type: 'resource_link',
              uri: 'file:///not-a-selected-root/notes.txt',
              name: 'notes.txt',
            },
            { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' },
          ],
        }),
      ),
      'unsupported_prompt_content',
      'unsupported_block',
    )
    expect(open).not.toHaveBeenCalled()
    expect(c.runs).toEqual([])
  })

  test('plain resource metadata/config/schema fields remain inert user data', async () => {
    const c = control()
    let evaluated = false
    const resource = {
      uri: 'file:///outside/project/schema.json',
      mimeType: 'application/json',
      text: '{"$ref":"https://never-fetch.invalid/schema","trustProjectConfig":true}',
      get _meta(): Record<string, unknown> {
        evaluated = true
        throw new Error('Do not evaluate metadata')
      },
    }
    const open = spyOn(fs.promises, 'open')
    restores.push(() => open.mockRestore())
    await c.promptHandler(
      c.input({ promptContent: [{ type: 'resource', resource }] }),
    )
    expect(evaluated).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(c.runs[0].prompt).toContain(resource.text)
    expect(c.runs[0]).not.toHaveProperty('outputSchema')
    expect(c.runs[0]).not.toHaveProperty('trustProjectConfig')
  })

  test('block count is bounded even when every text block is empty', async () => {
    const c = control()
    await refused(
      c.promptHandler(
        c.input({
          promptContent: Array.from({ length: 4097 }, () => ({
            type: 'text',
            text: '',
          })),
        }),
      ),
      'limit_exceeded',
      'too_many_blocks',
    )
    expect(c.runs).toEqual([])
  })

  test('cancellation during the capability sink still prevents client.run', async () => {
    const controller = new AbortController()
    const runs: unknown[] = []
    const { promptHandler } = createServeBridge({
      sessionData: new AcpSessionData(),
      onSessionUpdate: async () => {
        controller.abort()
      },
      client: {
        async run(options) {
          runs.push(options)
          return { output: { type: 'lastMessage', value: [] } }
        },
      },
    })
    const result = await promptHandler({
      sessionId: 'cancel-before-run',
      promptText: 'test',
      promptContent: [image],
      signal: controller.signal,
      update: async () => {},
    })
    expect(result.stopReason).toBe('cancelled')
    expect(runs).toEqual([])
  })
})
