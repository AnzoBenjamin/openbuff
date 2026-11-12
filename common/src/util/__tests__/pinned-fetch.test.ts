import { afterEach, describe, expect, it } from 'bun:test'

import {
  buildPinnedRequest,
  fetchPinnedAddress,
  nodePinnedRequest,
} from '../pinned-fetch'

/**
 * N05: the pinned transports really connect to the pinned address, not to
 * whatever the hostname resolves to. The hostname used here does not exist
 * in DNS, so a request that reached the fixture can only have used the pin.
 */
describe('pinned fetch transports', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => {
    server?.stop(true)
    server = undefined
  })

  const startEcho = () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new Response(`host=${request.headers.get('host')}`, {
          headers: { 'x-fixture': 'yes' },
        }),
    })
    return server.port
  }

  it('fetch path dials the pinned IP and sends the original Host', async () => {
    const port = startEcho()
    const url = new URL(`http://pinned-host.invalid:${port}/path`)
    const response = await fetchPinnedAddress(url, '127.0.0.1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(`host=pinned-host.invalid:${port}`)
  })

  it('node:http path dials the pinned IP through the lookup hook', async () => {
    const port = startEcho()
    const url = new URL(`http://pinned-host.invalid:${port}/path`)
    const response = await nodePinnedRequest(url, '127.0.0.1')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-fixture')).toBe('yes')
    expect(await response.text()).toBe(`host=pinned-host.invalid:${port}`)
  })

  it('node path is used for https when tls.serverName is unsupported', async () => {
    // Nothing listens on this port; the error proves the node transport
    // tried the pinned address rather than resolving the fake hostname.
    const url = new URL('https://pinned-host.invalid:1/')
    await expect(
      fetchPinnedAddress(
        url,
        '127.0.0.1',
        {},
        { supportsTlsServerName: false },
      ),
    ).rejects.toThrow(/ECONNREFUSED|refused|connect/i)
  })

  it('buildPinnedRequest keeps SNI, Host and manual redirects', () => {
    const pinned = buildPinnedRequest(
      new URL('https://docs.example.com/a?b=1'),
      '2606:4700:4700::1111',
      { headers: { 'user-agent': 'test' }, redirect: 'follow' },
    )
    expect(pinned.url.href).toBe('https://[2606:4700:4700::1111]/a?b=1')
    expect(new Headers(pinned.init.headers).get('host')).toBe(
      'docs.example.com',
    )
    expect(new Headers(pinned.init.headers).get('user-agent')).toBe('test')
    expect(pinned.init.tls?.serverName).toBe('docs.example.com')
    expect(pinned.init.redirect).toBe('manual')
  })
})
