import { describe, expect, test } from 'bun:test'

import {
  allowedLoopbackMcpFromEnv,
  createPinnedMcpFetch,
  isAllowedLoopbackMcpAuthority,
  McpDnsRebindingError,
  resolvePinnedMcpAddress,
} from '../dns-pinning'

/**
 * NEW-7 DNS-rebinding pinning (§12.3 / §12.8 NEW-7).
 *
 * The literal-hostname SSRF guard in `client.ts` (isBlockedMcpAddress) is
 * covered in client.test.ts; these tests cover the DNS-resolution layer added
 * on top of it: a hostname that resolves to a private/metadata address is
 * refused AFTER resolution (closing the TOCTOU gap), resolution failure is
 * fail-closed, the pinned fetch never follows redirects, and https on a
 * runtime without the Bun `tls` extension is refused (fail closed) unless
 * the resolved address is an explicitly allowlisted loopback.
 */

describe('resolvePinnedMcpAddress (NEW-7)', () => {
  test('refuses a hostname that resolves to a private/metadata IP (fail closed post-resolution)', async () => {
    // Rebinding: the literal check passed on the bare hostname, but
    // resolution maps it to the link-local metadata address.
    const resolveHost = async () => ['169.254.169.254']
    await expect(
      resolvePinnedMcpAddress(new URL('http://rebind.attacker.com/'), {
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)

    const resolveToLoopback = async () => ['127.0.0.1']
    await expect(
      resolvePinnedMcpAddress(new URL('https://rebind.attacker.com/mcp'), {
        resolveHost: resolveToLoopback,
      }),
    ).rejects.toThrow(/private\/loopback/)
  })

  test('refuses when ANY resolved address is blocked even if others are public', async () => {
    // One public address plus one blocked address: the whole hostname is
    // refused, so an attacker cannot race the resolver across check/connect.
    const resolveHost = async () => ['93.184.216.34', '10.0.0.5']
    await expect(
      resolvePinnedMcpAddress(new URL('http://mixed.attacker.com/'), {
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)
  })

  test('fails closed when DNS resolution throws or returns no addresses', async () => {
    const throwing = async () => {
      throw new Error('ENOTFOUND')
    }
    await expect(
      resolvePinnedMcpAddress(new URL('http://nope.invalid/'), {
        resolveHost: throwing,
      }),
    ).rejects.toThrow(/DNS resolution failed/)

    const empty = async () => []
    await expect(
      resolvePinnedMcpAddress(new URL('http://nope.invalid/'), {
        resolveHost: empty,
      }),
    ).rejects.toThrow(/no addresses/)
  })

  test('never leaks a resolved IP address into the refusal error', async () => {
    const resolveHost = async () => ['10.1.2.3']
    let caught: unknown
    try {
      await resolvePinnedMcpAddress(new URL('http://rebind.attacker.com/'), {
        resolveHost,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpDnsRebindingError)
    expect(String(caught)).not.toContain('10.1.2.3')
    expect(String(caught)).toContain('rebind.attacker.com')
  })

  test('permits an allowlisted loopback address (serve.allowedLoopbackMcp)', async () => {
    const resolveHost = async () => ['127.0.0.1']
    const pin = await resolvePinnedMcpAddress(
      new URL('http://local-mcp.dev:8080/rpc'),
      { resolveHost, allowedLoopbackMcp: ['127.0.0.1:8080'] },
    )
    expect(pin).toEqual({ address: '127.0.0.1', port: '8080' })
  })

  test('never pins an allowlisted loopback address when a public address is also present', async () => {
    // Regression: the pin target must honor resolution ORDER-INDEPENDENT
    // preference for public addresses. An allowlisted loopback record that
    // appears BEFORE a public record must not be pinned.
    const loopbackFirst = async () => ['127.0.0.1', '93.184.216.34']
    const pin = await resolvePinnedMcpAddress(
      new URL('http://mixed-local.dev:8080/rpc'),
      { resolveHost: loopbackFirst, allowedLoopbackMcp: ['127.0.0.1:8080'] },
    )
    expect(pin).toEqual({ address: '93.184.216.34', port: '8080' })

    // ...and the public record stays the pin target in the reverse order too.
    const publicFirst = async () => ['93.184.216.34', '127.0.0.1']
    const pinReversed = await resolvePinnedMcpAddress(
      new URL('http://mixed-local.dev:8080/rpc'),
      { resolveHost: publicFirst, allowedLoopbackMcp: ['127.0.0.1:8080'] },
    )
    expect(pinReversed).toEqual({ address: '93.184.216.34', port: '8080' })
  })

  test('RF-3: an empty or absent allowlist fails closed for client-origin servers', async () => {
    // The shared allowlist matcher treats empty and undefined alike: no
    // entry is ever exempt from the blocklist.
    expect(isAllowedLoopbackMcpAuthority('127.0.0.1', '8080', undefined)).toBe(
      false,
    )
    expect(isAllowedLoopbackMcpAuthority('127.0.0.1', '8080', [])).toBe(false)
    // Even an exact loopback host:port that WOULD match a permissive
    // allowlist is refused when the allowlist is empty or absent.
    const resolveHost = async () => ['127.0.0.1']
    await expect(
      resolvePinnedMcpAddress(new URL('http://127.0.0.1:8080/rpc'), {
        resolveHost,
        allowedLoopbackMcp: [],
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)
    await expect(
      resolvePinnedMcpAddress(new URL('http://127.0.0.1:8080/rpc'), {
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)
  })

  test('resolves a public hostname to a pin target without throwing', async () => {
    const resolveHost = async () => ['93.184.216.34']
    const pin = await resolvePinnedMcpAddress(
      new URL('https://mcp.example.com/rpc'),
      { resolveHost },
    )
    expect(pin).toEqual({ address: '93.184.216.34', port: '' })
  })

  test('parses OPENBUFF_ALLOWED_LOOPBACK_MCP into host:port entries, or undefined', () => {
    // Unset / blank / empty entries all mean 'no allowlist' (fail closed).
    expect(allowedLoopbackMcpFromEnv({})).toBeUndefined()
    expect(allowedLoopbackMcpFromEnv({ OPENBUFF_ALLOWED_LOOPBACK_MCP: '' })).toBeUndefined()
    expect(allowedLoopbackMcpFromEnv({ OPENBUFF_ALLOWED_LOOPBACK_MCP: '  ' })).toBeUndefined()
    expect(allowedLoopbackMcpFromEnv({ OPENBUFF_ALLOWED_LOOPBACK_MCP: ' , , ' })).toBeUndefined()
    // Comma-separated entries are trimmed; whitespace-only entries dropped.
    expect(
      allowedLoopbackMcpFromEnv({
        OPENBUFF_ALLOWED_LOOPBACK_MCP: ' 127.0.0.1:8080 , [::1]:9000,  ',
      }),
    ).toEqual(['127.0.0.1:8080', '[::1]:9000'])
  })

  test('a literal IP is validated directly without DNS resolution', async () => {
    let resolved = false
    const resolveHost = async () => {
      resolved = true
      return []
    }
    // Blocked literal: refused with no resolution performed.
    await expect(
      resolvePinnedMcpAddress(new URL('http://169.254.169.254/'), {
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)
    expect(resolved).toBe(false)

    // Public literal: pinned to itself, still no resolution.
    const pin = await resolvePinnedMcpAddress(new URL('http://93.184.216.34/'), {
      resolveHost,
    })
    expect(pin).toEqual({ address: '93.184.216.34', port: '' })
    expect(resolved).toBe(false)
  })
})

describe('createPinnedMcpFetch (NEW-7)', () => {
  test('does not follow redirects (redirect: manual)', async () => {
    let seenInit: RequestInit | undefined
    const resolveHost = async () => ['93.184.216.34']
    const pinnedFetch = createPinnedMcpFetch({ resolveHost })

    // Stub global fetch to capture the init and return a redirect response.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seenInit = init
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      })
    }) as typeof fetch
    try {
      const response = await pinnedFetch('http://mcp.example.com/rpc', {
        method: 'POST',
      })
      // redirect: 'manual' surfaces the 302 to the caller instead of following
      // it to the (blocked) metadata address.
      expect(seenInit?.redirect).toBe('manual')
      expect(response.status).toBe(302)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('pins the request authority to the validated address and preserves Host/SNI', async () => {
    let seenUrl: string | undefined
    let seenInit: (RequestInit & { tls?: { serverName?: string } }) | undefined
    const resolveHost = async () => ['93.184.216.34']
    const pinnedFetch = createPinnedMcpFetch({ resolveHost })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seenUrl = input instanceof URL ? input.href : String(input)
      seenInit = init
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      await pinnedFetch('https://mcp.example.com/rpc?x=1', { method: 'POST' })
      // The socket dials the pinned IP literal...
      expect(seenUrl).toBe('https://93.184.216.34/rpc?x=1')
      // ...while the original hostname is preserved for Host routing and SNI.
      expect(new Headers(seenInit?.headers).get('host')).toBe(
        'mcp.example.com',
      )
      expect(seenInit?.tls?.serverName).toBe('mcp.example.com')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Node/undici (no tls extension): https fails closed instead of dialing unpinned', async () => {
    let fetchCalled = false
    const resolveHost = async () => ['93.184.216.34']
    const pinnedFetch = createPinnedMcpFetch({
      resolveHost,
      supportsTlsServerName: false,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      // Keeping the ORIGINAL https URL here would skip the authority pin and
      // reopen the check-then-connect DNS-rebinding TOCTOU, so the request
      // must be refused outright (fail closed) with the host named.
      await expect(
        pinnedFetch('https://mcp.example.com/rpc?x=1', { method: 'POST' }),
      ).rejects.toThrow(
        /mcp\.example\.com.*pinned https dial is unsupported on this runtime/,
      )
      await expect(
        pinnedFetch('https://mcp.example.com/rpc?x=1', { method: 'POST' }),
      ).rejects.toBeInstanceOf(McpDnsRebindingError)
      // No socket is ever opened: nothing dials unpinned https.
      expect(fetchCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Node/undici (no tls extension): an explicitly allowlisted loopback https address still dials the pinned path', async () => {
    let seenUrl: string | undefined
    let seenInit: RequestInit | undefined
    const resolveHost = async () => ['127.0.0.1']
    const pinnedFetch = createPinnedMcpFetch({
      resolveHost,
      supportsTlsServerName: false,
      allowedLoopbackMcp: ['127.0.0.1:8443'],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seenUrl = input instanceof URL ? input.href : String(input)
      seenInit = init
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      await pinnedFetch('https://local-mcp.dev:8443/rpc', { method: 'POST' })
      // The allowlisted loopback is exempt from the fail-closed refusal and
      // goes through the normal pinned path: the authority is the pinned
      // address while the original hostname stays on Host.
      expect(seenUrl).toBe('https://127.0.0.1:8443/rpc')
      expect(new Headers(seenInit?.headers).get('host')).toBe(
        'local-mcp.dev:8443',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Node/undici (no tls extension): http still pins the authority to the validated address', async () => {
    let seenUrl: string | undefined
    const resolveHost = async () => ['93.184.216.34']
    const pinnedFetch = createPinnedMcpFetch({
      resolveHost,
      supportsTlsServerName: false,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seenUrl = input instanceof URL ? input.href : String(input)
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      await pinnedFetch('http://mcp.example.com/rpc', { method: 'POST' })
      // http needs no SNI, so the authority pin still applies.
      expect(seenUrl).toBe('http://93.184.216.34/rpc')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refuses before opening any socket when resolution yields a blocked address', async () => {
    let fetchCalled = false
    const resolveHost = async () => ['169.254.169.254']
    const pinnedFetch = createPinnedMcpFetch({ resolveHost })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      await expect(
        pinnedFetch('http://rebind.attacker.com/rpc', { method: 'POST' }),
      ).rejects.toBeInstanceOf(McpDnsRebindingError)
      expect(fetchCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
