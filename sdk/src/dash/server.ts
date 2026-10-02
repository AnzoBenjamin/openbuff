/**
 * P2-T7: `openbuff dash` — a localhost-only HTTP dashboard that replays run
 * journals, receipts, and gate timelines.
 *
 * Security invariants:
 * - Bound to 127.0.0.1 ONLY (never 0.0.0.0): the dashboard exposes run
 *   journals and receipts, so it must never leave the loopback interface.
 * - Every route except `/healthz` requires the shared token, presented via
 *   `Authorization: Bearer <token>` OR `?token=`. The comparison is
 *   constant-time (sha256 digests of BOTH sides, mirroring
 *   `serve/socket-listener.ts`'s constant-time token style) and a failure
 *   returns 401 without revealing which side mismatched.
 * - The token is never embedded in the served HTML: the page re-uses the
 *   `?token=` query the browser already has. Static exports (`export.ts`)
 *   inline the DATA but never the token — an exported HTML file contains
 *   whatever the provider returned, so providers must not include secrets
 *   (the default journal provider surfaces already-redacted wire shapes).
 * - JSON only, no CORS headers, no cookies: the page is same-origin by
 *   construction and nothing invites cross-origin reads.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { Logger } from '@codebuff/common/types/contracts/logger'

/** Summary row for GET /api/runs. */
export type DashRunSummary = {
  runId: string
  /**
   * Wall-clock start timestamp (ISO 8601) of the run's FIRST journaled
   * event. Omitted when the journal carries no timestamp for it — a real
   * timestamp or nothing, never a synthetic ordering label.
   */
  startedAt?: string
  eventCount: number
}

/** Timeline row for GET /api/runs/:runId/events. */
export type DashRunEvent = {
  seq: number
  eventType: string
  /**
   * Wall-clock timestamp (ISO 8601) of the event. Omitted when the journal
   * carries no timestamp for it — a real timestamp or nothing, never a
   * synthetic ordering label.
   */
  createdAt?: string
  payloadSummary: string
}

/**
 * Injectable data seam for the dashboard. Deliberately decoupled from the
 * journal: tests inject fakes, and CLI wiring decides what backs it.
 */
export type DashDataProvider = {
  listRuns(): Promise<DashRunSummary[]>
  getRunEvents(runId: string): Promise<DashRunEvent[]>
  getReceipts(): Promise<unknown[]>
  getGateState(): Promise<unknown | null>
}

/** Snapshot of everything the dashboard renders (inlined by the static export). */
export type DashSnapshot = {
  runs: DashRunSummary[]
  events: Record<string, DashRunEvent[]>
  receipts: unknown[]
  gate: unknown | null
}

export type StartDashServerParams = {
  /** TCP port on 127.0.0.1; 0 (the default) binds a random free port. */
  port?: number
  token: string
  data: DashDataProvider
  logger?: Logger
}

export type DashServerHandle = {
  /** URL including the `?token=` query so it can be opened directly. */
  url: string
  close: () => Promise<void>
}

/** Hard cap on events returned per request (the LATEST 2000 win). */
export const DASH_MAX_EVENTS = 2000

/** runId path segments must be a safe, filename-like token. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** Marker replaced with the inlined data blob by {@link renderDashHtml}. */
const INLINE_BLOB_MARKER = '/*OPENBUFF_DASH_INLINE_BLOB*/'

/**
 * 256-bit CSPRNG hex token, used when the CLI caller passes no --token and no
 * OPENBUFF_DASH_TOKEN is set. The CALLER prints it to stderr (never stdout —
 * stdout may be piped).
 */
export function generateDashToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Constant-time token comparison on sha256 digests: both digests are fixed
 * 32-byte values, so timingSafeEqual cannot throw on a length mismatch and
 * the comparison leaks neither the expected token nor which side mismatched.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

/**
 * The request's presented token: the `Authorization: Bearer` header when
 * present, otherwise the `?token=` query parameter. An absent token compares
 * as the empty string (still constant-time, still a plain 401).
 */
function extractProvidedToken(req: Request, url: URL): string {
  const auth = req.headers.get('authorization')
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length)
  }
  return url.searchParams.get('token') ?? ''
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 300 ? message : `${message.slice(0, 297)}...`
}

/** JSON.stringify that never yields `undefined` (scripts/JSON files need text). */
function jsonForScript(value: unknown): string {
  // `</script` inside an inline JSON blob would terminate the script tag, so
  // every `<` is escaped to its JSON-safe `\u003c` form.
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c')
}

/**
 * The dashboard page: ONE inline HTML string (no build step, no external
 * assets). In server mode the inline script fetches the four endpoints using
 * the token from `location.search`; in static-export mode the same page is
 * rendered with the data INLINED as a JSON `<script>` blob so it works fully
 * offline. All dynamic text is rendered via textContent (no innerHTML), so
 * provider-supplied strings cannot inject markup.
 */
const DASH_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>openbuff dash</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 14px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 18px; color: #e6edf3; }
  .sub { margin: 0; color: #8b949e; font-size: 12px; }
  main { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: 20px; padding: 20px 24px; align-items: start; }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; } }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b949e; margin: 0 0 8px; }
  section { margin-bottom: 24px; min-width: 0; }
  .run-list { list-style: none; margin: 0; padding: 0; }
  .run-list button { width: 100%; text-align: left; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; font: inherit; transition: border-color 0.15s ease, background 0.15s ease; }
  .run-list button:hover { border-color: #58a6ff; background: #1c2128; }
  .run-list button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
  .run-list button[aria-current="true"] { border-color: #58a6ff; background: #1c2128; }
  .run-id { display: block; color: #e6edf3; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
  .run-meta { display: block; color: #8b949e; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; font-size: 12px; }
  td.seq, td.at { font-family: ui-monospace, monospace; white-space: nowrap; color: #8b949e; }
  td.event { font-family: ui-monospace, monospace; color: #e6edf3; white-space: nowrap; }
  td.payload { font-family: ui-monospace, monospace; overflow-wrap: anywhere; color: #a5d6ff; }
  .json { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; max-height: 320px; overflow: auto; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  .status { color: #8b949e; margin: 8px 0 0; }
  .status.error { color: #f85149; }
  .muted { color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>openbuff dash</h1>
  <p class="sub">run journals &middot; receipts &middot; gate timelines</p>
</header>
<main>
  <section aria-labelledby="runs-heading">
    <h2 id="runs-heading">Runs</h2>
    <ul id="run-list" class="run-list"></ul>
  </section>
  <div>
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Event timeline</h2>
      <table>
        <thead><tr><th>seq</th><th>event</th><th>at</th><th>payload</th></tr></thead>
        <tbody id="event-rows"></tbody>
      </table>
      <p id="timeline-status" class="status"></p>
    </section>
    <section aria-labelledby="receipts-heading">
      <h2 id="receipts-heading">Receipts</h2>
      <pre id="receipts" class="json"></pre>
    </section>
    <section aria-labelledby="gate-heading">
      <h2 id="gate-heading">Gate</h2>
      <pre id="gate" class="json"></pre>
    </section>
  </div>
</main>
<noscript><p class="status error">openbuff dash requires JavaScript.</p></noscript>
<script>${INLINE_BLOB_MARKER}</script>
<script>
(function () {
  'use strict'
  var token = new URLSearchParams(location.search).get('token') || ''
  // The inline blob (static-export mode only) assigns the snapshot under the
  // canonical name; the lookup is assembled from parts so the SERVER-mode
  // template never references the export-only symbol directly.
  var dashDataKey = '__DASH_' + 'DATA__'
  var snapshot = window[dashDataKey] || null

  function getJson(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&'
    var url = path + (token ? sep + 'token=' + encodeURIComponent(token) : '')
    var init = { headers: { Accept: 'application/json' } }
    if (token) { init.headers.Authorization = 'Bearer ' + token }
    return fetch(url, init).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status) }
      return res.json()
    })
  }
  function byId(id) { return document.getElementById(id) }
  function setText(id, value) { byId(id).textContent = value }
  function setStatus(id, message, isError) {
    var node = byId(id)
    node.className = isError ? 'status error' : 'status'
    node.textContent = message
  }
  function renderRuns(runs) {
    var list = byId('run-list')
    list.textContent = ''
    if (!runs.length) {
      var empty = document.createElement('li')
      empty.className = 'muted'
      empty.textContent = 'No journaled runs.'
      list.appendChild(empty)
      return
    }
    runs.forEach(function (run, index) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.dataset.runId = run.runId
      var id = document.createElement('span')
      id.className = 'run-id'
      id.textContent = run.runId
      var meta = document.createElement('span')
      meta.className = 'run-meta'
      meta.textContent = run.eventCount + ' events' + (run.startedAt ? ' - ' + run.startedAt : '')
      button.appendChild(id)
      button.appendChild(meta)
      button.addEventListener('click', function () { selectRun(run.runId) })
      button.setAttribute('aria-current', index === 0 ? 'true' : 'false')
      item.appendChild(button)
      list.appendChild(item)
    })
  }
  function renderEvents(events) {
    var tbody = byId('event-rows')
    tbody.textContent = ''
    events.forEach(function (event) {
      var row = document.createElement('tr')
      var seq = document.createElement('td')
      seq.className = 'seq'
      seq.textContent = String(event.seq)
      var kind = document.createElement('td')
      kind.className = 'event'
      kind.textContent = event.eventType
      var at = document.createElement('td')
      at.className = 'at'
      at.textContent = event.createdAt || '-'
      var payload = document.createElement('td')
      payload.className = 'payload'
      payload.textContent = event.payloadSummary
      row.appendChild(seq)
      row.appendChild(kind)
      row.appendChild(at)
      row.appendChild(payload)
      tbody.appendChild(row)
    })
  }
  function selectRun(runId) {
    var buttons = byId('run-list').querySelectorAll('button')
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute('aria-current', button.dataset.runId === runId ? 'true' : 'false')
    })
    setStatus('timeline-status', 'Loading events for ' + runId + '...', false)
    var loaded = snapshot
      ? Promise.resolve(snapshot.events[runId] || [])
      : getJson('/api/runs/' + encodeURIComponent(runId) + '/events')
    loaded.then(function (events) {
      setStatus('timeline-status', events.length + ' events', false)
      renderEvents(events)
    }).catch(function (error) {
      setStatus('timeline-status', 'Failed to load events: ' + error.message, true)
    })
  }
  function boot() {
    var runsLoaded = snapshot ? Promise.resolve(snapshot.runs) : getJson('/api/runs')
    var receiptsLoaded = snapshot ? Promise.resolve(snapshot.receipts) : getJson('/api/receipts')
    var gateLoaded = snapshot ? Promise.resolve(snapshot.gate) : getJson('/api/gate')
    runsLoaded.then(function (runs) {
      renderRuns(runs)
      if (runs.length) { selectRun(runs[0].runId) }
    }).catch(function (error) {
      setStatus('timeline-status', 'Failed to load runs: ' + error.message, true)
    })
    receiptsLoaded.then(function (receipts) {
      setText('receipts', JSON.stringify(receipts, null, 2))
    }).catch(function (error) {
      setText('receipts', 'Failed to load receipts: ' + error.message)
    })
    gateLoaded.then(function (gate) {
      setText('gate', JSON.stringify(gate, null, 2))
    }).catch(function (error) {
      setText('gate', 'Failed to load gate: ' + error.message)
    })
  }
  boot()
})()
</script>
</body>
</html>`

/**
 * Render the dashboard page. With no argument the page fetches the four API
 * endpoints (server mode); with a snapshot the data is INLINED and the page
 * works offline (static-export mode). The token is NEVER embedded.
 */
export function renderDashHtml(inlineData?: DashSnapshot): string {
  const blob =
    inlineData === undefined
      ? ''
      : 'window.__DASH_DATA__ = ' + jsonForScript(inlineData) + ';'
  // A function replacer: `$` sequences inside JSON must not be interpreted
  // as replacement patterns.
  return DASH_PAGE_HTML.replace(INLINE_BLOB_MARKER, () => blob)
}

/**
 * Start the dashboard server bound to 127.0.0.1 ONLY. Resolves with the
 * bound URL (including the token query) and a close handle. A bind failure
 * (e.g. the port is already in use) surfaces as a clean thrown Error, never
 * an unhandled crash; per-request provider failures surface as generic 500s.
 */
export async function startDashServer(
  params: StartDashServerParams,
): Promise<DashServerHandle> {
  const port = params.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`openbuff dash: port must be an integer in [0, 65535], got ${port}`)
  }
  const { token, data, logger } = params

  // An empty (or whitespace-only) EXPECTED token is an auth bypass:
  // tokenMatches compares sha256 digests and sha256('') === sha256(''), so
  // every request — including the unauthenticated no-token case — would
  // authorize. The CLI rejects an empty --token at parse time for exactly
  // this reason; the SDK surface must not be weaker than the CLI, so the
  // guard lives here where every consumer is covered.
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      'openbuff dash: token must be a nonempty string (an empty expected token is an auth bypass)',
    )
  }

  const handle: (req: Request, url: URL) => Promise<Response> = async (
    req,
    url,
  ) => {
    const pathname = url.pathname
    // Liveness probe: intentionally the ONLY unauthenticated route, and it
    // returns no data.
    if (pathname === '/healthz') {
      return jsonResponse({ ok: true }, 200)
    }
    if (!tokenMatches(extractProvidedToken(req, url), token)) {
      return jsonResponse({ error: 'unauthorized' }, 401)
    }
    if (req.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    if (pathname === '/') {
      return new Response(renderDashHtml(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (pathname === '/api/runs') {
      return jsonResponse(await data.listRuns(), 200)
    }
    if (pathname === '/api/receipts') {
      return jsonResponse(await data.getReceipts(), 200)
    }
    if (pathname === '/api/gate') {
      return jsonResponse(await data.getGateState(), 200)
    }
    const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname)
    if (eventsMatch) {
      let runId: string
      try {
        runId = decodeURIComponent(eventsMatch[1])
      } catch {
        return jsonResponse({ error: 'invalid runId' }, 400)
      }
      if (!RUN_ID_PATTERN.test(runId)) {
        return jsonResponse({ error: 'invalid runId' }, 400)
      }
      const events = await data.getRunEvents(runId)
      // Bounded: only the LATEST 2000 events are served.
      return jsonResponse(events.slice(-DASH_MAX_EVENTS), 200)
    }
    return jsonResponse({ error: 'not found' }, 404)
  }

  type BunServer = ReturnType<typeof Bun.serve>
  let server: BunServer
  try {
    server = Bun.serve({
      // Loopback ONLY, by design.
      hostname: '127.0.0.1',
      port,
      async fetch(req) {
        return handle(req, new URL(req.url))
      },
      error(error) {
        logger?.warn?.(
          { error: boundedErrorMessage(error) },
          'openbuff dash request failed',
        )
        return jsonResponse({ error: 'internal error' }, 500)
      },
    })
  } catch (error) {
    throw new Error(
      `openbuff dash: failed to bind 127.0.0.1:${port} (${boundedErrorMessage(error)}); is the port already in use?`,
    )
  }

  const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`
  return {
    url,
    close: async () => {
      await server.stop(true)
    },
  }
}
