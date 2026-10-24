/**
 * ChatGPT OAuth PKCE flow for connecting a user's ChatGPT subscription.
 * Experimental and feature-flagged.
 */

import crypto from 'crypto'
import http from 'http'

import type { Socket } from 'net'

import {
  CHATGPT_OAUTH_AUTHORIZE_URL,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/chatgpt-oauth'
import {
  clearChatGptOAuthCredentials,
  getChatGptOAuthCredentials,
  isChatGptOAuthValid,
  resetChatGptOAuthRateLimit,
  saveChatGptOAuthCredentials,
} from '@openbuff/sdk'
import { safeOpen } from './open-url'

import type { ChatGptOAuthCredentials } from '@openbuff/sdk'

/**
 * TEST-ONLY override for the OAuth redirect URI. Production must keep using
 * the provider-registered CHATGPT_OAUTH_REDIRECT_URI — that exact callback
 * URL is what the ChatGPT OAuth provider allows — so this seam exists purely
 * for tests: each test flow sets a unique loopback redirect URI and clears
 * the override afterwards. Never call this outside test code.
 */
let testRedirectUriOverride: string | null = null

/**
 * TEST-ONLY: make flows begun while set authorize against (and bind callback
 * servers on) `uri` instead of the provider-registered constant; pass null
 * to restore production behavior.
 */
export function setChatGptOAuthRedirectUriForTests(uri: string | null): void {
  testRedirectUriOverride = uri
}

function parseOAuthTokenResponse(data: unknown): {
  accessToken: string
  refreshToken: string
  expiresInMs: number
} {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid token response format from ChatGPT OAuth.')
  }

  const tokenData = data as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof tokenData.access_token !== 'string' ||
    tokenData.access_token.trim().length === 0
  ) {
    throw new Error('Token exchange did not return a valid access token.')
  }

  const refreshToken =
    typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : ''
  const expiresInMs =
    typeof tokenData.expires_in === 'number' &&
    Number.isFinite(tokenData.expires_in) &&
    tokenData.expires_in > 0
      ? tokenData.expires_in * 1000
      : 3600 * 1000

  return {
    accessToken: tokenData.access_token,
    refreshToken,
    expiresInMs,
  }
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return toBase64Url(crypto.randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return toBase64Url(crypto.createHash('sha256').update(verifier).digest())
}

/**
 * All per-flow OAuth state lives here instead of in mutable module globals,
 * so a superseded flow can never tear down, overwrite, or time out against a
 * newer flow's state.
 */
type PendingOAuthFlow = {
  codeVerifier: string
  state: string
  /** The redirect URI this flow was authorized against (TEST-ONLY overrideable). */
  redirectUri: string
  server: http.Server | null
  timeout: ReturnType<typeof setTimeout> | null
  settled: boolean
  resolve: (credentials: ChatGptOAuthCredentials) => void
  reject: (reason?: unknown) => void
}

let activeFlow: PendingOAuthFlow | null = null

/**
 * Bounded registry of recently superseded flows keyed by their state, so a
 * manual paste of a callback URL from a flow that was replaced by a newer one
 * still validates against ITS OWN state and verifier instead of failing with
 * a false state mismatch or pairing a code with the wrong flow's verifier.
 */
const supersededFlows = new Map<string, PendingOAuthFlow>()
const MAX_SUPERSEDED_FLOWS = 5

/**
 * Node's server.close() is asynchronous: the fixed redirect port is released
 * only when the 'close' event fires, not when close() returns. A fast restart
 * of the connect flow must wait — bounded — for the superseded flow's
 * teardown before listening on the same port, or the new listen can fail with
 * EADDRINUSE before the user has done anything.
 */
const SERVER_CLOSE_WAIT_TIMEOUT_MS = 1_000
/**
 * Hard cap for a teardown that never emits 'close' at all, even after its
 * remaining connections were destroyed: the port-release chain resolves so a
 * wedged teardown cannot block a new flow forever.
 */
const SERVER_CLOSE_HARD_TIMEOUT_MS = 10_000
/** Grace after the hard cap's final connection destruction. */
const SERVER_CLOSE_FINAL_GRACE_MS = 250
let portReleaseChain: Promise<void> = Promise.resolve()

/**
 * Open sockets per callback server, tracked from creation so the teardown
 * below can destroy the browser's keep-alive connection even on a runtime
 * whose http.Server lacks closeAllConnections.
 */
const trackedServerSockets = new WeakMap<http.Server, Set<Socket>>()

function trackServerSockets(server: http.Server): void {
  const sockets = new Set<Socket>()
  trackedServerSockets.set(server, sockets)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
}

/**
 * Bind outcome per callback server, recorded from creation: 'listening' and
 * 'error' fire at most once, and a bind may settle (e.g. fail with EADDRINUSE)
 * while the server's port-release task is still queued behind earlier
 * releases on the chain. The release logic must consult this recorded state
 * instead of attaching fresh listeners for events that may already have
 * fired.
 */
type ServerBindState = {
  bindSettled: boolean
  bindSucceeded: boolean
  closed: boolean
}

const serverBindStates = new WeakMap<http.Server, ServerBindState>()

function trackServerBind(server: http.Server): void {
  const state: ServerBindState = {
    bindSettled: false,
    bindSucceeded: false,
    closed: false,
  }
  serverBindStates.set(server, state)
  server.once('listening', () => {
    if (!state.bindSettled) {
      state.bindSettled = true
      state.bindSucceeded = true
    }
  })
  server.once('error', () => {
    if (!state.bindSettled) {
      state.bindSettled = true
      state.bindSucceeded = false
    }
  })
  server.once('close', () => {
    state.closed = true
  })
}

/**
 * Destroy the connections still holding a closing server open.
 * server.close() does not emit 'close' while keep-alive connections remain
 * open, and a browser holds its callback connection open long after its
 * response was delivered — so without this the fixed port stays bound (and
 * every rebind of it fails with EADDRINUSE) until the server's keep-alive
 * timeout expires.
 */
function destroyRemainingConnections(server: http.Server): void {
  const closable = server as { closeAllConnections?: () => void }
  closable.closeAllConnections?.()
  const sockets = trackedServerSockets.get(server)
  if (!sockets) return
  for (const socket of sockets) socket.destroy()
  sockets.clear()
}

function waitServerClose(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    server.once('close', finish)
    // First fallback: destroy the keep-alive connections still holding the
    // port open so 'close' fires promptly. The port-release chain stays held
    // until then — releasing it while the port is still bound is exactly the
    // EADDRINUSE window a fast restart must never hit. Unref'd so it cannot
    // hold the process open on its own.
    const escalate = setTimeout(
      () => destroyRemainingConnections(server),
      SERVER_CLOSE_WAIT_TIMEOUT_MS,
    )
    escalate.unref?.()
    // Hard cap for a teardown that never emits 'close' at all: destroy the
    // remaining connections one last time and resolve after a short grace so
    // the chain cannot block a new flow forever.
    const hardCap = setTimeout(() => {
      destroyRemainingConnections(server)
      const finalGrace = setTimeout(finish, SERVER_CLOSE_FINAL_GRACE_MS)
      finalGrace.unref?.()
    }, SERVER_CLOSE_HARD_TIMEOUT_MS)
    hardCap.unref?.()
  })
}

/**
 * Queue a callback server's port release onto a serialized chain so a
 * replacement flow can await EVERY prior server's teardown before rebinding
 * the fixed redirect port. The server may already be listening, may have
 * already SETTLED its bind while this task sat behind earlier releases on
 * the chain ('listening'/'error' fire at most once, so freshly attached
 * listeners would wait for events that never fire again and stall the chain
 * for the full hard cap after a failed bind), or may still have a PENDING
 * listen (supersession can land between createServer and the bind
 * completing): in the pending case the release task waits for the bind, then
 * closes the server and waits for the port release, so a replacement flow's
 * bind can never race the old one onto the same port — and a bind that
 * already failed settles the release immediately because there is nothing
 * to release. A teardown that never completes is released by the bounded
 * fallback so it cannot block a new flow forever.
 */
function queueServerRelease(server: http.Server): void {
  portReleaseChain = portReleaseChain.then(
    () =>
      new Promise<void>((resolve) => {
        const finish = () => resolve()
        const releaseBoundServer = () => {
          try {
            server.close()
          } catch {
            // Already closed: nothing to release.
          }
          waitServerClose(server).then(finish)
        }
        if (server.listening) {
          releaseBoundServer()
          return
        }
        // The bind may already have settled before this queued task ran:
        // decide from the recorded bind state instead of attaching listeners
        // for events that may have already fired.
        const bindState = serverBindStates.get(server)
        if (bindState) {
          if (bindState.closed) {
            // Fully torn down: the port is already released.
            finish()
            return
          }
          if (bindState.bindSettled) {
            if (bindState.bindSucceeded) {
              // The bind succeeded and teardown is already in flight: keep
              // waiting — bounded — for the 'close' event instead of
              // re-issuing the close.
              waitServerClose(server).then(finish)
            } else {
              // The bind failed (e.g. a competing flow held the port): there
              // is nothing to release.
              finish()
            }
            return
          }
        }
        const cleanup = () => {
          server.removeListener('listening', onListening)
          server.removeListener('error', onError)
        }
        const onListening = () => {
          cleanup()
          releaseBoundServer()
        }
        const onError = () => {
          // The pending bind failed (e.g. a competing flow holds the port):
          // there is nothing to release.
          cleanup()
          finish()
        }
        server.once('listening', onListening)
        server.once('error', onError)
        // A pending bind resolves deterministically with 'listening' or
        // 'error'; only a wedged event loop reaches this hard cap. Releasing
        // earlier would race the still-pending bind against the replacement
        // flow's bind on the same port.
        const fallback = setTimeout(finish, SERVER_CLOSE_HARD_TIMEOUT_MS)
        fallback.unref?.()
      }),
  )
}

/**
 * Clear a flow's own timer and close its own callback server. Never touches
 * any other flow's resources. The port release is queued (see
 * queueServerRelease) so a replacement flow can wait for the fixed redirect
 * port to be released before listening on it again.
 */
function disposeFlowResources(flow: PendingOAuthFlow): void {
  if (flow.timeout) {
    clearTimeout(flow.timeout)
    flow.timeout = null
  }
  if (flow.server) {
    const server = flow.server
    flow.server = null
    // The server may already be listening or still have a pending listen;
    // queueServerRelease handles both, and a replacement flow awaits the
    // release chain before rebinding the fixed redirect port.
    queueServerRelease(server)
  }
}

/**
 * Deactivate the active flow: dispose only its own timer/server and settle
 * its credentials promise with `reason`, so a cancelled or superseded flow
 * never hangs unsettled and its timeout can never fire against a newer flow.
 * Returns the deactivated flow, or null when nothing was active.
 */
function deactivateActiveFlow(reason: string): PendingOAuthFlow | null {
  const flow = activeFlow
  activeFlow = null
  if (!flow) return null
  disposeFlowResources(flow)
  if (!flow.settled) {
    flow.settled = true
    flow.reject(new Error(reason))
  }
  return flow
}

/**
 * Replace the active flow with a new one: the superseded flow's credentials
 * promise is rejected immediately (instead of hanging until its 5-minute
 * timeout, which previously fired against the NEW flow), and its state is
 * retained — bounded — for the manual paste path.
 */
function supersedeActiveFlow(): void {
  const flow = deactivateActiveFlow('A newer ChatGPT OAuth flow was started')
  if (!flow) return
  supersededFlows.delete(flow.state)
  supersededFlows.set(flow.state, flow)
  while (supersededFlows.size > MAX_SUPERSEDED_FLOWS) {
    const oldest = supersededFlows.keys().next().value
    if (oldest === undefined) break
    supersededFlows.delete(oldest)
  }
}

function beginOAuthFlow(): { flow: PendingOAuthFlow; authUrl: string } {
  supersedeActiveFlow()

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  // Generate state independently of the PKCE verifier: the state travels in
  // the authorize URL and the redirect, so anyone who observes it must not
  // learn the verifier.
  const state = toBase64Url(crypto.randomBytes(32))

  // The redirect URI is resolved per flow, so the TEST-ONLY override applies
  // to exactly the flow that begins while it is set; in production this is
  // always the provider-registered constant.
  const redirectUri = testRedirectUriOverride ?? CHATGPT_OAUTH_REDIRECT_URI

  const flow: PendingOAuthFlow = {
    codeVerifier,
    state,
    redirectUri,
    server: null,
    timeout: null,
    settled: false,
    resolve: () => {},
    reject: () => {},
  }
  activeFlow = flow

  const authUrl = new URL(CHATGPT_OAUTH_AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', CHATGPT_OAUTH_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', flow.redirectUri)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('scope', 'openid profile email offline_access')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', 'codex_cli_rs')

  return { flow, authUrl: authUrl.toString() }
}

export function startChatGptOAuthFlow(): {
  codeVerifier: string
  state: string
  authUrl: string
} {
  const { flow, authUrl } = beginOAuthFlow()
  return { codeVerifier: flow.codeVerifier, state: flow.state, authUrl }
}

const CALLBACK_SERVER_TIMEOUT_MS = 5 * 60 * 1000
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000

export function stopChatGptOAuthServer(): void {
  // Deactivates the ACTIVE flow only: its own timer is cleared (a cancelled
  // flow can never fire its timeout later) and its credentials promise is
  // settled so it does not hang.
  deactivateActiveFlow('ChatGPT OAuth flow was cancelled')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function callbackPageHtml(success: boolean, errorMessage?: string): string {
  const brandLabel = 'CLI'
  const returnTarget = 'the CLI'
  const retryCommand = '/provider connect codex'
  const title = success
    ? `Connected — ${brandLabel}`
    : `Connection Failed — ${brandLabel}`
  const heading = success ? '✓ Connected to ChatGPT' : 'Connection Failed'
  const headingColor = success ? '#4ade80' : '#f87171'
  const body = success
    ? `You can close this tab and return to ${returnTarget}.`
    : `${escapeHtml(errorMessage ?? 'Unknown error')}. Return to ${returnTarget} and try ${retryCommand} again.`
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5">
<div style="text-align:center;padding:2rem">
<h1 style="color:${headingColor};margin-bottom:0.5rem">${heading}</h1>
<p style="color:#a3a3a3">${body}</p>
</div></body></html>`
}

async function startCallbackServer(
  flow: PendingOAuthFlow,
): Promise<ChatGptOAuthCredentials> {
  const redirectUrl = new URL(flow.redirectUri)
  const port = parseInt(redirectUrl.port, 10)
  const callbackPath = redirectUrl.pathname

  // NOTE: nothing is awaited before the promise executor below — flow.server
  // must be recorded synchronously so a supersession landing before the bind
  // can still queue this server's port release (see queueServerRelease). An
  // await here would leave flow.server null during the await window and let
  // two flows race onto the fixed redirect port.
  return new Promise<ChatGptOAuthCredentials>((resolve, reject) => {
    flow.resolve = resolve
    flow.reject = reject

    // Every terminal path (timeout, callback failure, success, server error)
    // goes through here: it disposes ONLY this flow's own timer/server and
    // settles ONLY this flow's own promise, so a superseded flow's cleanup
    // can never reach a newer flow's callback server or state.
    const settleFlow = (
      outcome: { error: Error } | { credentials: ChatGptOAuthCredentials },
    ): void => {
      disposeFlowResources(flow)
      if (activeFlow === flow) {
        activeFlow = null
      }
      if (flow.settled) return
      flow.settled = true
      if ('error' in outcome) {
        reject(outcome.error)
      } else {
        resolve(outcome.credentials)
      }
    }

    flow.timeout = setTimeout(() => {
      settleFlow({ error: new Error('Timeout waiting for ChatGPT authorization') })
    }, CALLBACK_SERVER_TIMEOUT_MS)

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }

      const code = reqUrl.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(callbackPageHtml(false, 'No authorization code received.'))
        settleFlow({ error: new Error('No authorization code in callback') })
        return
      }

      // Compare against THIS flow's own state, not any shared module state.
      // This closes the PKCE race where a second connectChatGptOAuth() call
      // starts a newer flow before the first flow's callback arrives.
      //
      // A foreign state must NOT terminally settle this flow: the redirect
      // port is fixed and shared, so a stale tab from a superseded flow can
      // deliver its old-state redirect to THIS server late, and a stray or
      // malicious local request to the port can carry any state at all.
      // Terminally rejecting this flow for either would force the user to
      // restart a perfectly valid pending flow. Answer with the retry page
      // and keep waiting; this flow's own timeout remains the terminal path.
      const state = reqUrl.searchParams.get('state')
      if (!state || state !== flow.state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          callbackPageHtml(false, 'OAuth state mismatch. Please try again.'),
        )
        return
      }

      try {
        const fullCallbackUrl = `${flow.redirectUri}${reqUrl.search}`
        const credentials = await exchangeChatGptCodeForTokens(
          fullCallbackUrl,
          flow.codeVerifier,
          // The flow's timeout can settle (reject + dispose) while this
          // exchange is still in flight; the abandoned guard makes the
          // exchange discard — never persist — its result for a flow the
          // caller was already told timed out.
          { isAbandoned: () => flow.settled },
        )

        // If the flow settled while the exchange was in flight, its server
        // was disposed and its sockets destroyed: writing the success page
        // here would throw inside this async request listener, and settling
        // again would persist credentials for a flow the caller was already
        // told timed out. The exchange's abandoned guard already prevented
        // the persist; skip the page and the settle too.
        if (flow.settled) {
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(callbackPageHtml(true))

        settleFlow({ credentials })
      } catch (err) {
        // Same settled guard: a failed exchange for an already-settled flow
        // must not write to the disposed server's socket either. The flow's
        // promise already rejected with its own settle reason, so the
        // exchange error is swallowed here; settleFlow itself also ignores an
        // already-settled flow.
        if (!flow.settled) {
          const message =
            err instanceof Error ? err.message : 'Token exchange failed'
          res.writeHead(500, { 'Content-Type': 'text/html' })
          res.end(callbackPageHtml(false, message))

          settleFlow({
            error: err instanceof Error ? err : new Error(message),
          })
        }
      }
    })

    // Track the server's connections from creation so the teardown can
    // destroy the browser's keep-alive connection and release the fixed
    // redirect port promptly (see destroyRemainingConnections).
    trackServerSockets(server)
    // Record the bind outcome from creation so a queued port-release task
    // that runs after the bind already settled (e.g. failed with EADDRINUSE)
    // can release the chain immediately instead of waiting for events that
    // already fired (see queueServerRelease).
    trackServerBind(server)

    // Bind ownership is recorded before listen() so disposeFlowResources can
    // queue the port release even when supersession or cancellation lands
    // while the listen is still pending.
    flow.server = server

    server.on('error', (err) => {
      settleFlow({ error: err instanceof Error ? err : new Error(String(err)) })
    })

    // The bind is issued only after the port-release chain completes, using a
    // snapshot taken BEFORE this flow's own release could be queued (a later
    // supersession queues it after this point), so this bind is never
    // serialized behind its own teardown. Because flow.server was recorded
    // synchronously above, a supersession landing before the bind still
    // queues this server's release: the queued task waits for 'listening',
    // closes the server, and frees the port for the replacement flow.
    const chainBeforeThisBind = portReleaseChain
    void (async () => {
      try {
        await chainBeforeThisBind
      } catch {
        // The listen below reports its own error if the port is unavailable.
      }
      server.listen(port, '127.0.0.1', () => {
        // Nothing to do on a successful bind.
      })
    })()
  })
}

export function connectChatGptOAuth(): {
  authUrl: string
  credentials: Promise<ChatGptOAuthCredentials>
} {
  // beginOAuthFlow supersedes any previous flow: the superseded flow's
  // credentials promise is rejected immediately and its server/timer are
  // disposed, so they can never fire against this new flow.
  const { flow, authUrl } = beginOAuthFlow()
  const credentials = startCallbackServer(flow)

  void safeOpen(authUrl)

  return { authUrl, credentials }
}

function parseAuthCodeInput(input: string): {
  code: string
  state?: string
  fromUrl: boolean
} {
  const trimmed = input.trim()

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const callback = new URL(trimmed)
    const code = callback.searchParams.get('code')
    const state = callback.searchParams.get('state') ?? undefined

    if (!code) {
      throw new Error('No authorization code found in callback URL.')
    }

    return { code, state, fromUrl: true }
  }

  return { code: trimmed, fromUrl: false }
}

/**
 * Resolve the flow a manual exchange belongs to. A callback URL must carry
 * exactly the state a known flow issued — the active flow's or a recently
 * superseded flow's (the superseded flow is still the legitimate owner of
 * codes the user completed) — including when the state parameter is missing
 * entirely. A bare pasted code has no state parameter to check, so it binds
 * to the currently active flow's verifier.
 */
function resolveFlowForExchange(
  state: string | undefined,
  fromUrl: boolean,
): PendingOAuthFlow | null {
  if (fromUrl) {
    if (state === undefined) return null
    if (activeFlow && activeFlow.state === state) return activeFlow
    return supersededFlows.get(state) ?? null
  }
  return activeFlow
}

export async function exchangeChatGptCodeForTokens(
  authCodeInput: string,
  codeVerifier?: string,
  options?: {
    /**
     * Called immediately before the credentials are persisted so a caller
     * driving an in-flight exchange can report that its flow already settled
     * (timed out, was cancelled, or was superseded). The check and the save
     * form one synchronous block, so the settle callback cannot interleave
     * between them.
     */
    isAbandoned?: () => boolean
  },
): Promise<ChatGptOAuthCredentials> {
  const { code, state, fromUrl } = parseAuthCodeInput(authCodeInput)

  // Resolve the flow this code belongs to BEFORE exchanging: the manual paste
  // path must validate against the OWNING flow's state and pair the code with
  // that flow's verifier — never with whatever a newer concurrent flow left
  // in a mutable module global.
  const flow = resolveFlowForExchange(state, fromUrl)
  if (!flow) {
    throw new Error(
      fromUrl
        ? 'OAuth state mismatch. Please restart /connect:chatgpt.'
        : 'No PKCE verifier found. Please run /connect:chatgpt again.',
    )
  }

  const verifier = codeVerifier ?? flow.codeVerifier
  if (!verifier) {
    throw new Error(
      'No PKCE verifier found. Please run /connect:chatgpt again.',
    )
  }

  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      redirect_uri: flow.redirectUri,
      code,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to exchange ChatGPT OAuth code (status ${response.status}). Please retry /connect:chatgpt.`,
    )
  }

  const data = await response.json()
  const tokenResponse = parseOAuthTokenResponse(data)

  const credentials: ChatGptOAuthCredentials = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt: Date.now() + tokenResponse.expiresInMs,
    connectedAt: Date.now(),
  }

  // A settled flow (timeout, cancellation, or supersession) must never
  // receive credentials: the caller was already told the flow ended, so the
  // late token result is discarded instead of persisted.
  if (options?.isAbandoned?.()) {
    throw new Error(
      'ChatGPT OAuth flow already settled; discarding token exchange result.',
    )
  }

  saveChatGptOAuthCredentials(credentials)
  resetChatGptOAuthRateLimit()

  // A manual paste completes the flow the callback server is waiting on:
  // settle its credentials promise with the same credentials and release its
  // timer/server, then drop the consumed flow so its verifier cannot be
  // reused by a later paste.
  if (codeVerifier === undefined && !flow.settled) {
    flow.settled = true
    flow.resolve(credentials)
  }
  disposeFlowResources(flow)
  if (activeFlow === flow) {
    activeFlow = null
  } else {
    supersededFlows.delete(flow.state)
  }

  return credentials
}

export function disconnectChatGptOAuth(): void {
  stopChatGptOAuthServer()
  clearChatGptOAuthCredentials()
  resetChatGptOAuthRateLimit()
}

export function getChatGptOAuthStatus(): {
  connected: boolean
  expiresAt?: number
  connectedAt?: number
} {
  const credentials = getChatGptOAuthCredentials()
  if (!credentials) {
    return { connected: false }
  }

  if (!isChatGptOAuthValid()) {
    return { connected: false }
  }

  return {
    connected: true,
    expiresAt: credentials.expiresAt,
    connectedAt: credentials.connectedAt,
  }
}
