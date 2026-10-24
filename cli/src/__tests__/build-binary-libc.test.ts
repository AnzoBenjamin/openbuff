import { describe, expect, it } from 'bun:test'

import {
  OPENTUI_SMOKE_OK_MARKER,
  assertOpentuiSmokeOutput,
  buildOpentuiSmokeArgs,
  resolveTargetOpentuiLibc,
} from '../../scripts/build-binary'

describe('resolveTargetOpentuiLibc', () => {
  it('returns null when OPENTUI_LIBC is unset on Linux', () => {
    expect(resolveTargetOpentuiLibc('linux', {})).toBeNull()
    expect(
      resolveTargetOpentuiLibc('linux', { OPENTUI_LIBC: undefined }),
    ).toBeNull()
  })

  it('returns null when OPENTUI_LIBC is empty on Linux', () => {
    expect(resolveTargetOpentuiLibc('linux', { OPENTUI_LIBC: '' })).toBeNull()
  })

  it('passes glibc and musl through on Linux', () => {
    expect(resolveTargetOpentuiLibc('linux', { OPENTUI_LIBC: 'glibc' })).toBe(
      'glibc',
    )
    expect(resolveTargetOpentuiLibc('linux', { OPENTUI_LIBC: 'musl' })).toBe(
      'musl',
    )
  })

  it('throws the runtime resolver message for any other non-empty value on Linux', () => {
    expect(() =>
      resolveTargetOpentuiLibc('linux', { OPENTUI_LIBC: 'alpine' }),
    ).toThrow(
      'On Linux, OPENTUI_LIBC must be unset, empty, "glibc", or "musl", got "alpine"',
    )
  })

  it('returns null on non-Linux targets regardless of OPENTUI_LIBC', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(resolveTargetOpentuiLibc(platform, {})).toBeNull()
      expect(
        resolveTargetOpentuiLibc(platform, { OPENTUI_LIBC: 'musl' }),
      ).toBeNull()
      expect(
        resolveTargetOpentuiLibc(platform, { OPENTUI_LIBC: 'not-a-libc' }),
      ).toBeNull()
    }
  })
})

describe('standalone-binary smoke helpers', () => {
  it('builds the --smoke-opentui probe argv', () => {
    expect(buildOpentuiSmokeArgs()).toEqual(['--smoke-opentui'])
  })

  it('accepts stdout containing the success marker', () => {
    expect(() =>
      assertOpentuiSmokeOutput("prefix\n" + OPENTUI_SMOKE_OK_MARKER + "\n"),
    ).not.toThrow()
  })

  it('fails closed when the success marker is missing', () => {
    expect(() => assertOpentuiSmokeOutput('opentui smoke fail')).toThrow(
      OPENTUI_SMOKE_OK_MARKER,
    )
  })
})
