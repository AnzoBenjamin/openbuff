import vm from 'node:vm'

import { describe, expect, test } from 'bun:test'

import { renderDashHtml } from '../server'

// Execute the shipped page script with controlled responses. This checks its
// selection/response boundary without sockets, journals or a browser session.
class Element {
  children: Element[] = []
  attributes: Record<string, string> = {}
  listeners: Record<string, () => void> = {}
  dataset: Record<string, string> = {}
  className = ''
  value = ''
  scrollTop = 0
  private text = ''

  constructor(readonly tag = 'div') {}
  set textContent(value: string) {
    this.text = String(value)
    this.children = []
  }
  get textContent() {
    return this.text
  }
  appendChild(child: Element) {
    this.children.push(child)
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners[name] = listener
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ])
  }
}

type PendingResponse = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function createPage(
  options: {
    eventCount?: number
    runs?: Array<{ runId: string; eventCount: number }>
    source?: { state: string; message?: string }
    receipts?: unknown[]
    gate?: unknown
  } = {},
) {
  const nodes = Object.fromEntries(
    [
      'run-list',
      'event-rows',
      'timeline-status',
      'receipts',
      'gate',
      'freshness',
      'source-status',
      'runs-status',
      'selected-run',
      'timeline-viewport',
      'refresh-all',
      'refresh-timeline',
      'refresh-receipts',
      'refresh-gate',
      'event-find',
      'receipts-find',
      'gate-find',
      'receipts-status',
      'gate-status',
    ].map((id) => [id, new Element()]),
  )
  const pending: Record<string, PendingResponse[]> = {}
  const response = (data: unknown) => ({ ok: true, json: async () => data })
  const fetch = (url: string) => {
    if (url === '/api/runs')
      return Promise.resolve(
        response(
          options.runs ?? [
            { runId: 'A', eventCount: options.eventCount ?? 1 },
            { runId: 'B', eventCount: 1 },
          ],
        ),
      )
    if (url === '/api/receipts')
      return Promise.resolve(response(options.receipts ?? []))
    if (url === '/api/gate')
      return Promise.resolve(response(options.gate ?? null))
    if (url === '/api/source')
      return Promise.resolve(response(options.source ?? { state: 'available' }))
    return new Promise((resolve, reject) => {
      ;(pending[url] ??= []).push({
        resolve: (data) => resolve(response(data)),
        reject,
      })
    })
  }
  const script = [
    ...renderDashHtml().matchAll(/<script>([\s\S]*?)<\/script>/g),
  ][1]![1]!
  vm.runInNewContext(script, {
    window: {},
    location: { search: '' },
    URLSearchParams,
    Date,
    document: {
      getElementById: (id: string) => nodes[id],
      createElement: (tag: string) => new Element(tag),
    },
    fetch,
  })
  await flush()
  return {
    nodes,
    pending,
    buttons: nodes['run-list']!.querySelectorAll('button'),
  }
}

const event = (eventType: string) => [
  { seq: 1, eventType, payloadSummary: eventType },
]

describe('dashboard selected-run ownership', () => {
  test('5000 source events disclose the latest-2000 capture range and preserve it during find', async () => {
    const page = await createPage({ eventCount: 5000 })
    page.pending['/api/runs/A/events']![0]!.resolve(
      Array.from({ length: 2000 }, (_, index) => ({
        seq: index + 3000,
        eventType: 'tool_result',
        payloadSummary: `capture ${index}`,
      })),
    )
    await flush()
    expect(page.nodes['timeline-status']!.textContent).toContain(
      '2000 latest captured events of 5000 · sequence 3000–4999',
    )
    expect(page.nodes['timeline-status']!.textContent).toContain(
      'Older events are not included',
    )
    page.nodes['event-find']!.value = 'capture 1999'
    page.nodes['event-find']!.listeners.input!()
    expect(page.nodes['event-rows']!.children).toHaveLength(1)
    expect(page.nodes['timeline-status']!.textContent).toContain(
      'Find: 1 matches',
    )
    page.nodes['event-find']!.value = ''
    page.nodes['event-find']!.listeners.input!()
    expect(page.nodes['timeline-status']!.textContent).toContain(
      '2000 latest captured events of 5000',
    )
    expect(page.nodes['timeline-status']!.textContent).not.toContain('Find:')
  })
  test('unavailable source is distinct from an empty archive', async () => {
    const page = await createPage({
      runs: [],
      source: { state: 'unavailable', message: 'Check local file access.' },
    })
    expect(page.nodes['source-status']!.textContent).toContain(
      'Journal unavailable',
    )
    expect(page.nodes['source-status']!.className).toBe('status error')
    expect(page.nodes['run-list']!.children[0]?.textContent).not.toBe(
      'No journaled runs.',
    )
  })
  test('gate and receipt outcome/path summaries use native detail controls', async () => {
    const page = await createPage({
      receipts: [{ status: 'failed', evidence: { line: 31 } }],
      gate: { passed: false, validation: { reason: 'fixture error' } },
    })
    expect(
      page.nodes.receipts!.querySelectorAll('summary')[0]?.textContent,
    ).toBe('Receipt[0]: failed')
    expect(page.nodes.gate!.querySelectorAll('summary')[0]?.textContent).toBe(
      'Gate: Failed',
    )
    page.nodes['gate-find']!.value = 'reason'
    page.nodes['gate-find']!.listeners.input!()
    expect(page.nodes.gate!.querySelectorAll('summary')[0]?.textContent).toBe(
      'Gate.validation.reason: fixture error',
    )
  })
  test('a late response from A cannot overwrite selected run B', async () => {
    const page = await createPage()
    page.buttons[1]!.listeners.click!()
    page.pending['/api/runs/B/events']![0]!.resolve(event('B-result'))
    await flush()
    page.pending['/api/runs/A/events']![0]!.resolve(event('A-result'))
    await flush()

    expect(page.buttons[1]!.attributes['aria-current']).toBe('true')
    expect(
      page.nodes['event-rows']!.children[0]!.children[1]!.textContent,
    ).toBe('B-result')
    expect(page.nodes['timeline-status']!.textContent).toContain(
      '1 latest captured events of 1',
    )
  })

  test('changing selection clears the previous timeline while loading', async () => {
    const page = await createPage()
    page.pending['/api/runs/A/events']![0]!.resolve(event('A-result'))
    await flush()
    expect(page.nodes['event-rows']!.children).toHaveLength(1)

    page.buttons[1]!.listeners.click!()
    expect(page.nodes['event-rows']!.children).toHaveLength(0)
    expect(page.nodes['timeline-status']!.textContent).toContain(
      'Loading events for B',
    )
  })

  test('a late A error cannot replace B success feedback', async () => {
    const page = await createPage()
    page.buttons[1]!.listeners.click!()
    page.pending['/api/runs/B/events']![0]!.resolve(event('B-result'))
    await flush()
    page.pending['/api/runs/A/events']![0]!.reject(
      new Error('old request failed'),
    )
    await flush()

    expect(page.nodes['timeline-status']!.textContent).toContain(
      '1 latest captured events of 1',
    )
    expect(page.nodes['timeline-status']!.className).toBe('status')
  })

  test('reselecting the same run retains the newest response', async () => {
    const page = await createPage()
    page.buttons[0]!.listeners.click!()
    page.pending['/api/runs/A/events']![1]!.resolve(event('newest'))
    await flush()
    page.pending['/api/runs/A/events']![0]!.resolve(event('older'))
    await flush()

    expect(
      page.nodes['event-rows']!.children[0]!.children[1]!.textContent,
    ).toBe('newest')
  })
  test('refresh retains selected identity and reading position', async () => {
    const page = await createPage()
    page.buttons[1]!.listeners.click!()
    page.pending['/api/runs/B/events']![0]!.resolve(event('B-result'))
    await flush()
    page.nodes['timeline-viewport']!.scrollTop = 90
    page.nodes['refresh-timeline']!.listeners.click!()
    page.pending['/api/runs/B/events']![1]!.resolve(event('B-new-result'))
    await flush()
    expect(page.nodes['timeline-viewport']!.scrollTop).toBe(90)
    expect(page.nodes['selected-run']!.textContent).toBe('Selected run: B')
  })
  test('failed refresh labels retained events as a previous capture', async () => {
    const page = await createPage()
    page.pending['/api/runs/A/events']![0]!.resolve(event('A-result'))
    await flush()
    page.nodes['refresh-timeline']!.listeners.click!()
    page.pending['/api/runs/A/events']![1]!.reject(new Error('offline'))
    await flush()
    expect(page.nodes['event-rows']!.children).toHaveLength(1)
    expect(page.nodes['timeline-status']!.textContent).toContain(
      'Previous capture remains visible',
    )
  })
})
