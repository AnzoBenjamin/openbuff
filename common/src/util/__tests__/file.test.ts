import { describe, expect, test } from 'bun:test'

import { resolveProjectRootOrEmpty } from '../file'

describe('resolveProjectRootOrEmpty', () => {
  test('returns the project root from a populated context', () => {
    expect(resolveProjectRootOrEmpty({ projectRoot: '/repo' })).toBe('/repo')
  })

  test('returns an empty string for a context with no projectRoot key', () => {
    expect(resolveProjectRootOrEmpty({})).toBe('')
  })

  test('returns an empty string for an undefined fileContext', () => {
    // The parameter is declared `| undefined`, so the absent-fileContext case
    // is exercised without a cast: passing `undefined` is a legal call, not a
    // suppressed type error.
    expect(resolveProjectRootOrEmpty(undefined)).toBe('')
  })

  test('returns an empty string when projectRoot is explicitly empty', () => {
    // Nullish coalescing: `''` is NOT nullish, so it is passed through. The
    // helper must not mask a deliberately empty root with some fallback.
    expect(resolveProjectRootOrEmpty({ projectRoot: '' })).toBe('')
  })

  test('preserves a relative project root verbatim', () => {
    // No normalization or resolution happens here by design: resolving an
    // empty or relative root would silently re-anchor on `process.cwd()`.
    expect(resolveProjectRootOrEmpty({ projectRoot: 'relative/project' })).toBe(
      'relative/project',
    )
  })

  test('does not throw for a context missing projectRoot', () => {
    // The regression this helper exists to prevent: a raw TypeError escaping
    // the handler instead of degrading to a rootless, fail-closed ''.
    expect(() => resolveProjectRootOrEmpty({})).not.toThrow()
  })
})
