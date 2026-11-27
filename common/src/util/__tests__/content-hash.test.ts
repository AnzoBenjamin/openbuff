import { describe, expect, it } from 'bun:test'

import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  readCapabilityMatchesScope,
} from '../content-hash'
import { captureTextDocument, getRawReadBasis } from '../byte-text'

const scope = {
  projectId: '/workspace/project',
  path: 'src/value.ts',
  runId: 'run-123',
}

describe('read capabilities', () => {
  it('round-trips authenticated project/path/run-bound cap.v3 capabilities', () => {
    const capability = {
      startLine: 4,
      endLine: 8,
      hash: getContentHash('bound content'),
      scope,
    }
    const token = encodeReadCapabilityToken(capability)

    expect(token).toMatch(
      /^cap\.v3\.4\.8\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
    )
    const decoded = decodeReadCapabilityToken(token)
    expect(typeof decoded).toBe('object')
    if (typeof decoded !== 'string') {
      expect(decoded).toMatchObject({
        startLine: capability.startLine,
        endLine: capability.endLine,
        hash: capability.hash,
        tokenVersion: 'v3',
      })
      expect(decoded.scopeFingerprint).toHaveLength(43)
      expect(readCapabilityMatchesScope(decoded, scope)).toBe(true)
      expect(
        readCapabilityMatchesScope(decoded, {
          ...scope,
          path: 'src/other.ts',
        }),
      ).toBe(false)
      expect(
        readCapabilityMatchesScope(decoded, { ...scope, runId: 'other-run' }),
      ).toBe(false)
    }
  })

  it('normalizes only canonical path separators and dot segments', () => {
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('value'),
      scope: { ...scope, path: './src//value.ts' },
    })
    const decoded = decodeReadCapabilityToken(token)
    expect(typeof decoded).toBe('object')
    if (typeof decoded !== 'string') {
      expect(
        readCapabilityMatchesScope(decoded, {
          ...scope,
          path: 'src\\value.ts',
        }),
      ).toBe(true)
      expect(
        readCapabilityMatchesScope(decoded, {
          ...scope,
          path: ' src/value.ts',
        }),
      ).toBe(false)
      expect(
        readCapabilityMatchesScope(decoded, {
          ...scope,
          path: 'src/value.ts ',
        }),
      ).toBe(false)
      expect(
        readCapabilityMatchesScope(decoded, {
          ...scope,
          path: 'src/other.ts',
        }),
      ).toBe(false)
    }
  })

  it('uses a short authenticated handle for raw cap.v4 capabilities', () => {
    const content = 'value\n'
    const rawBasis = getRawReadBasis(
      captureTextDocument(content),
      1,
      1,
      'whole',
    )
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash(content),
      scope,
      rawBasis,
    })

    expect(token.startsWith('cap.v4.')).toBe(true)
    expect(token.length).toBeLessThan(100)
    expect(token).not.toContain('rawBasis')
    const decoded = decodeReadCapabilityToken(token)
    if (typeof decoded === 'string') throw new Error(decoded)
    expect(decoded).toMatchObject({
      startLine: 1,
      endLine: 1,
      hash: getContentHash(content),
      tokenVersion: 'v4',
      rawBasis,
    })
    expect(decoded.scopeFingerprint).toHaveLength(43)
    expect(readCapabilityMatchesScope(decoded, scope)).toBe(true)
    expect(
      readCapabilityMatchesScope(decoded, { ...scope, runId: 'other-run' }),
    ).toBe(false)

    const replacement = token.endsWith('A') ? 'B' : 'A'
    const tampered = `${token.slice(0, -1)}${replacement}`
    expect(decodeReadCapabilityToken(tampered)).toContain('malformed or unauthenticated')
  })

  it('rejects noncanonical signature spellings even when base64 padding decodes to identical bytes', () => {
    const content = 'value\n'
    const token = encodeReadCapabilityToken({ startLine: 1, endLine: 1, hash: getContentHash(content), scope,
      rawBasis: getRawReadBasis(captureTextDocument(content), 1, 1, 'whole') })
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const original = token.at(-1)!
    const alias = alphabet[alphabet.indexOf(original) ^ 1]!
    const aliased = token.slice(0, -1) + alias
    expect(aliased).not.toBe(token)
    expect(Buffer.from(aliased.split('.').at(-1)!, 'base64url')).toEqual(Buffer.from(token.split('.').at(-1)!, 'base64url'))
    expect(typeof decodeReadCapabilityToken(aliased)).toBe('string')
  })

  it('accepts harmless wrappers copied from a read result', () => {
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('value'),
      scope,
    })

    expect(decodeReadCapabilityToken(`readCapability=\"${token}\"`)).toEqual(
      decodeReadCapabilityToken(token),
    )
  })

  it('requires a canonical sha256 hash when encoding', () => {
    expect(() =>
      encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: 'legacy-hash',
        scope,
      }),
    ).toThrow('canonical sha256')
  })

  it('rejects empty normalized scope fields before signing', () => {
    const invalidScopes: Array<typeof scope> = [
      { ...scope, projectId: './' },
      { ...scope, path: './/' },
      { ...scope, runId: '.' },
    ]

    for (const invalidScope of invalidScopes) {
      expect(() =>
        encodeReadCapabilityToken({
          startLine: 1,
          endLine: 1,
          hash: getContentHash('value'),
          scope: invalidScope,
        }),
      ).toThrow('nonempty normalized projectId, path, and runId')
    }
  })

  it('rejects tampered cap.v3 capability payloads', () => {
    const token = encodeReadCapabilityToken({
      startLine: 4,
      endLine: 8,
      hash: getContentHash('bound content'),
      scope,
    })
    const tampered = token.replace('cap.v3.4.8.', 'cap.v3.4.9.')

    expect(decodeReadCapabilityToken(tampered)).toContain(
      'authentication failed',
    )
  })

  it('rejects cap.v2 tokens with a targeted re-read error', () => {
    const digest = Buffer.from('a'.repeat(64), 'hex').toString('base64url')
    const decoded = decodeReadCapabilityToken(`cap.v2.2.5.${digest}`)

    expect(decoded).toContain('expected an authenticated scoped readCapability')
    expect(decoded).toContain('Re-read the target')
    expect(decoded).toContain('fresh cap.v4 readCapability')
  })

  it('rejects legacy base64 payload tokens with a targeted re-read error', () => {
    const token = `cap.${Buffer.from(
      `2:5:${getContentHash('legacy')}`,
    ).toString('base64url')}`
    const decoded = decodeReadCapabilityToken(token)

    expect(decoded).toContain('expected an authenticated scoped readCapability')
    expect(decoded).toContain('Re-read the target')
    expect(decoded).toContain('fresh cap.v4 readCapability')
  })

  it('identifies legacy whole-file mutation tokens', () => {
    const decoded = decodeReadCapabilityToken('whole.legacy-token')

    expect(decoded).toContain('legacy mutation capability')
    expect(decoded).toContain('Re-read the target')
  })
})
