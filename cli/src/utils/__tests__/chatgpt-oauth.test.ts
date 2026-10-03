import { createRequire } from 'node:module'

import net from 'net'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  connectChatGptOAuth,
  exchangeChatGptCodeForTokens,
  setChatGptOAuthRedirectUriForTests,
  startChatGptOAuthFlow,
  stopChatGptOAuthServer,
} from '../chatgpt-oauth'

// connectChatGptOAuth opens the authorize URL in the user's browser; stub
// safeOpen so these tests never spawn a browser or depend on a display
// server. The real module is captured and spread so this remains a partial
// override rather than a full replacement of a first-party module.
const realOpenUrlModule = { ...(await import('../open-url')) }
mock.module('../open-url', () => ({
  ...realOpenUrlModule,
  safeOpen: async () => true,
}))

// The token-exchange success path persists credentials via @openbuff/sdk;
// stub the SDK so tests never touch the real credentials store. The save is
// counted so a test can assert that an abandoned exchange's late token
// result is discarded instead of persisted.
let saveChatGptOAuthCredentialsCalls = 0

// mock.module is registry-wide for the whole test process (bun does not
// isolate registrations across test files, and afterAll(mock.restore) does
// NOT undo it), so the @openbuff/sdk mock is registered once at module
// scope.
//
// The real module MUST be captured via createRequire rather than `await
// import`: @openbuff/sdk's ESM `import` condition resolves to a build
// artifact (sdk/dist/index.mjs) that may be stale or unparseable under bun
// test, while the `require` condition resolves the working source. The
// capture is spread eagerly (no lazy reads), so it is safe under the
// repo's mock-module guard.
const requireReal = createRequire(import.meta.url)
const realSdkModule = requireReal('@openbuff/sdk') as {
  default?: typeof import('@openbuff/sdk')
} & Partial<typeof import('@openbuff/sdk')>
const realSdk = { ...realSdkModule, ...realSdkModule.default }

mock.module('@openbuff/sdk', () => ({
  ...realSdk,
  clearChatGptOAuthCredentials: () => {},
  getChatGptOAuthCredentials: () => null,
  isChatGptOAuthValid: () => false,
  resetChatGptOAuthRateLimit: () => {},
  saveChatGptOAuthCredentials: () => {
    saveChatGptOAuthCredentialsCalls++
  },
}))

describe('chatgpt-oauth utility', () => {
  const originalFetch = globalThis.fetch
  // Each test binds its own loopback redirect port, so no two flows ever
  // share a port and the afterEach teardown can never race the next test's
  // bind onto the fixed production port.
  let testRedirectUri = ''

  /** Allocate a fresh loopback port for a per-test redirect URI. */
  async function allocateTestRedirectPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('listening', () => {
        const { port } = probe.address() as net.AddressInfo
        probe.close(() => resolve(port))
      })
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1')
    })
  }

  beforeEach(async () => {
    const port = await allocateTestRedirectPort()
    testRedirectUri = `http://127.0.0.1:${port}/auth/callback`
    setChatGptOAuthRedirectUriForTests(testRedirectUri)
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    saveChatGptOAuthCredentialsCalls = 0
    setChatGptOAuthRedirectUriForTests(null)

    // stopChatGptOAuthServer disposes the active flow; because every test
    // bound its OWN redirect port, no teardown here can race a later test's
    // bind and no port-drain polling is needed.
    stopChatGptOAuthServer()
  })

  test('token exchange error is sanitized and does not include response body', async () => {
    startChatGptOAuthFlow()

    globalThis.fetch = mock(async () => {
      return {
        ok: false,
        status: 401,
        text: async () =>
          'invalid_grant access_token=secret-token refresh_token=secret-refresh',
      } as unknown as Response
    }) as unknown as typeof fetch

    const error = await exchangeChatGptCodeForTokens('auth-code').catch(
      (e) => e,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('status 401')
    expect(error.message).not.toContain('secret-token')
    expect(error.message).not.toContain('secret-refresh')
    expect(error.message).not.toContain('invalid_grant')
  })

  test('startChatGptOAuthFlow generates state independently of the PKCE verifier', () => {
    const { codeVerifier, state, authUrl } = startChatGptOAuthFlow()

    expect(state).not.toBe(codeVerifier)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new URL(authUrl).searchParams.get('state')).toBe(state)
    // The TEST-ONLY redirect override is honored: the flow authorizes
    // against this test's own loopback redirect URI, not the provider-
    // registered production constant.
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe(
      testRedirectUri,
    )
  })

  test('successive OAuth flows generate different states', () => {
    const first = startChatGptOAuthFlow()
    const second = startChatGptOAuthFlow()

    expect(first.state).not.toBe(second.state)
  })

  test('token exchange rejects a callback URL whose state differs from the pending state', async () => {
    startChatGptOAuthFlow()

    globalThis.fetch = mock(async () => {
      throw new Error('token exchange should not be reached')
    }) as unknown as typeof fetch

    const error = await exchangeChatGptCodeForTokens(
      'https://localhost:1455/auth/callback?code=abc&state=attacker-state',
    ).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('state mismatch')
  })

  test('token exchange rejects a callback URL missing the state parameter', async () => {
    startChatGptOAuthFlow()

    globalThis.fetch = mock(async () => {
      throw new Error('token exchange should not be reached')
    }) as unknown as typeof fetch

    const error = await exchangeChatGptCodeForTokens(
      'https://localhost:1455/auth/callback?code=abc',
    ).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('state mismatch')
  })

  test('manual callback URL with the current flow state reaches token exchange', async () => {
    const { state } = startChatGptOAuthFlow()

    globalThis.fetch = mock(async () => {
      throw new Error('reached token exchange')
    }) as unknown as typeof fetch

    const error = await exchangeChatGptCodeForTokens(
      `https://localhost:1455/auth/callback?code=abc&state=${state}`,
    ).catch((e) => e)

    // The matching state passes validation and pairs the code with its own
    // flow's verifier; the mocked fetch failure is the sentinel that the
    // exchange actually ran.
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('reached token exchange')
  })

  test('a superseded flow callback URL still pairs with its own state and verifier', async () => {
    const superseded = startChatGptOAuthFlow()
    startChatGptOAuthFlow()

    globalThis.fetch = mock(async () => {
      throw new Error('reached token exchange')
    }) as unknown as typeof fetch

    const error = await exchangeChatGptCodeForTokens(
      `https://localhost:1455/auth/callback?code=abc&state=${superseded.state}`,
    ).catch((e) => e)

    // A callback URL from a flow that was replaced by a newer one must not
    // fail with a false state mismatch: it still validates against its own
    // flow's state and pairs with that flow's verifier.
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('reached token exchange')
  })

  test('a fast restart of the connect flow does not fail the new flow with EADDRINUSE', async () => {
    const first = connectChatGptOAuth()
    const second = connectChatGptOAuth()

    // The superseded flow is rejected immediately with the supersession
    // reason — never with an EADDRINUSE listen failure from racing the old
    // server's asynchronous teardown.
    const firstError = await first.credentials.then(
      () => null,
      (error: unknown) => error,
    )
    expect(firstError).toBeInstanceOf(Error)
    expect((firstError as Error).message).toBe(
      'A newer ChatGPT OAuth flow was started',
    )

    // The replacement flow's callback server is listening on the fixed
    // redirect port: its credentials promise stays pending (waiting for the
    // user) instead of being rejected by a listen error.
    const secondOutcome = await Promise.race([
      second.credentials.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 100)
      }),
    ])
    expect(secondOutcome).toBe('pending')

    stopChatGptOAuthServer()
  })

  test('a superseded server held open by a keep-alive connection still releases the fixed port', async () => {
    // This test's own redirect port: both flows' callback servers bind it.
    const redirectPort = parseInt(new URL(testRedirectUri).port, 10)

    const tryConnect = (): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = net.connect(redirectPort, '127.0.0.1')
        const done = (connected: boolean) => {
          socket.destroy()
          resolve(connected)
        }
        socket.once('connect', () => done(true))
        socket.once('error', () => done(false))
        socket.setTimeout(250)
        socket.once('timeout', () => done(false))
      })

    const first = connectChatGptOAuth()

    // Wait (bounded) for the first flow's callback server to bind this
    // test's redirect port, then hold an idle connection open on it: server.close()
    // does not complete while such a keep-alive connection exists, so this
    // reproduces exactly the stalled-teardown case where the port stayed
    // bound when the old release chain's fallback fired and the replacement
    // flow's bind failed with EADDRINUSE.
    const bindDeadline = Date.now() + 2_000
    let firstServerBound = false
    while (Date.now() < bindDeadline) {
      if (await tryConnect()) {
        firstServerBound = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(firstServerBound).toBe(true)

    const holdSocket = net.connect(redirectPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      holdSocket.once('connect', () => resolve())
      holdSocket.once('error', reject)
      setTimeout(
        () => reject(new Error('keep-alive socket never connected')),
        2_000,
      ).unref?.()
    })

    const second = connectChatGptOAuth()
    const firstError = await first.credentials.then(
      () => null,
      (error: unknown) => error,
    )
    expect(firstError).toBeInstanceOf(Error)
    expect((firstError as Error).message).toBe(
      'A newer ChatGPT OAuth flow was started',
    )

    // The replacement flow must be listening even though the superseded
    // server's keep-alive connection was still open: the teardown destroys
    // the lingering connection, so the port is released and rebound within a
    // bounded window instead of leaving the new flow failing to bind.
    const rebindDeadline = Date.now() + 3_000
    let rebound = false
    while (Date.now() < rebindDeadline) {
      if (await tryConnect()) {
        rebound = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(rebound).toBe(true)

    holdSocket.destroy()
    // stopChatGptOAuthServer() settles the still-pending replacement flow's
    // credentials promise with a cancellation; attaching the handler before
    // the call keeps that expected rejection from surfacing as unhandled.
    void second.credentials.catch(() => {})
    stopChatGptOAuthServer()
  })

  test('a release queued after a failed bind does not stall the replacement flow behind the hard cap', async () => {
    // This test's own redirect port: both flows' callback servers bind it.
    const redirectPort = parseInt(new URL(testRedirectUri).port, 10)

    const tryConnect = (): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = net.connect(redirectPort, '127.0.0.1')
        const done = (connected: boolean) => {
          socket.destroy()
          resolve(connected)
        }
        socket.once('connect', () => done(true))
        socket.once('error', () => done(false))
        socket.setTimeout(250)
        socket.once('timeout', () => done(false))
      })

    // Hold this test's redirect port so the first flow's bind fails with
    // EADDRINUSE: the server emits 'error' and the flow settles, queueing
    // this server's port release only AFTER the bind already failed — the
    // exact case where waiting for fresh 'listening'/'error' events would
    // stall the release chain until the 10s hard cap and delay the
    // replacement flow's listen.
    const blocker = net.createServer(() => {})
    await new Promise<void>((resolve, reject) => {
      blocker.once('listening', () => resolve())
      blocker.once('error', reject)
      blocker.listen(redirectPort, '127.0.0.1')
    })

    const failedFlow = connectChatGptOAuth()
    const bindError = await failedFlow.credentials.then(
      () => null,
      (error: unknown) => error,
    )
    expect(bindError).toBeInstanceOf(Error)

    // Free the port so the replacement flow can bind it.
    await new Promise<void>((resolve) => {
      blocker.once('close', () => resolve())
      blocker.close()
    })

    const replacement = connectChatGptOAuth()

    // The queued release for the failed bind settles immediately instead of
    // waiting out the hard cap, so the replacement flow's server binds the
    // freed port within a bounded window far below that cap.
    const rebindDeadline = Date.now() + 3_000
    let rebound = false
    while (Date.now() < rebindDeadline) {
      if (await tryConnect()) {
        rebound = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(rebound).toBe(true)

    void replacement.credentials.catch(() => {})
    stopChatGptOAuthServer()
  })

  test('a late redirect from a superseded flow does not kill the active flow', async () => {
    const redirect = new URL(testRedirectUri)
    const loopbackBase = `http://127.0.0.1:${redirect.port}`
    const callbackPath = redirect.pathname

    const flow = connectChatGptOAuth()
    const state = new URL(flow.authUrl).searchParams.get('state')

    // Wait (bounded) for the active flow's callback server to bind this
    // test's redirect port; a probe to a non-callback path answers 404 without
    // touching the flow.
    const bindDeadline = Date.now() + 2_000
    let bound = false
    while (Date.now() < bindDeadline) {
      try {
        const probe = await originalFetch(`${loopbackBase}/not-the-callback`)
        if (probe.status === 404) {
          bound = true
          break
        }
      } catch {
        // Not bound yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(bound).toBe(true)

    // A stale tab from a superseded flow completes late: its redirect —
    // carrying the OLD flow's state — lands on the NEW flow's server on the
    // same test redirect port. The mismatch must be answered with the retry
    // without terminally settling the active flow.
    const mismatchRes = await originalFetch(
      `${loopbackBase}${callbackPath}?code=abc&state=stale-flow-state`,
    )
    expect(mismatchRes.status).toBe(400)
    expect(await mismatchRes.text()).toContain('state mismatch')

    // A stray local request with no state at all gets the same treatment.
    const noStateRes = await originalFetch(
      `${loopbackBase}${callbackPath}?code=abc`,
    )
    expect(noStateRes.status).toBe(400)

    const stillPending = await Promise.race([
      flow.credentials.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 100)
      }),
    ])
    expect(stillPending).toBe('pending')

    // The flow is still alive: a genuine callback carrying THIS flow's state
    // completes it normally.
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const okRes = await originalFetch(
      `${loopbackBase}${callbackPath}?code=good&state=${state}`,
    )
    expect(okRes.status).toBe(200)

    const credentials = await flow.credentials
    expect(credentials.accessToken).toBe('access-token')
    expect(credentials.refreshToken).toBe('refresh-token')
  })

  test('a token exchange still in flight when the flow settles is discarded, not persisted or written', async () => {
    const redirect = new URL(testRedirectUri)
    const loopbackBase = `http://127.0.0.1:${redirect.port}`
    const callbackPath = redirect.pathname

    const flow = connectChatGptOAuth()
    const state = new URL(flow.authUrl).searchParams.get('state')

    // Wait (bounded) for the callback server to bind this test's redirect port.
    const bindDeadline = Date.now() + 2_000
    let bound = false
    while (Date.now() < bindDeadline) {
      try {
        const probe = await originalFetch(`${loopbackBase}/not-the-callback`)
        if (probe.status === 404) {
          bound = true
          break
        }
      } catch {
        // Not bound yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(bound).toBe(true)

    // Hold the token exchange in flight: the callback handler is awaiting
    // this fetch when the flow settles below.
    let releaseExchange: (response: unknown) => void = () => {}
    const exchangeGate = new Promise((resolve) => {
      releaseExchange = resolve
    })
    globalThis.fetch = mock(() => exchangeGate) as unknown as typeof fetch

    // Deliver a legitimate callback carrying THIS flow's state while the
    // exchange hangs in flight.
    const callbackRequest = originalFetch(
      `${loopbackBase}${callbackPath}?code=good&state=${state}`,
    ).then(
      (res) => res,
      (error: unknown) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Settle the flow out from under the in-flight exchange — the same
    // dispose+reject path the callback-server timeout takes.
    void flow.credentials.catch(() => {})
    stopChatGptOAuthServer()
    const settleError = await flow.credentials.then(
      () => null,
      (error: unknown) => error,
    )
    expect(settleError).toBeInstanceOf(Error)
    expect((settleError as Error).message).toBe(
      'ChatGPT OAuth flow was cancelled',
    )

    // The exchange finally completes — for a flow that no longer exists.
    releaseExchange({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'late-access-token',
        refresh_token: 'late-refresh-token',
        expires_in: 3600,
      }),
    })

    // The handler must never write the success page to the disposed server's
    // socket: the browser's request is aborted by the teardown (never
    // answered with 200), and the late token result is never persisted.
    const outcome = await callbackRequest
    const status =
      outcome instanceof Error ? undefined : (outcome as Response).status
    expect(status).not.toBe(200)
    expect(saveChatGptOAuthCredentialsCalls).toBe(0)
  })
})
