import { describe, expect, it } from 'bun:test'

import { isBlockedMcpAddress } from '@codebuff/common/mcp/client'
import {
  McpDnsRebindingError,
  createPinnedMcpFetch,
  resolvePinnedMcpAddress,
} from '@codebuff/common/mcp/dns-pinning'
import { isBlockedHost } from '@codebuff/common/util/ip-address-policy'

/**
 * N05: client-origin MCP servers use the same egress classifier as web
 * fetch. web-media-evals-01 showed isBlockedMcpAddress('::ffff:7f00:1')
 * returned false.
 */
const PRIVATE_HOSTS = [
  '::ffff:7f00:1',
  '::ffff:127.0.0.1',
  '::ffff:a9fe:a9fe',
  '::127.0.0.1',
  '::7f00:1',
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '2002:7f00:1::',
  '2130706433',
  '0177.0.0.1',
  '0x7f000001',
  '127.1',
  '100.64.0.1',
  'fd00:ec2::254',
  'fe80::1',
  'ff02::1',
  '::',
]

describe('MCP address policy (N05)', () => {
  it('blocks mapped, compatible, NAT64 and numeric forms', () => {
    for (const host of PRIVATE_HOSTS) {
      expect(isBlockedMcpAddress(host)).toBe(true)
    }
  })

  it('agrees with the shared web classifier on every vector', () => {
    for (const host of [
      ...PRIVATE_HOSTS,
      '8.8.8.8',
      'example.com',
      '::ffff:8.8.8.8',
    ]) {
      expect(isBlockedMcpAddress(host)).toBe(isBlockedHost(host))
    }
  })

  it('allows public hosts', () => {
    for (const host of [
      '8.8.8.8',
      'example.com',
      '2606:4700:4700::1111',
      '0x8.8.8.8',
    ]) {
      expect(isBlockedMcpAddress(host)).toBe(false)
    }
  })

  it('refuses a client-origin URL whose bracketed host is an IPv4-mapped loopback', async () => {
    await expect(
      resolvePinnedMcpAddress(new URL('http://[::ffff:127.0.0.1]:8080/mcp'), {
        resolveHost: async () => {
          throw new Error('no DNS expected')
        },
      }),
    ).rejects.toBeInstanceOf(McpDnsRebindingError)
  })

  it('refuses a hostname that resolves to a hex-form mapped address', async () => {
    await expect(
      resolvePinnedMcpAddress(new URL('https://mcp.attacker.example/'), {
        resolveHost: async () => ['::ffff:a9fe:a9fe'],
      }),
    ).rejects.toThrow('private/loopback/link-local/metadata')
  })

  it('DNS rebinding: the pinned MCP fetch re-validates per request', async () => {
    let lookups = 0
    const fetchPinned = createPinnedMcpFetch({
      supportsTlsServerName: true,
      resolveHost: async () => {
        lookups++
        return lookups === 1 ? ['93.184.216.34'] : ['64:ff9b::7f00:1']
      },
    })
    const original = globalThis.fetch
    const dialed: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      dialed.push(input instanceof Request ? input.url : input.toString())
      return new Response('{}')
    }) as typeof globalThis.fetch
    try {
      await fetchPinned('http://rebind.attacker.example/mcp')
      await expect(
        fetchPinned('http://rebind.attacker.example/mcp'),
      ).rejects.toBeInstanceOf(McpDnsRebindingError)
    } finally {
      globalThis.fetch = original
    }
    expect(dialed).toEqual(['http://93.184.216.34/mcp'])
  })
})
