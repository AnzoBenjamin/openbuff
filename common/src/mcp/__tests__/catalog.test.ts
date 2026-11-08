import {
  afterAll,
  afterEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
