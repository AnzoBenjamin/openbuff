import { isIP } from 'node:net'

/**
 * Shared egress address policy (N05). One classifier for every outbound path
 * that must not reach private infrastructure: the web fetch tool, its
 * redirect hops, and client-origin MCP servers.
 *
 * The classifier works on canonical numbers, not on string shapes, so every
 * spelling of the same address gets the same answer:
 *
 * - IPv4 in dotted, decimal-integer, octal, hex and inet_aton shorthand forms
 *   ('127.0.0.1', '2130706433', '0177.0.0.1', '0x7f.0.0.1', '127.1');
 * - IPv6 in any compression, with or without brackets or a zone id;
 * - IPv6 forms that embed an IPv4 address are unmapped and the embedded IPv4
 *   address is classified: IPv4-mapped (`::ffff:a.b.c.d` and the hex form
 *   `::ffff:7f00:1` that WHATWG URL produces), IPv4-compatible (`::a.b.c.d`,
 *   `::7f00:1`), NAT64 well-known prefix (`64:ff9b::/96`), SIIT-translated
 *   (`::ffff:0:a.b.c.d`) and 6to4 (`2002::/16`).
 *
 * Synchronous and dependency-free (node:net only). It performs no DNS
 * resolution: callers resolve names themselves and classify every address.
 */

export type IpAddressCategory =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'unique_local'
  | 'multicast'
  | 'metadata'
  | 'documentation'
  | 'reserved'
  | 'invalid'

export interface IpAddressClassification {
  blocked: boolean
  category: IpAddressCategory
  /** 4 or 6 for the literal as written; 0 when it is not an IP literal. */
  family: 0 | 4 | 6
  /** Dotted IPv4 address that was classified after unmapping, if any. */
  embeddedIpv4?: string
}

export type HostCategory = IpAddressCategory | 'blocked_name' | 'hostname'

export interface HostClassification {
  blocked: boolean
  category: HostCategory
  /** True when the host is an IP literal (any IPv4 spelling or IPv6). */
  isIpLiteral: boolean
  /** Canonical address for an IP literal (dotted IPv4 or compressed IPv6). */
  address?: string
  embeddedIpv4?: string
}

/** Cloud metadata endpoints that are not covered by a broader range name. */
const METADATA_IPV4 = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
])
/** AWS IMDS IPv6 endpoint fd00:ec2::254 (inside fc00::/7, reported as metadata). */
const METADATA_IPV6_HEXTETS = [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]

/**
 * Host names that always refer to the local machine or a metadata service.
 * Suffix rules (`.localhost`, `.local`, `.internal`) are applied separately.
 */
export const BLOCKED_EGRESS_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'metadata',
  'metadata.aws.internal',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal']

const ipv4ToString = (value: number): string =>
  [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')

function parseIpv4Component(component: string): number | null {
  if (/^0[xX][0-9a-fA-F]*$/.test(component)) {
    // '0x' alone is 0 under inet_aton and WHATWG URL.
    return component.length === 2 ? 0 : Number.parseInt(component.slice(2), 16)
  }
  if (/^0[0-7]+$/.test(component)) return Number.parseInt(component, 8)
  if (/^0[0-9]+$/.test(component)) return null // invalid octal, e.g. '08'
  if (/^[0-9]+$/.test(component)) return Number.parseInt(component, 10)
  return null
}

/** True when every dot-separated component looks numeric (decimal/octal/hex). */
export function isNumericIpv4Candidate(host: string): boolean {
  if (host.length === 0) return false
  return host
    .split('.')
    .every(
      (component) =>
        /^[0-9]+$/.test(component) || /^0[xX][0-9a-fA-F]*$/.test(component),
    )
}

/**
 * Parses an IPv4 literal in any inet_aton spelling to its 32-bit value.
 * Returns null when the text is not a valid numeric IPv4 encoding.
 */
export function parseIpv4Literal(host: string): number | null {
  if (!isNumericIpv4Candidate(host)) return null
  const components = host.split('.')
  if (components.length > 4) return null
  const values: number[] = []
  for (const component of components) {
    const value = parseIpv4Component(component)
    if (value === null || !Number.isFinite(value)) return null
    values.push(value)
  }
  const lastBytes = 5 - values.length
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 255) return null
  }
  const last = values[values.length - 1]
  if (last >= 256 ** lastBytes) return null
  let address = 0
  for (let i = 0; i < values.length - 1; i++) {
    address = address * 256 + values[i]
  }
  return address * 256 ** lastBytes + last
}

/** Canonical dotted form of any IPv4 spelling, or null. */
export function canonicalizeIpv4(host: string): string | null {
  const value = parseIpv4Literal(host)
  return value === null ? null : ipv4ToString(value)
}

/**
 * Parses an IPv6 literal (brackets and zone id allowed) into 8 hextets.
 * Returns null when the text is not valid IPv6.
 */
export function parseIpv6Literal(host: string): number[] | null {
  const text = host
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase()
  if (isIP(text) !== 6) return null

  let head = text
  const tail: number[] = []
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const parts = dotted[2].split('.').map(Number)
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3])
    head = dotted[1]
    // Keep a trailing '::' intact; drop a single trailing ':' separator.
    if (!head.endsWith('::')) head = head.slice(0, -1)
  }

  const toHextets = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16))

  const doubleColon = head.indexOf('::')
  let hextets: number[]
  if (doubleColon === -1) {
    hextets = [...toHextets(head), ...tail]
  } else {
    const left = toHextets(head.slice(0, doubleColon))
    const right = [...toHextets(head.slice(doubleColon + 2)), ...tail]
    const fill = 8 - left.length - right.length
    if (fill < 0) return null
    hextets = [...left, ...new Array<number>(fill).fill(0), ...right]
  }
  if (hextets.length !== 8 || hextets.some((h) => !(h >= 0 && h <= 0xffff))) {
    return null
  }
  return hextets
}

function classifyIpv4Value(value: number): IpAddressCategory {
  const a = (value >>> 24) & 255
  const b = (value >>> 16) & 255
  const c = (value >>> 8) & 255
  const dotted = ipv4ToString(value)
  if (METADATA_IPV4.has(dotted)) return 'metadata'
  if (a === 0) return value === 0 ? 'unspecified' : 'reserved' // 0.0.0.0/8
  if (a === 10) return 'private'
  if (a === 127) return 'loopback'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat' // 100.64.0.0/10
  if (a === 169 && b === 254) return 'link_local'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 192 && b === 0 && c === 0) return 'reserved' // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'documentation'
  if (a === 192 && b === 88 && c === 99) return 'reserved' // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved' // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'documentation'
  if (a === 203 && b === 0 && c === 113) return 'documentation'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved' // 240.0.0.0/4 and broadcast
  return 'public'
}

const result = (
  category: IpAddressCategory,
  family: 0 | 4 | 6,
  embeddedIpv4?: number,
): IpAddressClassification => ({
  blocked: category !== 'public',
  category,
  family,
  ...(embeddedIpv4 !== undefined
    ? { embeddedIpv4: ipv4ToString(embeddedIpv4) }
    : {}),
})

function classifyIpv6Hextets(h: number[]): IpAddressClassification {
  const v4At = (i: number): number => ((h[i] << 16) | h[i + 1]) >>> 0
  const zeroUntil = (end: number): boolean =>
    h.slice(0, end).every((x) => x === 0)

  if (zeroUntil(8)) return result('unspecified', 6)
  if (zeroUntil(7) && h[7] === 1) return result('loopback', 6)
  // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks).
  if (zeroUntil(6)) return result(classifyIpv4Value(v4At(6)), 6, v4At(6))
  // IPv4-mapped ::ffff:a.b.c.d.
  if (zeroUntil(5) && h[5] === 0xffff) {
    return result(classifyIpv4Value(v4At(6)), 6, v4At(6))
  }
  // SIIT IPv4-translated ::ffff:0:a.b.c.d.
  if (zeroUntil(4) && h[4] === 0xffff && h[5] === 0) {
    return result(classifyIpv4Value(v4At(6)), 6, v4At(6))
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return result(classifyIpv4Value(v4At(6)), 6, v4At(6))
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215) is site-specific.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1)
    return result('private', 6)
  // 6to4 2002:AABB:CCDD::/48 embeds an IPv4 address.
  if (h[0] === 0x2002) {
    const embedded = v4At(1)
    const category = classifyIpv4Value(embedded)
    return result(category, 6, embedded)
  }
  // Discard-only 100::/64.
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0)
    return result('reserved', 6)
  // Teredo 2001::/32 tunnels to an obfuscated IPv4 client; refuse outright.
  if (h[0] === 0x2001 && h[1] === 0) return result('reserved', 6)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return result('documentation', 6)
  if (h.every((x, i) => x === METADATA_IPV6_HEXTETS[i]))
    return result('metadata', 6)
  if ((h[0] & 0xfe00) === 0xfc00) return result('unique_local', 6) // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return result('link_local', 6) // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return result('private', 6) // deprecated site-local
  if ((h[0] & 0xff00) === 0xff00) return result('multicast', 6)
  return result('public', 6)
}

/**
 * Classifies an IP address literal. Non-IP text is `invalid` and blocked, so a
 * resolver that returns something unexpected fails closed.
 */
export function classifyIpAddress(address: string): IpAddressClassification {
  const text = address.replace(/^\[|\]$/g, '')
  if (isIP(text.split('%')[0]) === 4 || isNumericIpv4Candidate(text)) {
    const value = parseIpv4Literal(text)
    if (value === null) return result('invalid', 4)
    return result(classifyIpv4Value(value), 4)
  }
  const hextets = parseIpv6Literal(text)
  if (hextets) return classifyIpv6Hextets(hextets)
  return result('invalid', 0)
}

/** True when an IP literal is anything other than a public unicast address. */
export function isBlockedIpAddress(address: string): boolean {
  return classifyIpAddress(address).blocked
}

/**
 * Classifies a URL host (brackets allowed). IP literals in any spelling are
 * classified by address. A malformed numeric host fails closed. Other names
 * are blocked only when they are a known local/metadata name or use a local
 * suffix; any other hostname is `hostname` and not blocked here, because
 * deciding where it points needs DNS (see the pinned fetch helpers).
 */
export function classifyHost(host: string): HostClassification {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  const withoutDot = bare.replace(/\.+$/, '')

  const ipv6 = parseIpv6Literal(bare)
  if (ipv6) {
    const c = classifyIpv6Hextets(ipv6)
    return {
      blocked: c.blocked,
      category: c.category,
      isIpLiteral: true,
      address: bare.split('%')[0],
      ...(c.embeddedIpv4 ? { embeddedIpv4: c.embeddedIpv4 } : {}),
    }
  }
  if (isNumericIpv4Candidate(withoutDot)) {
    const value = parseIpv4Literal(withoutDot)
    if (value === null) {
      return { blocked: true, category: 'invalid', isIpLiteral: true }
    }
    const category = classifyIpv4Value(value)
    return {
      blocked: category !== 'public',
      category,
      isIpLiteral: true,
      address: ipv4ToString(value),
    }
  }
  if (
    BLOCKED_EGRESS_HOSTNAMES.has(withoutDot) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => withoutDot.endsWith(suffix))
  ) {
    return { blocked: true, category: 'blocked_name', isIpLiteral: false }
  }
  return { blocked: false, category: 'hostname', isIpLiteral: false }
}

/** True when a URL host is a blocked IP literal or a local/metadata name. */
export function isBlockedHost(host: string): boolean {
  return classifyHost(host).blocked
}
