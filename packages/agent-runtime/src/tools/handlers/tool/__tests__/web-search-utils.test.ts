import { afterEach, describe, expect, it } from 'bun:test'

import {
  assertSafePublicWebUrl,
  fetchPublicWebUrl,
  isBlockedWebAddress,
} from '../web-search-utils'

import type { WebEgressOptions } from '../web-search-utils'

/**
 * N05 web egress safety. Every test injects the resolver and fetch, so no
 * real DNS or network is used except the loopback fixture server.
 */

const PUBLIC_IP = '93.184.216.34'

/** URL hosts that must be refused without any DNS lookup. */
const PRIVATE_URL_HOSTS = [
  // web-media-evals-01 confirmed bypasses
  '[::ffff:127.0.0.1]', // WHATWG URL turns this into [::ffff:7f00:1]
  '[::ffff:7f00:1]',
  '[::ffff:a9fe:a9fe]', // 169.254.169.254 cloud metadata
  '[::127.0.0.1]', // IPv4-compatible
  '[::7f00:1]',
  '[64:ff9b::7f00:1]', // NAT64
  '[64:ff9b::a9fe:a9fe]',
  '[64:ff9b::127.0.0.1]',
  '[::ffff:0:7f00:1]', // SIIT translated
  '[2002:7f00:1::]', // 6to4 embedding 127.0.0.1
  '[::ffff:10.0.0.1]',
  '[::ffff:c0a8:101]', // 192.168.1.1
  '[::ffff:6440:1]', // 100.64.0.1 CGNAT
  // decimal, octal and hex IPv4 forms
  '2130706433',
  '0177.0.0.1',
  '017700000001',
  '0x7f000001',
  '0x7f.0.0.1',
  '127.1',
  '0251.0376.0251.0376', // 169.254.169.254 in octal
  '2852039166', // 169.254.169.254 in decimal
  // plain ranges
  '127.0.0.1',
  '0.0.0.0',
  '10.1.2.3',
  '172.16.0.1',
  '192.168.0.1',
  '100.64.0.1',
  '169.254.169.254',
  '224.0.0.1',
  '255.255.255.255',
  '[::1]',
  '[::]',
  '[fc00::1]',
  '[fd00:ec2::254]', // AWS IMDS IPv6
  '[fe80::1]',
  '[ff02::1]',
  // names
  'localhost',
  'foo.localhost',
  'printer.local',
  'metadata.google.internal',
]

const noDns: WebEgressOptions['resolveHost'] = async (hostname) => {
  throw new Error(`unexpected DNS lookup for ${hostname}`)
}

type FetchCall = {
  url: string
  headers: Headers
  tls?: { serverName?: string }
}

function recordingFetch(
  respond: (call: FetchCall, index: number) => Response,
): { fetchImpl: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call: FetchCall = {
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      tls: (init as { tls?: { serverName?: string } } | undefined)?.tls,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof globalThis.fetch
  return { fetchImpl, calls }
}

describe('shared egress classifier (N05)', () => {
  it('blocks every private vector as a URL host before any DNS lookup', async () => {
    for (const host of PRIVATE_URL_HOSTS) {
      await expect(
        assertSafePublicWebUrl(`http://${host}/latest/meta-data`, {
          resolveHost: noDns,
        }),
      ).rejects.toThrow(/non-public (address|host)/)
    }
  })

  it('classifies resolved addresses through the same policy', () => {
    for (const address of [
      '::ffff:7f00:1',
      '::ffff:127.0.0.1',
      '::ffff:a9fe:a9fe',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      'fe80::1%eth0',
      '198.18.0.1',
      'not-an-ip',
    ]) {
      expect(isBlockedWebAddress(address)).toBe(true)
    }
    for (const address of [
      '8.8.8.8',
      PUBLIC_IP,
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
    ]) {
      expect(isBlockedWebAddress(address)).toBe(false)
    }
  })

  it('still accepts public literals and public hostnames', async () => {
    await expect(
      assertSafePublicWebUrl('https://8.8.8.8/', { resolveHost: noDns }),
    ).resolves.toBeInstanceOf(URL)
    await expect(
      assertSafePublicWebUrl('https://[2606:4700:4700::1111]/', {
        resolveHost: noDns,
      }),
    ).resolves.toBeInstanceOf(URL)
    await expect(
      assertSafePublicWebUrl('https://docs.example.com/', {
        resolveHost: async () => [PUBLIC_IP, '2606:4700:4700::1111'],
      }),
    ).resolves.toBeInstanceOf(URL)
  })
})

describe('pinned public fetch (N05)', () => {
  it('dials the validated address and keeps Host and SNI for the original name', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('public page', { status: 200 }),
    )
    const { response, finalUrl } = await fetchPublicWebUrl({
      url: 'https://docs.example.com/guide',
      signal: new AbortController().signal,
      egress: {
        resolveHost: async () => [PUBLIC_IP],
        fetchImpl,
        supportsTlsServerName: true,
      },
    })
    expect(await response.text()).toBe('public page')
    expect(finalUrl.href).toBe('https://docs.example.com/guide')
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).hostname).toBe(PUBLIC_IP)
    expect(calls[0].headers.get('host')).toBe('docs.example.com')
    expect(calls[0].tls?.serverName).toBe('docs.example.com')
  })

  it('refuses a public URL that redirects to each private vector', async () => {
    for (const host of PRIVATE_URL_HOSTS) {
      const { fetchImpl, calls } = recordingFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `http://${host}/secret` },
          }),
      )
      await expect(
        fetchPublicWebUrl({
          url: 'https://public.example/start',
          signal: new AbortController().signal,
          egress: {
            resolveHost: async (name) => {
              if (name === 'public.example') return [PUBLIC_IP]
              throw new Error(`unexpected DNS lookup for ${name}`)
            },
            fetchImpl,
            supportsTlsServerName: true,
          },
        }),
      ).rejects.toThrow(/non-public (address|host)/)
      expect(calls).toHaveLength(1)
    }
  })

  it('refuses a redirect to a hostname that resolves to a private address', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'http://internal-admin.example/' },
        }),
    )
    await expect(
      fetchPublicWebUrl({
        url: 'https://public.example/',
        signal: new AbortController().signal,
        egress: {
          resolveHost: async (name) =>
            name === 'public.example' ? [PUBLIC_IP] : ['10.0.0.7'],
          fetchImpl,
          supportsTlsServerName: true,
        },
      }),
    ).rejects.toThrow('resolved to non-public address')
    expect(calls).toHaveLength(1)
  })

  it('DNS rebinding: the connection uses the first (validated) lookup, not a second one', async () => {
    // Public on the first lookup, private on every later one.
    let lookups = 0
    const rebindingResolver = async () => {
      lookups++
      return lookups === 1 ? [PUBLIC_IP] : ['127.0.0.1']
    }
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('ok', { status: 200 }),
    )
    const { response } = await fetchPublicWebUrl({
      url: 'http://rebind.attacker.example/page',
      signal: new AbortController().signal,
      egress: { resolveHost: rebindingResolver, fetchImpl },
    })
    expect(response.status).toBe(200)
    expect(lookups).toBe(1)
    expect(calls).toHaveLength(1)
    // The socket target is the validated IP literal, so the runtime has no
    // hostname left to re-resolve.
    expect(new URL(calls[0].url).hostname).toBe(PUBLIC_IP)
    expect(calls[0].headers.get('host')).toBe('rebind.attacker.example')
  })

  it('DNS rebinding: a redirect back to the rebinding host is refused on its second lookup', async () => {
    let lookups = 0
    const rebindingResolver = async () => {
      lookups++
      return lookups === 1 ? [PUBLIC_IP] : ['169.254.169.254']
    }
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: '/latest/meta-data' },
        }),
    )
    await expect(
      fetchPublicWebUrl({
        url: 'http://rebind.attacker.example/',
        signal: new AbortController().signal,
        egress: { resolveHost: rebindingResolver, fetchImpl },
      }),
    ).rejects.toThrow('resolved to non-public address')
    expect(lookups).toBe(2)
    expect(calls).toHaveLength(1)
  })

  it('refuses a host whose answer mixes public and private addresses', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('x'))
    await expect(
      fetchPublicWebUrl({
        url: 'http://mixed.example/',
        signal: new AbortController().signal,
        egress: {
          resolveHost: async () => [PUBLIC_IP, '::ffff:7f00:1'],
          fetchImpl,
        },
      }),
    ).rejects.toThrow('resolved to non-public address')
    expect(calls).toHaveLength(0)
  })
})

describe('live loopback fixture (web-media-evals-01 reproduction)', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => {
    server?.stop(true)
    server = undefined
  })

  it('cannot read a 127.0.0.1 server through mapped, NAT64 or rebinding hosts', async () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('INTERNAL-SECRET'),
    })
    const port = server.port
    for (const url of [
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://[::ffff:7f00:1]:${port}/`,
      `http://[::7f00:1]:${port}/`,
      `http://[64:ff9b::7f00:1]:${port}/`,
      `http://2130706433:${port}/`,
      `http://0177.0.0.1:${port}/`,
    ]) {
      await expect(
        fetchPublicWebUrl({
          url,
          signal: new AbortController().signal,
          egress: { resolveHost: noDns },
        }),
      ).rejects.toThrow('non-public address')
    }
    await expect(
      fetchPublicWebUrl({
        url: `http://rebind.attacker.example:${port}/`,
        signal: new AbortController().signal,
        egress: { resolveHost: async () => ['127.0.0.1'] },
      }),
    ).rejects.toThrow('resolved to non-public address')
  })
})
