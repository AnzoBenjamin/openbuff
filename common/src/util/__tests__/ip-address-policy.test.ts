import { describe, expect, it } from 'bun:test'

import {
  canonicalizeIpv4,
  classifyHost,
  classifyIpAddress,
  parseIpv6Literal,
} from '../ip-address-policy'

describe('ip-address-policy (N05)', () => {
  it('parses every IPv6 compression and embedded-IPv4 form', () => {
    expect(parseIpv6Literal('::ffff:127.0.0.1')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
    ])
    expect(parseIpv6Literal('[::ffff:7f00:1]')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
    ])
    expect(parseIpv6Literal('::127.0.0.1')).toEqual([
      0, 0, 0, 0, 0, 0, 0x7f00, 1,
    ])
    expect(parseIpv6Literal('1:2:3:4:5:6:7.8.9.10')).toEqual([
      1, 2, 3, 4, 5, 6, 0x708, 0x90a,
    ])
    expect(parseIpv6Literal('fe80::1%eth0')).toEqual([
      0xfe80, 0, 0, 0, 0, 0, 0, 1,
    ])
    expect(parseIpv6Literal('not-ipv6')).toBeNull()
  })

  it('canonicalizes decimal, octal, hex and shorthand IPv4', () => {
    expect(canonicalizeIpv4('2130706433')).toBe('127.0.0.1')
    expect(canonicalizeIpv4('0177.0.0.1')).toBe('127.0.0.1')
    expect(canonicalizeIpv4('0x7f.1')).toBe('127.0.0.1')
    expect(canonicalizeIpv4('127.1')).toBe('127.0.0.1')
    expect(canonicalizeIpv4('0x8.8.8.8')).toBe('8.8.8.8')
    expect(canonicalizeIpv4('08.0.0.1')).toBeNull()
    expect(canonicalizeIpv4('256.0.0.1')).toBeNull()
  })

  it('unmaps IPv4-mapped, compatible, SIIT, NAT64 and 6to4 before applying v4 rules', () => {
    const cases: Array<[string, string, string]> = [
      ['::ffff:7f00:1', 'loopback', '127.0.0.1'],
      ['::ffff:a9fe:a9fe', 'metadata', '169.254.169.254'],
      ['::7f00:1', 'loopback', '127.0.0.1'],
      ['::ffff:0:a00:1', 'private', '10.0.0.1'],
      ['64:ff9b::7f00:1', 'loopback', '127.0.0.1'],
      ['2002:c0a8:101::1', 'private', '192.168.1.1'],
      ['::ffff:808:808', 'public', '8.8.8.8'],
    ]
    for (const [address, category, embedded] of cases) {
      const c = classifyIpAddress(address)
      expect(c.category).toBe(category as never)
      expect(c.embeddedIpv4).toBe(embedded)
      expect(c.blocked).toBe(category !== 'public')
    }
  })

  it('names each blocked range', () => {
    const cases: Array<[string, string]> = [
      ['0.0.0.0', 'unspecified'],
      ['::', 'unspecified'],
      ['127.0.0.1', 'loopback'],
      ['::1', 'loopback'],
      ['10.0.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.0.1', 'private'],
      ['100.64.0.1', 'cgnat'],
      ['100.127.255.255', 'cgnat'],
      ['169.254.1.1', 'link_local'],
      ['fe80::1', 'link_local'],
      ['fc00::1', 'unique_local'],
      ['fd12:3456::1', 'unique_local'],
      ['224.0.0.1', 'multicast'],
      ['ff02::1', 'multicast'],
      ['169.254.169.254', 'metadata'],
      ['100.100.100.200', 'metadata'],
      ['fd00:ec2::254', 'metadata'],
      ['2001:db8::1', 'documentation'],
      ['240.0.0.1', 'reserved'],
      ['8.8.8.8', 'public'],
      ['100.63.255.255', 'public'],
      ['2606:4700:4700::1111', 'public'],
    ]
    for (const [address, category] of cases) {
      expect(classifyIpAddress(address).category).toBe(category as never)
    }
  })

  it('classifies hosts: literals, local names and ordinary names', () => {
    expect(classifyHost('[::ffff:7f00:1]')).toMatchObject({
      blocked: true,
      isIpLiteral: true,
    })
    expect(classifyHost('0x7f000001')).toMatchObject({
      blocked: true,
      address: '127.0.0.1',
    })
    expect(classifyHost('99999999999')).toMatchObject({
      blocked: true,
      category: 'invalid',
    })
    expect(classifyHost('LOCALHOST.')).toMatchObject({
      blocked: true,
      category: 'blocked_name',
    })
    expect(classifyHost('db.internal')).toMatchObject({ blocked: true })
    expect(classifyHost('example.com')).toMatchObject({
      blocked: false,
      category: 'hostname',
    })
    expect(classifyHost('8.8.8.8')).toMatchObject({
      blocked: false,
      address: '8.8.8.8',
    })
  })
})
