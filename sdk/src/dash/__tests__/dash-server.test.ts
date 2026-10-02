import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { exportDashStatic, isInsideOutDir } from '../export'
import { createDashProviderFromJournal } from '../provider'
import {
  DASH_MAX_EVENTS,
  renderDashHtml,
  startDashServer,
} from '../server'
import type { DashDataProvider } from '../server'
import type {
  JournalEventRow,
  JournalReader,
} from '@codebuff/common/types/contracts/agent-runtime'

const TOKEN = 'test-token-1234'

function staticProvider(
  overrides: Partial<DashDataProvider> = {},
): DashDataProvider {
  return {
    listRuns: async () => [
      { runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z', eventCount: 2 },
    ],
    getRunEvents: async () => [
      {
        seq: 0,
        eventType: 'llm_request',
        createdAt: '2026-01-01T00:00:00.000Z',
        payloadSummary: '{}',
      },
    ],
    getReceipts: async () => [{ id: 'r1' }],
    getGateState: async () => ({ open: true }),
    ...overrides,
  }
}

function fakeJournalReader(
  eventsByRun: Record<string, JournalEventRow[]>,
): JournalReader & { runIds: () => string[] } {
  return {
    runIds: () => Object.keys(eventsByRun),
    lastEvent: (runId) => {
      const events = eventsByRun[runId]
      return events?.length ? events[events.length - 1] : undefined
    },
    events: (runId) => eventsByRun[runId] ?? [],
    toolResultFor: () => undefined,
    toolResultForInput: () => undefined,
  }
}

async function startTestServer(data: DashDataProvider, token = TOKEN) {
  const server = await startDashServer({ port: 0, token, data })
  // The server binds a random free port; derive the base origin from the
  // handle URL (which carries ?token=) instead of assuming any port.
  const origin = new URL(server.url).origin
  return {
    ...server,
    fetch: async (
      pathname: string,
      init: { headers?: Record<string, string>; tokenQuery?: string } = {},
    ) => {
      const url = `${origin}${pathname}${init.tokenQuery ? `?token=${init.tokenQuery}` : ''}`
      const headers = new Headers(init.headers)
      return fetch(url, { headers })
    },
  }
}

describe('startDashServer auth', () => {
  test('rejects an empty expected token (an auth bypass: sha256("") === sha256(""))', async () => {
    await expect(
      startDashServer({
        port: 0,
        token: '',
        data: staticProvider(),
      }),
    ).rejects.toThrow(/token must be a nonempty string/)
    // Whitespace-only is equally an auth bypass and is rejected too.
    await expect(
      startDashServer({
        port: 0,
        token: '   ',
        data: staticProvider(),
      }),
    ).rejects.toThrow(/token must be a nonempty string/)
  })

  test('401 without any token', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/api/runs')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    } finally {
      await server.close()
    }
  })

  test('401 with a WRONG token (both transport shapes)', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const bearer = await server.fetch('/api/runs', {
        headers: { Authorization: `Bearer wrong` },
      })
      expect(bearer.status).toBe(401)
      const query = await server.fetch('/api/runs', { tokenQuery: 'wrong' })
      expect(query.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  test('200 with a bearer token', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/api/runs', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ runId: string }>
      expect(body).toHaveLength(1)
      expect(body[0].runId).toBe('run-1')
    } finally {
      await server.close()
    }
  })

  test('200 with a ?token= query param', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/api/receipts', {
        tokenQuery: encodeURIComponent(TOKEN),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([{ id: 'r1' }])
    } finally {
      await server.close()
    }
  })

  test('/healthz needs no auth and returns 200', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/healthz')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await server.close()
    }
  })

  test('the served HTML never embeds the token', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('openbuff dash')
      expect(html).not.toContain(TOKEN)
    } finally {
      await server.close()
    }
  })

  test('binds to 127.0.0.1 only (handle URL is loopback)', async () => {
    const server = await startTestServer(staticProvider())
    try {
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

describe('startDashServer routes', () => {
  test('runId validation: a hostile runId is a 400', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const headers = { Authorization: `Bearer ${TOKEN}` }
      for (const runId of ['..%2Fetc', 'a%2Fb', 'has%20space']) {
        const res = await server.fetch(`/api/runs/${runId}/events`, { headers })
        expect(res.status).toBe(400)
      }
    } finally {
      await server.close()
    }
  })

  test('unknown route is a 404 and non-GET is a 405', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const headers = { Authorization: `Bearer ${TOKEN}` }
      expect((await server.fetch('/nope', { headers })).status).toBe(404)
      // The handle URL carries the bound port; reuse its origin for POST.
      const origin = new URL(server.url).origin
      const res = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers,
      })
      expect(res.status).toBe(405)
    } finally {
      await server.close()
    }
  })

  test('/api/gate returns the gate state', async () => {
    const server = await startTestServer(staticProvider())
    try {
      const res = await server.fetch('/api/gate', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ open: true })
    } finally {
      await server.close()
    }
  })

  test('events are bounded to the LATEST 2000', async () => {
    const total = DASH_MAX_EVENTS + 500
    const provider = staticProvider({
      getRunEvents: async () =>
        Array.from({ length: total }, (_, i) => ({
          seq: i,
          eventType: 'tool_call',
          createdAt: '2026-01-01T00:00:00.000Z',
          payloadSummary: `event-${i}`,
        })),
    })
    const server = await startTestServer(provider)
    try {
      const res = await server.fetch('/api/runs/run-1/events', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ seq: number }>
      expect(body).toHaveLength(DASH_MAX_EVENTS)
      // The LATEST 2000 win: the first served seq is the first dropped one.
      expect(body[0].seq).toBe(total - DASH_MAX_EVENTS)
      expect(body[body.length - 1].seq).toBe(total - 1)
    } finally {
      await server.close()
    }
  })
})

describe('createDashProviderFromJournal', () => {
  test('groups a fake JournalReader into runs and bounds payloadSummary', async () => {
    const events: JournalEventRow[] = [
      {
        seq: 0,
        stepNumber: 0,
        eventType: 'llm_request',
        correlation: 'c1',
        createdAt: 1704067200000,
        payload: { model: 'x', messages: ['a'.repeat(500)] },
      },
      {
        seq: 1,
        stepNumber: 0,
        eventType: 'tool_call',
        correlation: 'c2',
        createdAt: 1704067201000,
        payload: { toolName: 'read_files', input: { paths: ['a.ts'] } },
      },
    ]
    const provider = createDashProviderFromJournal({
      journalReader: fakeJournalReader({ 'run-A': events }),
    })
    const runs = await provider.listRuns()
    // startedAt is the REAL first-event timestamp, never a seq label.
    expect(runs).toEqual([
      { runId: 'run-A', startedAt: '2024-01-01T00:00:00.000Z', eventCount: 2 },
    ])

    const runEvents = await provider.getRunEvents('run-A')
    expect(runEvents).toHaveLength(2)
    expect(runEvents[0].eventType).toBe('llm_request')
    expect(runEvents[0].seq).toBe(0)
    // createdAt is the REAL event timestamp, never a seq label.
    expect(runEvents[0].createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(runEvents[1].createdAt).toBe('2024-01-01T00:00:01.000Z')
    // Bounded summary: JSON.stringify truncated to 300 chars + '...'.
    expect(runEvents[0].payloadSummary.length).toBe(303)
    expect(runEvents[0].payloadSummary.endsWith('...')).toBe(true)
    expect(runEvents[1].payloadSummary).toBe(
      '{"toolName":"read_files","input":{"paths":["a.ts"]}}',
    )
  })

  test('without a journalReader, runs/events are empty arrays', async () => {
    const provider = createDashProviderFromJournal({
      receipts: () => [{ id: 'r' }],
      gateState: () => ({ open: false }),
    })
    expect(await provider.listRuns()).toEqual([])
    expect(await provider.getRunEvents('anything')).toEqual([])
    expect(await provider.getReceipts()).toEqual([{ id: 'r' }])
    expect(await provider.getGateState()).toEqual({ open: false })
  })

  test('runs without journal timestamps omit startedAt/createdAt (never a synthetic seq label)', async () => {
    const events: JournalEventRow[] = [
      {
        seq: 0,
        stepNumber: 0,
        eventType: 'llm_request',
        correlation: 'c1',
        payload: {},
      },
    ]
    const provider = createDashProviderFromJournal({
      journalReader: fakeJournalReader({ 'run-bare': events }),
    })
    const runs = await provider.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.startedAt).toBeUndefined()
    const runEvents = await provider.getRunEvents('run-bare')
    expect(runEvents[0]!.createdAt).toBeUndefined()
  })
})

describe('isInsideOutDir', () => {
  test('an outDir that resolves to a filesystem root is contained (no false reject)', () => {
    // The root of a real directory: '/' on POSIX, 'C:\\' on Windows.
    const root = path.parse(path.resolve(tmpdir())).root
    expect(
      isInsideOutDir(root, path.join(root, 'dash-abc', 'index.html')),
    ).toBe(true)
    // The root itself is trivially contained too.
    expect(isInsideOutDir(root, root)).toBe(true)
  })

  test('a non-root outDir still accepts its own subtree and rejects escapes', () => {
    const outDir = path.resolve(tmpdir())
    expect(
      isInsideOutDir(outDir, path.join(outDir, 'dash-abc', 'runs.json')),
    ).toBe(true)
    expect(isInsideOutDir(outDir, path.join(outDir, '..', 'escape.txt'))).toBe(
      false,
    )
  })
})

describe('exportDashStatic', () => {
  test('writes the five files with the data inlined and no external assets', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'dash-export-test-'))
    try {
      const outDir = path.join(parent, 'site')
      const result = await exportDashStatic({
        outDir,
        data: staticProvider(),
        token: TOKEN,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files).toHaveLength(5)
      expect(result.files.map((f) => path.basename(f))).toEqual([
        'index.html',
        'runs.json',
        'events.json',
        'receipts.json',
        'gate.json',
      ])

      const html = await readFile(result.files[0], 'utf8')
      // The data is INLINED as the JSON blob (works offline).
      expect(html).toContain('window.__DASH_DATA__')
      expect(html).toContain('"runId":"run-1"')
      // NEVER the token, even though one was passed.
      expect(html).not.toContain(TOKEN)
      // No external asset references: everything is inline.
      expect(html).not.toMatch(/<script[^>]+src=/i)
      expect(html).not.toMatch(/<link[^>]+href=/i)
      // All files stay inside outDir.
      for (const file of result.files) {
        expect(file.startsWith(path.resolve(outDir) + path.sep)).toBe(true)
      }

      const runsJson = JSON.parse(await readFile(result.files[1], 'utf8'))
      expect(runsJson).toHaveLength(1)
      expect(runsJson[0].runId).toBe('run-1')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('a provider returning undefined for receipts/gate persists null (never the invalid text "undefined")', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'dash-export-undef-'))
    try {
      const result = await exportDashStatic({
        outDir: path.join(parent, 'site'),
        data: staticProvider({
          getReceipts: async () => undefined as unknown as unknown[],
          getGateState: async () => undefined,
        }),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // receipts.json and gate.json must contain parseable JSON, not the
      // bare JSON.stringify(undefined) text 'undefined'.
      const receiptsText = await readFile(result.files[3], 'utf8')
      const gateText = await readFile(result.files[4], 'utf8')
      expect(receiptsText.trim()).toBe('null')
      expect(gateText.trim()).toBe('null')
      expect(JSON.parse(receiptsText)).toBeNull()
      expect(JSON.parse(gateText)).toBeNull()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('renderDashHtml inlines the blob and escapes </script-breaking <', async () => {
    const snapshot = {
      runs: [],
      events: { 'r<x>': [] },
      receipts: [{ note: '<script>alert(1)</script>' }],
      gate: null,
    }
    const html = renderDashHtml(snapshot)
    expect(html).toContain('window.__DASH_DATA__')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('<script>alert(1)</script>'.replace(/</g, '\\u003c'))
    // Server-mode page still fetches (no inline blob).
    expect(renderDashHtml()).not.toContain('window.__DASH_DATA__')
  })
})
