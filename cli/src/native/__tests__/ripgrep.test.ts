import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getRgPath,
  resetRgPathCache,
  RG_SHA256,
  verifyExtractedRipgrep,
} from '../ripgrep'

/**
 * Note on coverage: the extraction fast path (`verifyOnDiskRipgrep`) is
 * module-private and delegates to the same digest comparison as
 * `verifyExtractedRipgrep`, so the shared verify logic is exercised here
 * through the exported surface only.
 */

const HEX64 = /^[0-9a-f]{64}$/

// The pinned digests are for the real vendored ripgrep binaries, so no test
// buffer can hash to them. The verification tests inject a temporary map
// entry keyed to a known fixture digest (and remove it again afterwards) so
// match / mismatch behavior is observable through the exported surface.
const TEST_KEY = '__test__/ripgrep/rg'
const EMPTY_BYTES = new Uint8Array(0)
// `Uint8Array.buffer` is typed ArrayBufferLike; verifyExtractedRipgrep takes
// a concrete ArrayBuffer, so the fixture buffers are narrowed once here.
const EMPTY_BUFFER = EMPTY_BYTES.buffer as ArrayBuffer
const EMPTY_DIGEST = createHash('sha256').update(EMPTY_BYTES).digest('hex')

describe('RG_SHA256 pinned digests', () => {
  test('declares a non-empty 64-hex sha256 digest for every platform key', () => {
    const entries = Object.entries(RG_SHA256)

    expect(entries.length).toBeGreaterThan(0)
    for (const [key, digest] of entries) {
      expect(key.length).toBeGreaterThan(0)
      expect(digest).toMatch(HEX64)
    }
  })

  test('contains no UNPINNED sentinel or placeholder values', () => {
    for (const digest of Object.values(RG_SHA256)) {
      expect(digest.toLowerCase()).not.toBe('unpinned')
      expect(HEX64.test(digest)).toBe(true)
    }
  })
})

describe('verifyExtractedRipgrep', () => {
  beforeEach(() => {
    RG_SHA256[TEST_KEY] = EMPTY_DIGEST
  })

  afterEach(() => {
    delete RG_SHA256[TEST_KEY]
  })

  test('returns true when the buffer hashes to the pinned digest', () => {
    expect(verifyExtractedRipgrep(EMPTY_BUFFER, TEST_KEY)).toBe(true)
  })

  test('returns false when the bytes are tampered', () => {
    const tampered = new Uint8Array([0x00])

    expect(createHash('sha256').update(tampered).digest('hex')).not.toBe(
      EMPTY_DIGEST,
    )
    expect(
      verifyExtractedRipgrep(tampered.buffer as ArrayBuffer, TEST_KEY),
    ).toBe(false)
  })

  test('resolves the pinned digest by path suffix, not just an exact key', () => {
    const prefixedPath = `/tmp/extracted/somewhere/${TEST_KEY}`

    // Matching bytes must pass and tampered bytes must fail through the SAME
    // suffix-resolved entry — a suffix "true" alone would be indistinguishable
    // from the unknown-path skip.
    expect(verifyExtractedRipgrep(EMPTY_BUFFER, prefixedPath)).toBe(true)
    expect(
      verifyExtractedRipgrep(
        new Uint8Array([0x01]).buffer as ArrayBuffer,
        prefixedPath,
      ),
    ).toBe(false)
  })

  test('skips verification (returns true) when no digest is pinned for the path', () => {
    // Documents the current fail-open skip behavior for unknown paths, as
    // described in the module's own JSDoc.
    expect(
      verifyExtractedRipgrep(EMPTY_BUFFER, '/no/entry/resolves/rg'),
    ).toBe(true)
  })
})

describe('getRgPath cache', () => {
  beforeEach(() => {
    resetRgPathCache()
  })

  afterEach(() => {
    resetRgPathCache()
  })

  test('returns the same cached promise across consecutive calls', () => {
    const first = getRgPath()
    const second = getRgPath()

    first.catch(() => {}) // the promise identity is what is under test
    expect(second).toBe(first)
  })

  test('resetRgPathCache forces a fresh promise on the next call', () => {
    const before = getRgPath()

    before.catch(() => {})
    resetRgPathCache()

    const after = getRgPath()
    after.catch(() => {}) // identity, not resolution, is under test
    expect(after).not.toBe(before)
  })
})
