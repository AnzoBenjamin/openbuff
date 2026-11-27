import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { RequestError } from '@agentclientprotocol/sdk'
import type { PromptRequest } from '@agentclientprotocol/sdk'
import { createServeBridge } from '../serve/bridge'
import { AcpSessionData } from '../services/acp/session-data'
import type { AcpPromptHandler } from '../services/acp/acp-agent'
import type { OpenbuffClientOptions, RunOptions } from '../run'

const linux = process.platform === 'linux' ? describe : describe.skip
const home = process.env.HOME
let fixture: string, project: string, outside: string
const restores: Array<() => void> = []
beforeEach(() => {
  fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'acp-content-files-')),
  )
  project = path.join(fixture, 'project')
  outside = path.join(fixture, 'outside')
  fs.mkdirSync(project)
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(project, 'nested'))
  fs.writeFileSync(path.join(project, 'notes.txt'), 'PROJECT-FILE café\r\n')
  fs.writeFileSync(
    path.join(outside, 'notes.txt'),
    'OUTSIDE-MUST-NOT-REACH-RUN',
  )
})
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  fs.rmSync(fixture, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
function link(
  file: string,
  mimeType?: string,
): PromptRequest['prompt'][number] {
  return {
    type: 'resource_link',
    uri: pathToFileURL(file).href,
    name: path.basename(file),
    ...(mimeType ? { mimeType } : {}),
  }
}
function control(projectRoot: string | undefined = project) {
  const runs: Array<RunOptions & OpenbuffClientOptions> = []
  const { promptHandler } = createServeBridge({
    projectRoot,
    sessionData: new AcpSessionData(),
    client: {
      async run(options) {
        runs.push(options)
        return { output: { type: 'lastMessage', value: [] } }
      },
    },
  })
  const input = (
    blocks: PromptRequest['prompt'],
    extra: Partial<Parameters<AcpPromptHandler>[0]> = {},
  ): Parameters<AcpPromptHandler>[0] => ({
    sessionId: 'files',
    promptText: '',
    promptContent: blocks,
    signal: new AbortController().signal,
    update: async () => {},
    ...extra,
  })
  return { runs, promptHandler, input }
}
async function refused(
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
  expect(JSON.stringify((failure as RequestError).data)).not.toContain(
    'OUTSIDE-MUST-NOT-REACH-RUN',
  )
}

linux('ACP host-root file resource boundary', () => {
  test('a local @file URI expands to exact text in order, not a filesystem/tool capability', async () => {
    const c = control()
    const file = path.join(project, 'notes.txt')
    let reverseReads = 0,
      network = 0
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async () => {
          network++
          throw new Error('No remote fetch')
        },
        {
          preconnect() {
            throw new Error('No preconnect')
          },
        },
      ),
    )
    restores.push(() => fetch.mockRestore())
    await c.promptHandler(
      c.input(
        [
          { type: 'text', text: 'before' },
          link(file),
          { type: 'text', text: 'after' },
        ],
        {
          promptText: 'beforeafter',
          cwd: path.join(project, 'nested'),
          reverseRequests: {
            async readTextFile() {
              reverseReads++
              return { content: 'CLIENT-FILESYSTEM-MUST-NOT-BE-USED' }
            },
            async writeTextFile() {
              throw new Error('No writes')
            },
            async createTerminal() {
              throw new Error('No terminal')
            },
            async requestPermission() {
              throw new Error('No permission')
            },
          },
        } as Partial<Parameters<AcpPromptHandler>[0]>,
      ),
    )
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0].content?.map((part) => part.type)).toEqual([
      'text',
      'text',
      'text',
    ])
    expect(c.runs[0].prompt).toContain('PROJECT-FILE café\r\n')
    expect(c.runs[0].prompt).toContain(pathToFileURL(file).href)
    expect(c.runs[0].prompt).toMatch(/user-provided.*resource/i)
    expect(c.runs[0].prompt).toMatch(/untrusted input.*no edit authority/i)
    expect(c.runs[0].prompt.indexOf('before')).toBeLessThan(
      c.runs[0].prompt.indexOf('PROJECT-FILE'),
    )
    expect(c.runs[0].prompt.indexOf('PROJECT-FILE')).toBeLessThan(
      c.runs[0].prompt.indexOf('after'),
    )
    expect(c.runs[0]).not.toHaveProperty('cwd')
    expect(c.runs[0]).not.toHaveProperty('previousRun')
    expect(reverseReads).toBe(0)
    expect(network).toBe(0)
  })

  test('a file image is encoded without dropping it or performing a remote read', async () => {
    const c = control()
    const file = path.join(project, 'picture.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff])
    fs.writeFileSync(file, bytes)
    await c.promptHandler(c.input([link(file)]))
    expect(c.runs[0].content).toContainEqual({
      type: 'image',
      image: bytes.toString('base64'),
      mediaType: 'image/png',
    })
    expect(c.runs[0].prompt).toContain(pathToFileURL(file).href)
  })

  test('empty file images are invalid input, not empty image parts', async () => {
    const c = control()
    const file = path.join(project, 'empty.png')
    fs.writeFileSync(file, '')
    await refused(
      c.promptHandler(c.input([link(file)])),
      'invalid_prompt_content',
      'invalid_data',
    )
    expect(c.runs).toEqual([])
  })

  test('server-selected root is required; captured cwd cannot become a fallback authority', async () => {
    const runs: unknown[] = []
    const { promptHandler } = createServeBridge({
      sessionData: new AcpSessionData(),
      client: {
        async run(options) {
          runs.push(options)
          return { output: { type: 'lastMessage', value: [] } }
        },
      },
    })
    await refused(
      promptHandler({
        sessionId: 'no-root',
        promptText: '',
        promptContent: [link(path.join(outside, 'notes.txt'))],
        cwd: outside,
        signal: new AbortController().signal,
        update: async () => {},
      } as Parameters<AcpPromptHandler>[0]),
      'prompt_resource_unavailable',
      'containment_unavailable',
    )
    expect(runs).toEqual([])
  })

  test('missing and outside files return typed refusals before any run', async () => {
    const c = control()
    await refused(
      c.promptHandler(c.input([link(path.join(project, 'missing.txt'))])),
      'prompt_resource_unavailable',
      'file_missing',
    )
    await refused(
      c.promptHandler(c.input([link(path.join(outside, 'notes.txt'))])),
      'prompt_resource_denied',
      'outside_project',
    )
    expect(c.runs).toEqual([])
  })

  test.each([
    '.env',
    'credentials.json',
    '.kube/config',
    '.aws/config',
    '.docker/config.json',
    'gh/hosts.yml',
    'private.key',
  ])('shared sensitive-path classification refuses %s', async (relative) => {
    const c = control()
    const file = path.join(project, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'SENSITIVE-FILE-MUST-NOT-REACH-RUN')
    await refused(
      c.promptHandler(c.input([link(file)])),
      'prompt_resource_denied',
      'sensitive_path',
    )
    expect(c.runs).toEqual([])
  })

  test('public/template filenames allowed by the shared classifier remain readable', async () => {
    const c = control()
    for (const relative of [
      '.env.example',
      'credentials.md',
      'public.crt',
      '.yarnrc.yml',
    ]) {
      const file = path.join(project, relative)
      fs.writeFileSync(file, `PUBLIC-${relative}`)
      await c.promptHandler(c.input([link(file)]))
      expect(c.runs.at(-1)?.prompt).toContain(`PUBLIC-${relative}`)
    }
  })

  test.each([
    'safe-final',
    'outside-final',
    'sensitive-final',
    'safe-parent',
    'outside-parent',
  ])('refuses %s symlinks before run', async (kind) => {
    const c = control()
    let file: string
    if (kind.endsWith('parent')) {
      const parent = path.join(project, 'linked-directory')
      fs.symlinkSync(kind.startsWith('outside') ? outside : project, parent)
      file = path.join(parent, 'notes.txt')
    } else {
      const sensitive = path.join(project, '.env')
      fs.writeFileSync(sensitive, 'SECRET-DO-NOT-READ')
      file = path.join(project, 'alias.txt')
      fs.symlinkSync(
        kind === 'safe-final'
          ? path.join(project, 'notes.txt')
          : kind === 'outside-final'
            ? path.join(outside, 'notes.txt')
            : sensitive,
        file,
      )
    }
    await refused(
      c.promptHandler(c.input([link(file)])),
      'prompt_resource_denied',
      'unsafe_path',
    )
    expect(c.runs).toEqual([])
  })

  test('hard-linked aliases to outside or sensitive files are not readable under innocuous names', async () => {
    const c = control()
    const sensitive = path.join(project, '.env')
    fs.writeFileSync(sensitive, 'SECRET-DO-NOT-READ')
    for (const [index, source] of [
      path.join(outside, 'notes.txt'),
      sensitive,
    ].entries()) {
      const file = path.join(project, `hard-alias-${index}.txt`)
      fs.linkSync(source, file)
      await refused(
        c.promptHandler(c.input([link(file)])),
        'prompt_resource_denied',
        'hard_link',
      )
    }
    expect(c.runs).toEqual([])
  })

  test('directory and FIFO resources are refused; FIFO opens cannot block', async () => {
    const c = control()
    await refused(
      c.promptHandler(c.input([link(path.join(project, 'nested'))])),
      'prompt_resource_denied',
      'not_regular',
    )
    const fifo = path.join(project, 'pipe.txt')
    const made = spawnSync('mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin' } })
    expect(made.status, made.stderr.toString()).toBe(0)
    await refused(
      c.promptHandler(c.input([link(fifo)])),
      'prompt_resource_denied',
      'not_regular',
    )
    expect(c.runs).toEqual([])
  }, 2_000)

  test('a file over 1 MiB is refused before any body read', async () => {
    const c = control()
    const file = path.join(project, 'large.txt')
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x78))
    const open = fs.promises.open.bind(fs.promises)
    let reads = 0
    const observer = spyOn(fs.promises, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args)
        if (String(args[0]).endsWith('/large.txt')) {
          const read = handle.read.bind(handle)
          const body = spyOn(handle, 'read').mockImplementation(
            (...params: unknown[]) => {
              reads++
              return Reflect.apply(read, handle, params)
            },
          )
          restores.push(() => body.mockRestore())
        }
        return handle
      },
    )
    restores.push(() => observer.mockRestore())
    await refused(
      c.promptHandler(c.input([link(file)])),
      'limit_exceeded',
      'file_too_large',
    )
    expect(reads).toBe(0)
    expect(c.runs).toEqual([])
  })

  test('expanded file contents and labels count toward the 8 MiB total, not just URI sizes', async () => {
    const c = control()
    const file = path.join(project, 'one-mib.txt')
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 0x78))
    await refused(
      c.promptHandler(c.input(Array.from({ length: 8 }, () => link(file)))),
      'limit_exceeded',
      'prompt_too_large',
    )
    expect(c.runs).toEqual([])
  })

  test('invalid UTF-8 files are not silently decoded with replacement characters', async () => {
    const c = control()
    const file = path.join(project, 'invalid.txt')
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]))
    await refused(
      c.promptHandler(c.input([link(file)])),
      'invalid_prompt_content',
      'invalid_utf8',
    )
    expect(c.runs).toEqual([])
  })

  test.each([
    'https://do-not-fetch.invalid/context',
    'http://127.0.0.1:1/context',
    'notes.txt',
    'file://remote-host/notes.txt',
    'file://user@localhost/notes.txt',
    'file:////server/share/notes.txt',
  ])(
    'nonlocal or ambiguous URI %s is refused without requests',
    async (uri) => {
      const c = control()
      const fetch = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async () => {
            throw new Error('Must not request URI')
          },
          {
            preconnect() {
              throw new Error('No preconnect')
            },
          },
        ),
      )
      restores.push(() => fetch.mockRestore())
      await refused(
        c.promptHandler(
          c.input([{ type: 'resource_link', uri, name: 'untrusted' }]),
        ),
        'prompt_resource_denied',
        'invalid_uri',
      )
      expect(fetch).not.toHaveBeenCalled()
      expect(c.runs).toEqual([])
    },
  )

  test.each([
    '?',
    '?query',
    '#',
    '#fragment',
    '/nested/../notes.txt',
    '/nested/%2e%2e/notes.txt',
    '/nested/%252e%252e/notes.txt',
    '/nested%2fnotes.txt',
    '/nested%5cnotes.txt',
    '/nested/./notes.txt',
    '/bad%00name',
    '/bad%zzname',
  ])(
    'query, fragment, traversal and encoded aliases are rejected (%s)',
    async (suffix) => {
      const c = control()
      const uri = suffix.startsWith('/')
        ? `file://${project}${suffix}`
        : `${pathToFileURL(path.join(project, 'notes.txt')).href}${suffix}`
      let failure: unknown
      try {
        await c.promptHandler(
          c.input([{ type: 'resource_link', uri, name: 'alias' }]),
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(RequestError)
      expect((failure as RequestError).data).toMatchObject({
        'openbuff.dev': {
          code: 'prompt_resource_denied',
          nextStep: expect.any(String),
        },
      })
      expect(c.runs).toEqual([])
    },
  )

  test('an unavailable verified /proc backend fails closed with no lexical fallback', async () => {
    const c = control()
    const realpath = fs.promises.realpath.bind(fs.promises)
    const observer = spyOn(fs.promises, 'realpath').mockImplementation(((
      ...args: Parameters<typeof fs.promises.realpath>
    ) => {
      if (String(args[0]).startsWith('/proc/self/fd/'))
        return Promise.reject(
          Object.assign(new Error('proc unavailable'), { code: 'ENOENT' }),
        )
      return Reflect.apply(realpath, fs.promises, args)
    }) as typeof fs.promises.realpath)
    restores.push(() => observer.mockRestore())
    await refused(
      c.promptHandler(c.input([link(path.join(project, 'notes.txt'))])),
      'prompt_resource_unavailable',
      'containment_unavailable',
    )
    expect(c.runs).toEqual([])
  })
})
