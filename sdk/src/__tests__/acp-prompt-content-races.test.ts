import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RequestError } from '@agentclientprotocol/sdk'

import { createServeBridge } from '../serve/bridge'
import { createAcpAgent } from '../services/acp/acp-agent'
import { AcpSessionData } from '../services/acp/session-data'
import type { OpenbuffClientOptions, RunOptions } from '../run'

const linux = process.platform === 'linux' ? describe : describe.skip
let root: string, project: string, outside: string
const restores: Array<() => void> = []
const home = process.env.HOME
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'acp-content-race-')),
  )
  project = path.join(root, 'project')
  outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(project, 'nested'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(
    path.join(project, 'nested', 'notes.txt'),
    'CAPTURED-PROJECT-BYTES',
  )
  fs.writeFileSync(
    path.join(outside, 'notes.txt'),
    'OUTSIDE-MUST-NOT-REACH-RUN',
  )
})
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
function control() {
  const runs: Array<RunOptions & OpenbuffClientOptions> = []
  const sessionData = new AcpSessionData()
  const { promptHandler } = createServeBridge({
    projectRoot: project,
    sessionData,
    client: {
      async run(options) {
        runs.push(options)
        return { output: { type: 'lastMessage', value: [] } }
      },
    },
  })
  const agent = createAcpAgent({
    projectRoot: project,
    promptHandler,
    connection: { sessionUpdate: async () => {} },
  })
  const prompt = [
    {
      type: 'resource_link' as const,
      uri: pathToFileURL(path.join(project, 'nested', 'notes.txt')).href,
      name: 'notes.txt',
    },
  ]
  return { runs, agent, prompt, sessionData }
}
async function errorData(pending: unknown) {
  let failure: unknown
  try {
    await pending
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(RequestError)
  return (failure as RequestError).data as Record<
    string,
    { code: string; reason: string; nextStep: string }
  >
}
function observeOpen(
  callback: (
    file: string,
    handle: fs.promises.FileHandle,
    flags: number | string,
  ) => Promise<void> | void,
) {
  const actual = fs.promises.open.bind(fs.promises)
  const observer = spyOn(fs.promises, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await actual(...args)
      await callback(String(args[0]), handle, args[1] ?? fs.constants.O_RDONLY)
      return handle
    },
  )
  restores.push(() => observer.mockRestore())
}

linux('ACP resource descriptor and cancellation controls', () => {
  test('all body/directory opens use no-follow and nonblocking flags relative to held parents', async () => {
    const c = control()
    const opens: Array<{ file: string; flags: number }> = []
    const handles: fs.promises.FileHandle[] = []
    observeOpen((file, handle, flags) => {
      opens.push({ file, flags: Number(flags) })
      handles.push(handle)
    })
    const { sessionId } = await c.agent.newSession({
      cwd: project,
      mcpServers: [],
    })
    await c.agent.prompt({ sessionId, prompt: c.prompt })
    expect(c.runs[0].prompt).toContain('CAPTURED-PROJECT-BYTES')
    expect(opens.length).toBeGreaterThanOrEqual(3)
    for (const { flags } of opens) {
      expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
      expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK)
    }
    expect(opens[0].flags & fs.constants.O_DIRECTORY).toBe(
      fs.constants.O_DIRECTORY,
    )
    expect(
      opens
        .slice(1)
        .every(({ file }) => /^\/proc\/self\/fd\/\d+\/[^/]+$/.test(file)),
    ).toBe(true)
    for (const handle of handles) expect(handle.fd).toBe(-1)
  })

  test.each(['parent', 'final'])(
    'an open-time %s symlink replacement cannot disclose outside bytes',
    async (kind) => {
      const c = control()
      const actual = fs.promises.open.bind(fs.promises)
      let attacked = false
      const observer = spyOn(fs.promises, 'open').mockImplementation(
        async (...args: Parameters<typeof fs.promises.open>) => {
          const file = String(args[0])
          if (
            !attacked &&
            file.endsWith(kind === 'parent' ? '/nested' : '/notes.txt')
          ) {
            attacked = true
            if (kind === 'parent') {
              fs.renameSync(
                path.join(project, 'nested'),
                path.join(project, 'held'),
              )
              fs.symlinkSync(outside, path.join(project, 'nested'))
            } else {
              fs.unlinkSync(path.join(project, 'nested', 'notes.txt'))
              fs.symlinkSync(
                path.join(outside, 'notes.txt'),
                path.join(project, 'nested', 'notes.txt'),
              )
            }
          }
          return actual(...args)
        },
      )
      restores.push(() => observer.mockRestore())
      const { sessionId } = await c.agent.newSession({
        cwd: project,
        mcpServers: [],
      })
      const data = await errorData(
        c.agent.prompt({ sessionId, prompt: c.prompt }),
      )
      expect(attacked).toBe(true)
      expect(data['openbuff.dev']).toMatchObject({
        code: 'prompt_resource_denied',
        reason: 'unsafe_path',
      })
      expect(c.runs).toEqual([])
    },
  )

  test('renaming a held parent outside the root fails capture identity checks, not a lexical reopen', async () => {
    const c = control()
    let attacked = false
    observeOpen((file) => {
      if (file.endsWith('/nested')) {
        attacked = true
        fs.renameSync(path.join(project, 'nested'), path.join(outside, 'moved'))
        fs.symlinkSync(outside, path.join(project, 'nested'))
      }
    })
    const { sessionId } = await c.agent.newSession({
      cwd: project,
      mcpServers: [],
    })
    const data = await errorData(
      c.agent.prompt({ sessionId, prompt: c.prompt }),
    )
    expect(attacked).toBe(true)
    expect(data['openbuff.dev']).toMatchObject({
      code: 'prompt_resource_denied',
      reason: 'file_changed',
    })
    expect(c.runs).toEqual([])
  })

  test('same-inode mutation during a capture is rejected by post-read size/timestamp checks', async () => {
    const c = control()
    let attacked = false
    observeOpen((file, handle) => {
      if (file.endsWith('/notes.txt')) {
        const actualRead = handle.read.bind(handle)
        const observer = spyOn(handle, 'read').mockImplementation(
          async (...args: unknown[]) => {
            const result = await Reflect.apply(actualRead, handle, args)
            if (!attacked) {
              attacked = true
              fs.writeFileSync(
                path.join(project, 'nested', 'notes.txt'),
                'x'.repeat(Buffer.byteLength('CAPTURED-PROJECT-BYTES')),
              )
            }
            return result
          },
        )
        restores.push(() => observer.mockRestore())
      }
    })
    const { sessionId } = await c.agent.newSession({
      cwd: project,
      mcpServers: [],
    })
    const data = await errorData(
      c.agent.prompt({ sessionId, prompt: c.prompt }),
    )
    expect(attacked).toBe(true)
    expect(data['openbuff.dev']).toMatchObject({
      code: 'prompt_resource_denied',
      reason: 'file_changed',
    })
    expect(c.runs).toEqual([])
  })

  test('cancel during an asynchronous file open closes every descriptor and never starts the SDK', async () => {
    const c = control()
    let release: () => void = () => {}
    let opened: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      opened = resolve
    })
    const handles: fs.promises.FileHandle[] = []
    let reads = 0
    observeOpen(async (file, handle) => {
      handles.push(handle)
      if (file.endsWith('/notes.txt')) {
        const actualRead = handle.read.bind(handle)
        const read = spyOn(handle, 'read').mockImplementation(
          (...args: unknown[]) => {
            reads++
            return Reflect.apply(actualRead, handle, args)
          },
        )
        restores.push(() => read.mockRestore())
        opened()
        await gate
      }
    })
    const { sessionId } = await c.agent.newSession({
      cwd: project,
      mcpServers: [],
    })
    const pending = Promise.resolve(
      c.agent.prompt({ sessionId, prompt: c.prompt }),
    )
    try {
      await Promise.race([
        arrived,
        pending.then(() => {
          throw new Error('Turn started without opening its resource')
        }),
      ])
      c.agent.cancel({ sessionId })
    } finally {
      release()
    }
    expect(await pending).toEqual({ stopReason: 'cancelled' })
    expect(reads).toBe(0)
    expect(c.runs).toEqual([])
    for (const handle of handles) expect(handle.fd).toBe(-1)
    // The agent also releases the per-session in-flight guard after cancellation.
    await c.agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'next turn' }],
    })
    expect(c.runs).toHaveLength(1)
    expect(c.runs[0].prompt).toBe('next turn')
  })
})
