import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { parseRawReadBasis } from './raw-read-basis'
import type { RawReadBasisV1 } from './raw-read-basis'

/**
 * Canonical CRLF→LF normalization shared by the read/edit toolchain so that
 * file-content hashes are stable across Windows/Unix checkouts.
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

/** Byte-exact sha256 used by filesystem mutation receipts and snapshots. */
export function getExactContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/**
 * Canonical sha256 content hash used by `read_files`, `replace_range`,
 * and `str_replace` for stale-edit / capability-token
 * validation. The hash is computed over the normalized (LF) content and
 * prefixed with `sha256:`.
 */
export function getContentHash(content: string): string {
  return getExactContentHash(normalizeLineEndings(content))
}

/** Whole-document observation hash; the leading UTF-8 BOM is metadata. */
export function getObservationContentHash(content: string): string {
  return getContentHash(
    content.startsWith('\uFEFF') ? content.slice(1) : content,
  )
}

// ---------------------------------------------------------------------------
// Read capability tokens
// ---------------------------------------------------------------------------

/**
 * A successfully decoded authenticated read capability: a 1-indexed inclusive
 * line range, the canonical sha256 hash of its LF-normalized content, and its
 * opaque project/path/run scope fingerprint.
 */
export type ReplacementReadCapability = {
  startLine: number
  endLine: number
  hash: string
  scopeFingerprint: string
  tokenVersion: 'v3' | 'v4'
  /** Present only in v4; authenticated along with the existing issuer/bounds/hash. */
  rawBasis?: RawReadBasisV1
}

export type ReadCapabilityScope = {
  /** Stable project/root identity for the current runtime view. */
  projectId: string
  /** Canonical project-relative target path. */
  path: string
  /** Issuing agent run. Tokens are deliberately invalid across runs. */
  runId: string
}

export type ReadCapabilityIssuer = Pick<
  ReadCapabilityScope,
  'projectId' | 'runId'
>

export const READ_CAPABILITY_TOKEN_PREFIX = 'cap.'
const READ_CAPABILITY_TOKEN_VERSION = 'v3'
const SHA256_HEX_PATTERN = /^sha256:([a-f0-9]{64})$/
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/
// Read capabilities use an in-process signing key. Restarting the runtime
// invalidates outstanding tokens unless a trusted handoff remints their facts.
const READ_CAPABILITY_SIGNING_KEY = randomBytes(32)

function normalizeScopeComponent(value: string): string {
  const withForwardSlashes = String(value ?? '').replaceAll('\\', '/')
  const rootPrefix = withForwardSlashes.startsWith('/') ? '/' : ''
  return (
    rootPrefix +
    withForwardSlashes
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/')
  )
}

export function hasAuthoritativeReadCapabilityScope(
  scope: ReadCapabilityScope,
): boolean {
  return (
    normalizeScopeComponent(scope.projectId) !== '' &&
    normalizeScopeComponent(scope.path) !== '' &&
    normalizeScopeComponent(scope.runId) !== ''
  )
}

export function getReadCapabilityScopeFingerprint(
  scope: ReadCapabilityScope,
): string {
  const projectId = normalizeScopeComponent(scope.projectId)
  const targetPath = normalizeScopeComponent(scope.path)
  const runId = String(scope.runId ?? '')
  return createHash('sha256')
    .update(`${projectId}\0${targetPath}\0${runId}`)
    .digest('base64url')
}

export function readCapabilityMatchesScope(
  capability: ReplacementReadCapability,
  scope: ReadCapabilityScope,
): boolean {
  return (
    (capability.tokenVersion === READ_CAPABILITY_TOKEN_VERSION ||
      capability.tokenVersion === 'v4') &&
    capability.scopeFingerprint === getReadCapabilityScopeFingerprint(scope)
  )
}

/**
 * Encodes cap.v4 when the original raw basis is supplied, or historical cap.v3
 * otherwise. Both authenticate the project/path/run scope, bounds and
 * observation hash; only v4 authenticates raw facts for fresh edit authority.
 */
export function encodeReadCapabilityToken(params: {
  startLine: number
  endLine: number
  hash: string
  scope: ReadCapabilityScope
  rawBasis?: RawReadBasisV1
}): string {
  const { startLine, endLine, hash, scope } = params
  if (!hasAuthoritativeReadCapabilityScope(scope)) {
    throw new Error(
      'Read capabilities require nonempty normalized projectId, path, and runId scope components.',
    )
  }

  const sha256Match = hash.match(SHA256_HEX_PATTERN)
  if (!sha256Match) {
    throw new Error(
      'Read capabilities require a canonical sha256 content hash.',
    )
  }

  const digest = Buffer.from(sha256Match[1]!, 'hex').toString('base64url')
  const scopeFingerprint = getReadCapabilityScopeFingerprint(scope)
  if (params.rawBasis !== undefined) {
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new RangeError(
        'Raw read capabilities require valid inclusive line bounds',
      )
    }
    const payload = Buffer.from(
      JSON.stringify({
        startLine,
        endLine,
        hash,
        scopeFingerprint,
        rawBasis: parseRawReadBasis(params.rawBasis),
      }),
    ).toString('base64url')
    const signedPayload = `v4.${payload}`
    const signature = createHmac('sha256', READ_CAPABILITY_SIGNING_KEY)
      .update(signedPayload)
      .digest('base64url')
    const token = `${READ_CAPABILITY_TOKEN_PREFIX}${signedPayload}.${signature}`
    if (token.length > 4096)
      throw new RangeError('Raw read capability exceeds its encoded byte limit')
    return token
  }
  const signedPayload = `${READ_CAPABILITY_TOKEN_VERSION}.${startLine}.${endLine}.${digest}.${scopeFingerprint}`
  const signature = createHmac('sha256', READ_CAPABILITY_SIGNING_KEY)
    .update(signedPayload)
    .digest('base64url')
  return `${READ_CAPABILITY_TOKEN_PREFIX}${signedPayload}.${signature}`
}

/**
 * Decodes authenticated cap.v3 and cap.v4 read capabilities. Returns a human-readable,
 * recoverable re-read error when the supplied value is malformed, unauthenticated,
 * or from any retired capability format.
 */
export function decodeReadCapabilityToken(
  token: string,
): ReplacementReadCapability | string {
  token = normalizeCopiedReadCapabilityToken(token)
  if (token.startsWith('cap.v4.')) return decodeRawReadCapabilityToken(token)
  if (token.startsWith('whole.')) {
    return `Invalid basedOnRead: ${JSON.stringify(token)} is a legacy mutation capability. Re-read the target with read_files and copy its fresh cap.v4 readCapability from the editAnchor.`
  }

  const v3Prefix = `${READ_CAPABILITY_TOKEN_PREFIX}${READ_CAPABILITY_TOKEN_VERSION}.`
  if (!token.startsWith(v3Prefix)) {
    return `Invalid basedOnRead: expected an authenticated scoped readCapability, but received ${JSON.stringify(token)}. Re-read the target with read_files and copy its fresh cap.v4 readCapability from the editAnchor.`
  }

  const match = token.match(
    /^cap\.v3\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/,
  )
  if (!match) {
    return `Invalid basedOnRead capability token: malformed cap.v3 payload. Re-read the target range with read_files and copy the readCapability from the fresh editAnchor.`
  }

  const startLine = Number(match[1])
  const endLine = Number(match[2])
  const digest = Buffer.from(match[3]!, 'base64url')
  const scopeFingerprint = match[4]!
  const signature = Buffer.from(match[5]!, 'base64url')
  const signedPayload = `${READ_CAPABILITY_TOKEN_VERSION}.${match[1]}.${match[2]}.${match[3]}.${scopeFingerprint}`
  const expectedSignature = createHmac('sha256', READ_CAPABILITY_SIGNING_KEY)
    .update(signedPayload)
    .digest()
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    digest.length !== 32 ||
    digest.toString('base64url') !== match[3] ||
    !BASE64URL_SHA256_PATTERN.test(scopeFingerprint) ||
    signature.length !== expectedSignature.length ||
    !timingSafeEqual(signature, expectedSignature)
  ) {
    return `Invalid basedOnRead capability token: authentication failed. Re-read the target range with read_files and copy the readCapability from the fresh editAnchor.`
  }

  return {
    startLine,
    endLine,
    hash: `sha256:${digest.toString('hex')}`,
    scopeFingerprint,
    tokenVersion: 'v3',
  }
}

function decodeRawReadCapabilityToken(
  token: string,
): ReplacementReadCapability | string {
  const invalid =
    'Invalid basedOnRead capability: malformed or unauthenticated cap.v4 raw basis. Re-read the target and copy its fresh readCapability.'
  if (token.length > 4096) return invalid
  const match = token.match(/^cap\.v4\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/)
  if (!match) return invalid
  const expected = createHmac('sha256', READ_CAPABILITY_SIGNING_KEY)
    .update(`v4.${match[1]}`)
    .digest()
  const supplied = Buffer.from(match[2]!, 'base64url')
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return invalid
  try {
    const bytes = Buffer.from(match[1]!, 'base64url')
    if (bytes.toString('base64url') !== match[1]) return invalid
    const payload: unknown = JSON.parse(bytes.toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return invalid
    const data = payload as Record<string, unknown>
    if (
      Object.keys(data).sort().join(',') !==
        'endLine,hash,rawBasis,scopeFingerprint,startLine' ||
      !Number.isSafeInteger(data.startLine) ||
      !Number.isSafeInteger(data.endLine) ||
      (data.startLine as number) < 1 ||
      (data.endLine as number) < (data.startLine as number) ||
      typeof data.hash !== 'string' ||
      !SHA256_HEX_PATTERN.test(data.hash) ||
      typeof data.scopeFingerprint !== 'string' ||
      !BASE64URL_SHA256_PATTERN.test(data.scopeFingerprint)
    ) {
      return invalid
    }
    return {
      startLine: data.startLine as number,
      endLine: data.endLine as number,
      hash: data.hash,
      scopeFingerprint: data.scopeFingerprint,
      tokenVersion: 'v4',
      rawBasis: parseRawReadBasis(data.rawBasis),
    }
  } catch {
    return invalid
  }
}

function normalizeCopiedReadCapabilityToken(token: string): string {
  let normalized = token.trim()
  normalized = normalized.replace(/^readCapability\s*=\s*/i, '')
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith('`') && normalized.endsWith('`')))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized
}
