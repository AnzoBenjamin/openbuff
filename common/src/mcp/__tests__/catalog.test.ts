import {
  afterAll,
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import {
  callMCPTool,
  closeMCPClient,
  getMCPClient,
  getMCPClientGeneration,
  listMCPToolCatalog,
  listMCPTools,
  markMCPConfigOrigin,
} from '../client'

const directory = mkdtempSync(join(tmpdir(), 'openbuff-mcp-catalog-'))
const active = new Set<string>()
const fixture = join(import.meta.dir, 'fixtures/mcp-catalog-server.mjs')
const emptyFixture = join(import.meta.dir, 'fixtures/mcp-empty-server.mjs')
const configuration = (mode: string, logPath?: string) => {
  const config = {
    type: 'stdio' as const,
    command: process.execPath,
    args: [
      mode === 'empty' ? emptyFixture : fixture,
      mode,
      ...(logPath ? [logPath] : []),
    ],
    env: { OPENBUFF_CATALOG_FIXTURE_ID: randomUUID() },
  }
  markMCPConfigOrigin(config, 'project')
  return config
}
async function connect(mode = 'paged', logPath?: string) {
  const config = configuration(mode, logPath)
  const clientId = await getMCPClient(config)
  active.add(clientId)
  return { config, clientId }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const schemaPage = {
  tools: [
    {
      name: 'first',
      inputSchema: { type: 'object' as const },
      outputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  ],
}
const noSchemaPage = {
  tools: [{ name: 'first', inputSchema: { type: 'object' as const } }],
}
afterEach(async () => {
  setSystemTime()
  await Promise.all([...active].map((clientId) => closeMCPClient(clientId)))
  active.clear()
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('MCP generation-bound tool catalogs over real stdio', () => {
  test('all pages retain output contracts while original error detail bypasses success validation', async () => {
    const { clientId } = await connect('output-schema')
    const catalog = await listMCPToolCatalog(clientId)
    expect(catalog.complete).toBe(true)
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['first', 'last'])
    for (const name of ['first', 'last']) {
      const good = { content: [], structuredContent: { value: 0.3 } }
      expect(
        await callMCPTool(clientId, { name, arguments: { result: good } }),
      ).toEqual([
        {
          type: 'json',
          value: { ...good, kind: 'mcp_tool_result', schemaVersion: 1 },
        },
      ])
      const failed = {
        isError: true,
        content: [
          { type: 'text', text: 'original failure detail' },
          {
            type: 'resource',
            resource: { uri: 'file:///failure.txt', text: 'resource detail' },
          },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        ],
        structuredContent: { reason: 'failed, not a success value' },
        _meta: { attempt: name },
      }
      expect(
        await callMCPTool(clientId, { name, arguments: { result: failed } }),
      ).toEqual([
        {
          type: 'json',
          value: { ...failed, kind: 'mcp_tool_result', schemaVersion: 1 },
        },
      ])
      for (const result of [
        { content: [] },
        { content: [], structuredContent: { value: 0.31 } },
        { content: [], structuredContent: { value: 0.30000000000000004 } },
      ]) {
        await expect(
          callMCPTool(clientId, { name, arguments: { result } }),
        ).rejects.toThrow(/output schema|structured content/i)
      }
    }
  }, 15_000)

  test('keeps advertised output contracts during and after a failed refresh', async () => {
    const { clientId } = await connect('output-schema')
    const original = await listMCPToolCatalog(clientId)
    expect(original.complete).toBe(true)
    let pageStarted!: () => void
    const started = new Promise<void>((resolve) => (pageStarted = resolve))
    let failPage!: (error: Error) => void
    const secondPage = new Promise<Awaited<ReturnType<Client['listTools']>>>(
      (_, reject) => (failPage = reject),
    )
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async (params) => {
        if (params?.cursor) {
          pageStarted()
          return secondPage
        }
        return {
          tools: [{ name: 'first', inputSchema: { type: 'object' } }],
          nextCursor: 'second',
        }
      },
    )
    const refresh = listMCPToolCatalog(clientId, { maxPages: 10 })
    try {
      await started
      const invalid = () =>
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        })
      await expect(invalid()).rejects.toThrow(/structured content/i)
      failPage(new Error('fixture page failed'))
      const failed = await refresh
      expect(failed.complete).toBe(false)
      expect(failed.incompleteReasons[0]).toMatch(/^request_failed/)
      expect(await listMCPToolCatalog(clientId)).toBe(original)
      await expect(invalid()).rejects.toThrow(/structured content/i)
    } finally {
      failPage(new Error('fixture page failed'))
      await refresh
      list.mockRestore()
    }
  })

  test('complete refresh atomically replaces or removes output contracts', async () => {
    const { clientId } = await connect('output-schema')
    await listMCPToolCatalog(clientId)
    const gate = deferred<Awaited<ReturnType<Client['listTools']>>>()
    const started = deferred<void>()
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async (params) => {
        if (params?.cursor) {
          started.resolve()
          return gate.promise
        }
        return { ...noSchemaPage, nextCursor: 'second' }
      },
    )
    const refresh = listMCPToolCatalog(clientId, { maxPages: 10 })
    try {
      await started.promise
      const call = () =>
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        })
      await expect(call()).rejects.toThrow(/structured content/i)
      gate.resolve({ tools: [] })
      expect((await refresh).complete).toBe(true)
      expect(await call()).toHaveLength(1)
    } finally {
      gate.resolve({ tools: [] })
      await refresh
      list.mockRestore()
    }
  })

  test('newer complete refresh supersedes older in-flight discovery and its cache', async () => {
    const { clientId } = await connect('output-schema')
    const oldPage = deferred<Awaited<ReturnType<Client['listTools']>>>()
    let requests = 0
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async () => (++requests === 1 ? oldPage.promise : schemaPage),
    )
    const older = listMCPToolCatalog(clientId)
    try {
      const newer = await listMCPToolCatalog(clientId, { maxPages: 10 })
      expect(newer.complete).toBe(true)
      oldPage.resolve(noSchemaPage)
      const stale = await older
      expect(stale.complete).toBe(false)
      expect(stale.incompleteReasons).toEqual(['superseded'])
      expect(stale.tools).toEqual([])
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        }),
      ).rejects.toThrow(/structured content/i)
      const refreshed = await listMCPToolCatalog(clientId)
      expect(refreshed.complete).toBe(true)
      expect(refreshed.tools[0].outputSchema).toEqual(
        schemaPage.tools[0].outputSchema,
      )
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: {
            result: { content: [], structuredContent: { value: 0.3 } },
          },
        }),
      ).rejects.toThrow(/output schema/i)
      expect(
        await callMCPTool(clientId, {
          name: 'first',
          arguments: {
            result: { content: [], structuredContent: { value: 'ok' } },
          },
        }),
      ).toHaveLength(1)
      expect(requests).toBe(3)
    } finally {
      oldPage.resolve(noSchemaPage)
      await older
      list.mockRestore()
    }
  })

  test('a failed newer refresh does not suppress an older successful refresh', async () => {
    const { clientId } = await connect('output-schema')
    const oldPage = deferred<Awaited<ReturnType<Client['listTools']>>>()
    let requests = 0
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async () => {
        if (++requests === 1) return oldPage.promise
        throw new Error('newer refresh failed')
      },
    )
    const older = listMCPToolCatalog(clientId)
    try {
      const newer = await listMCPToolCatalog(clientId, { maxPages: 10 })
      expect(newer.complete).toBe(false)
      oldPage.resolve(schemaPage)
      expect((await older).complete).toBe(true)
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        }),
      ).rejects.toThrow(/structured content/i)
    } finally {
      oldPage.resolve(schemaPage)
      await older
      list.mockRestore()
    }
  })

  test('a stale direct page cannot overwrite a completed catalog or remain cached', async () => {
    const { clientId } = await connect('output-schema')
    const oldPage = deferred<Awaited<ReturnType<Client['listTools']>>>()
    let requests = 0
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async () => (++requests === 1 ? oldPage.promise : schemaPage),
    )
    const page = listMCPTools(clientId)
    try {
      expect(
        (await listMCPToolCatalog(clientId, { maxPages: 10 })).complete,
      ).toBe(true)
      oldPage.resolve(noSchemaPage)
      await page
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        }),
      ).rejects.toThrow(/structured content/i)
      expect((await listMCPTools(clientId)).tools[0].outputSchema).toEqual(
        schemaPage.tools[0].outputSchema,
      )
      expect(requests).toBe(3)
    } finally {
      oldPage.resolve(noSchemaPage)
      await page
      list.mockRestore()
    }
  })

  test('cancelled discovery cannot publish a late page that ignores its signal', async () => {
    const { clientId } = await connect('output-schema')
    await listMCPToolCatalog(clientId)
    const gate = deferred<Awaited<ReturnType<Client['listTools']>>>()
    const started = deferred<void>()
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async () => {
        started.resolve()
        return gate.promise
      },
    )
    const controller = new AbortController()
    const refresh = listMCPToolCatalog(clientId, { signal: controller.signal })
    try {
      await started.promise
      controller.abort()
      expect((await refresh).incompleteReasons).toEqual(['cancelled'])
      gate.resolve(noSchemaPage)
      await gate.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        }),
      ).rejects.toThrow(/structured content/i)
    } finally {
      gate.resolve(noSchemaPage)
      await refresh
      list.mockRestore()
    }
  })

  test('page and tool limits leave the previously advertised contracts intact', async () => {
    const { clientId } = await connect('output-schema')
    await listMCPToolCatalog(clientId)
    const list = spyOn(Client.prototype, 'listTools').mockResolvedValue({
      ...noSchemaPage,
      nextCursor: 'second',
    })
    try {
      expect(
        (await listMCPToolCatalog(clientId, { maxPages: 1 })).incompleteReasons,
      ).toEqual(['page_limit'])
      expect(
        (await listMCPToolCatalog(clientId, { maxTools: 0 })).incompleteReasons,
      ).toEqual(['tool_limit'])
      await expect(
        callMCPTool(clientId, {
          name: 'first',
          arguments: { result: { content: [] } },
        }),
      ).rejects.toThrow(/structured content/i)
    } finally {
      list.mockRestore()
    }
  })

  test('a completed option-bearing refresh invalidates an older cached catalog', async () => {
    const { clientId } = await connect('output-schema')
    const original = await listMCPToolCatalog(clientId)
    const list = spyOn(Client.prototype, 'listTools').mockResolvedValue(
      schemaPage,
    )
    try {
      expect(
        (await listMCPToolCatalog(clientId, { maxPages: 10 })).complete,
      ).toBe(true)
      const current = await listMCPToolCatalog(clientId)
      expect(current).not.toBe(original)
      expect(current.tools[0].outputSchema).toEqual(
        schemaPage.tools[0].outputSchema,
      )
      expect(list).toHaveBeenCalledTimes(2)
    } finally {
      list.mockRestore()
    }
  })

  test('a late stale refresh cannot overwrite the next generation contract', async () => {
    const { clientId } = await connect()
    const gate = deferred<Awaited<ReturnType<Client['listTools']>>>()
    let requests = 0
    const list = spyOn(Client.prototype, 'listTools').mockImplementation(
      async () => (++requests === 2 ? gate.promise : schemaPage),
    )
    let stale: ReturnType<typeof listMCPToolCatalog> | undefined
    try {
      const original = await listMCPToolCatalog(clientId)
      stale = listMCPToolCatalog(clientId, { maxPages: 10 })
      await callMCPTool(clientId, { name: 'notify', arguments: {} })
      expect((await stale).incompleteReasons).toEqual(['generation_changed'])
      const current = await listMCPToolCatalog(clientId)
      expect(current.complete).toBe(true)
      expect(current.generation).not.toBe(original.generation)
      gate.resolve(noSchemaPage)
      await gate.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(
        callMCPTool(clientId, { name: 'first', arguments: {} }),
      ).rejects.toThrow(/structured content/i)
    } finally {
      gate.resolve(noSchemaPage)
      await stale
      list.mockRestore()
    }
  })

  test('traverses every page and memoizes a complete catalog in one generation', async () => {
    const { clientId } = await connect()
    const first = listMCPToolCatalog(clientId)
    expect(listMCPToolCatalog(clientId)).toBe(first)
    const catalog = await first
    expect(catalog.complete).toBe(true)
    expect(catalog.incompleteReasons).toEqual([])
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['first', 'last'])
    expect(catalog.generation).toBe(getMCPClientGeneration(clientId))
    expect(catalog.origin).toBe('project')
    expect(catalog.tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string', pattern: '^/api/v1$' } },
      additionalProperties: false,
    })
    expect(await listMCPToolCatalog(clientId)).toBe(catalog)
  })

  for (const [mode, reason] of [
    ['loop', 'cursor_loop'],
    ['conflict', 'duplicate_tool_conflict'],
    ['fail', 'request_failed'],
  ] as const) {
    test(`returns explicit partial status for ${mode}`, async () => {
      const { clientId } = await connect(mode)
      const catalog = await listMCPToolCatalog(clientId)
      expect(catalog.complete).toBe(false)
      expect(
        catalog.incompleteReasons.some((value) => value.startsWith(reason)),
      ).toBe(true)
      const retry = await listMCPToolCatalog(clientId)
      expect(retry).not.toBe(catalog)
      expect(retry.complete).toBe(false)
    })
  }

  test('deduplicates identical names without fabricating conflicts', async () => {
    const { clientId } = await connect('identical')
    const catalog = await listMCPToolCatalog(clientId)
    expect(catalog.complete).toBe(true)
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['first', 'last'])
  })

  test('reports page/tool limits with the observed prefix', async () => {
    const { clientId } = await connect()
    const pages = await listMCPToolCatalog(clientId, { maxPages: 1 })
    expect(pages.complete).toBe(false)
    expect(pages.incompleteReasons).toEqual(['page_limit'])
    expect(pages.tools.map((tool) => tool.name)).toEqual(['first'])
    const tools = await listMCPToolCatalog(clientId, { maxTools: 1 })
    expect(tools.complete).toBe(false)
    expect(tools.incompleteReasons).toEqual(['tool_limit'])
    expect(tools.tools.map((tool) => tool.name)).toEqual(['first'])
  })

  test('bounds the whole traversal deadline, including a stalled later page', async () => {
    const { clientId } = await connect('slow-page')
    const started = performance.now()
    const catalog = await listMCPToolCatalog(clientId, { timeoutMs: 35 })
    expect(performance.now() - started).toBeLessThan(500)
    expect(catalog.complete).toBe(false)
    expect(catalog.incompleteReasons).toEqual(['deadline_exceeded'])
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['first'])
  })

  test('keeps caller cancellation independent from another discovery', async () => {
    const { clientId } = await connect('slow')
    const controller = new AbortController()
    const cancelled = listMCPToolCatalog(clientId, {
      signal: controller.signal,
    })
    const healthy = listMCPToolCatalog(clientId)
    controller.abort()
    expect((await cancelled).incompleteReasons).toEqual(['cancelled'])
    expect((await healthy).complete).toBe(true)
    const beforeStart = await listMCPToolCatalog(clientId, {
      signal: controller.signal,
    })
    expect(beforeStart.complete).toBe(false)
    expect(beforeStart.incompleteReasons).toEqual(['cancelled'])
  })

  test('list_changed invalidates both page and catalog caches and advances generation', async () => {
    const { clientId } = await connect()
    const page = listMCPTools(clientId)
    await page
    const catalog = await listMCPToolCatalog(clientId)
    const generation = catalog.generation!
    await callMCPTool(clientId, { name: 'notify', arguments: {} })
    expect(getMCPClientGeneration(clientId)).toBeGreaterThan(generation)
    const newPage = listMCPTools(clientId)
    expect(newPage).not.toBe(page)
    expect((await newPage).tools[0].name).toBe('first-v1')
    const fresh = await listMCPToolCatalog(clientId)
    expect(fresh.complete).toBe(true)
    expect(fresh.tools.map((tool) => tool.name)).toEqual([
      'first-v1',
      'last-v1',
    ])
    expect(fresh.generation).not.toBe(catalog.generation)
  })

  test('refuses mixed generations when list_changed occurs between pages', async () => {
    const { clientId } = await connect('notify-page')
    const catalog = await listMCPToolCatalog(clientId)
    expect(catalog.complete).toBe(false)
    expect(catalog.incompleteReasons).toEqual(['generation_changed'])
    expect(catalog.tools).toEqual([])
    const fresh = await listMCPToolCatalog(clientId)
    expect(fresh.complete).toBe(true)
    expect(fresh.tools.map((tool) => tool.name)).toEqual([
      'first-v1',
      'last-v1',
    ])
  })

  test('catches initialization-time list_changed because handlers precede connect', async () => {
    const { clientId } = await connect('early-notify')
    const first = await listMCPToolCatalog(clientId)
    const catalog = first.complete ? first : await listMCPToolCatalog(clientId)
    expect(catalog.complete).toBe(true)
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'first-v1',
      'last-v1',
    ])
    expect(catalog.generation).toBe(getMCPClientGeneration(clientId))
  })

  test('disconnect clears registry state and cannot return a partial catalog as complete', async () => {
    const { clientId, config } = await connect('disconnect')
    const previous = getMCPClientGeneration(clientId)!
    const catalog = await listMCPToolCatalog(clientId)
    expect(catalog.complete).toBe(false)
    expect(catalog.incompleteReasons).toEqual(['connection_closed'])
    expect(catalog.tools).toEqual([])
    expect(getMCPClientGeneration(clientId)).toBeUndefined()
    const replacement = await getMCPClient(config)
    expect(replacement).toBe(clientId)
    expect(getMCPClientGeneration(replacement)).toBeGreaterThan(previous)
  })

  test('old in-flight rejection cannot erase a replacement client page cache', async () => {
    const { clientId, config } = await connect('slow')
    const previous = getMCPClientGeneration(clientId)!
    const oldPage = listMCPTools(clientId)
    const rejection = oldPage.catch((error) => error)
    await closeMCPClient(clientId)
    expect(getMCPClientGeneration(clientId)).toBeUndefined()
    await getMCPClient(config)
    expect(getMCPClientGeneration(clientId)).toBeGreaterThan(previous)
    const replacement = listMCPTools(clientId)
    expect(await rejection).toBeInstanceOf(Error)
    expect(listMCPTools(clientId)).toBe(replacement)
    expect((await replacement).tools[0].name).toBe('first')
  })

  test('successful caches expire for peers that never notify', async () => {
    const { clientId } = await connect()
    const page = listMCPTools(clientId)
    await page
    const catalog = await listMCPToolCatalog(clientId)
    setSystemTime(Date.now() + 31_000)
    expect(listMCPTools(clientId)).not.toBe(page)
    expect(await listMCPToolCatalog(clientId)).not.toBe(catalog)
  })

  test('eviction closes transports and the real child exits within a bounded wait', async () => {
    const logPath = join(directory, 'eviction.jsonl')
    const { clientId } = await connect('paged', logPath)
    for (let index = 0; index < 64; index++) await connect('empty')
    expect(getMCPClientGeneration(clientId)).toBeUndefined()
    // SDK close resolves after initiating termination; OS exit is asynchronous.
    const exitDeadline = performance.now() + 2000
    while (
      !readFileSync(logPath, 'utf8').includes('"event":"closed"') &&
      performance.now() < exitDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const events = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(['started', 'closed'])
  }, 30_000)

  test('eviction preserves a real active request while closing an idle peer', async () => {
    const activeLog = join(directory, `held-${randomUUID()}.jsonl`)
    const idleLog = join(directory, `idle-${randomUUID()}.jsonl`)
    const held = await connect('held', activeLog)
    const idle = await connect('paged', idleLog)
    const pending = listMCPTools(held.clientId)
    // Attach a rejection handler immediately so an unexpected close is observed
    // by the assertion below rather than becoming an unhandled rejection.
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const deadline = performance.now() + 10_000
    while (
      !readFileSync(activeLog, 'utf8').includes('list:first') &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    const activeEvents = readFileSync(activeLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(activeEvents.map((event) => event.event)).toContain('list:first')
    const activePid = activeEvents[0].pid as number

    try {
      for (let index = 0; index < 63; index++) await connect('empty')
      expect(getMCPClientGeneration(held.clientId)).toBeDefined()
      expect(getMCPClientGeneration(idle.clientId)).toBeUndefined()
      const exitDeadline = performance.now() + 2000
      while (
        !readFileSync(idleLog, 'utf8').includes('"event":"closed"') &&
        performance.now() < exitDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(readFileSync(idleLog, 'utf8')).toContain('"event":"closed"')
      expect(() => process.kill(activePid, 0)).not.toThrow()
      expect(readFileSync(activeLog, 'utf8')).not.toContain('"event":"closed"')
    } finally {
      writeFileSync(`${activeLog}.release`, '')
    }
    const result = await outcome
    expect('error' in result ? result.error : undefined).toBeUndefined()
    expect('value' in result && result.value.tools[0].name).toBe('first')
    expect(readFileSync(activeLog, 'utf8')).toContain('"event":"list:released"')
  }, 30_000)

  test('missing clients and invalid limits return explicit incomplete status', async () => {
    expect(
      (await listMCPToolCatalog('missing-client')).incompleteReasons,
    ).toEqual(['client_not_found'])
    const { clientId } = await connect()
    expect(
      (await listMCPToolCatalog(clientId, { maxPages: -1 })).incompleteReasons,
    ).toEqual(['invalid_limit: maxPages'])
  })
})
