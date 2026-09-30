import { describe, expect, test } from 'bun:test'
import path from 'path'

import {
  getTrustedRootsPath,
  isTrustedProjectRoot,
  loadTrustedRoots,
  resolveTrustedRootsPath,
  TRUSTED_ROOTS_PATH,
} from '../trusted-roots'

import type { LoadTrustedRootsOptions } from '../trusted-roots'

/**
 * Fully hermetic: every loadTrustedRoots dependency is injected, so no test
 * ever touches the real home directory or the real filesystem.
 */
function makeOptions(
  overrides?: Partial<LoadTrustedRootsOptions>,
): { options: LoadTrustedRootsOptions; warnings: string[] } {
  const warnings: string[] = []
  return {
    options: {
      // Hermetic env: production defaults read the live CLI env, so tests
      // inject an empty override to pin the home-based fallback path.
      env: {},
      homeDir: '/home/tester',
      // Pin the platform so the POSIX-only mode gate behaves identically on
      // every host (win32 skips the gate; the win32 behavior has its own
      // explicit tests below).
      platform: 'linux' as NodeJS.Platform,
      statMode: () => 0o600,
      warn: (line: string) => warnings.push(line),
      ...overrides,
    },
    warnings,
  }
}

const expectedAllowlistPath = path.join('/home/tester', TRUSTED_ROOTS_PATH)

describe('loadTrustedRoots', () => {
  test('returns [] when the allowlist file is missing', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => {
        throw new Error('ENOENT: no such file or directory')
      },
      statMode: () => undefined,
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
    expect(warnings).toEqual([])
  })

  test('returns [] on corrupt JSON', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '{not json',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
    expect(warnings).toEqual([])
  })

  test('returns [] when the payload is not an array', async () => {
    const { options } = makeOptions({
      readFile: () => '{"roots": ["/repo"]}',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
  })

  test('returns [] when the payload is a bare JSON string', async () => {
    const { options } = makeOptions({
      readFile: () => '"just a string"',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
  })

  test('returns [] when any entry is not a string', async () => {
    const { options } = makeOptions({
      readFile: () => '["/repo", 42, null]',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
  })

  test.each([[0o640], [0o644], [0o604]])(
    'returns [] and warns when the mode has any group/other bit (mode %s)',
    async (mode) => {
      const { options, warnings } = makeOptions({
        readFile: () => '["/repo"]',
        statMode: () => mode,
      })

      await expect(loadTrustedRoots(options)).resolves.toEqual([])
      expect(warnings).toHaveLength(1)
      // The warning names the path, never the allowlist contents.
      expect(warnings[0]).toContain(expectedAllowlistPath)
      expect(warnings[0]).not.toContain('/repo')
    },
  )

  test('returns [] when the mode cannot be determined (fail closed)', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '["/repo"]',
      statMode: () => undefined,
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
    expect(warnings).toEqual([])
  })

  test('returns the entries for a valid owner-only (0600) allowlist', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '["/repo", "/home/tester/work"]',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([
      '/repo',
      '/home/tester/work',
    ])
    expect(warnings).toEqual([])
  })

  test('supports async readFile implementations', async () => {
    const { options } = makeOptions({
      readFile: async () => '["/repo"]',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual(['/repo'])
  })

  test('win32 skips the POSIX group/other mode gate (emulated 0o666 bits carry no POSIX semantics)', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '["/repo"]',
      statMode: () => 0o666,
      platform: 'win32',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual(['/repo'])
    expect(warnings).toEqual([])
  })

  test('win32 trusts the allowlist even when the mode cannot be determined', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '["/repo"]',
      statMode: () => undefined,
      platform: 'win32',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual(['/repo'])
    expect(warnings).toEqual([])
  })

  test('POSIX platforms still reject an 0o666 file (fail closed off win32)', async () => {
    const { options, warnings } = makeOptions({
      readFile: () => '["/repo"]',
      statMode: () => 0o666,
      platform: 'linux',
    })

    await expect(loadTrustedRoots(options)).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(expectedAllowlistPath)
  })
})

describe('isTrustedProjectRoot', () => {
  test('matches after path.resolve normalization on both sides', () => {
    expect(isTrustedProjectRoot('/repo', ['/repo'])).toBe(true)
    expect(isTrustedProjectRoot('/repo', ['/repo/'])).toBe(true)
    expect(isTrustedProjectRoot('/repo/', ['/repo'])).toBe(true)
    expect(isTrustedProjectRoot('/repo//', ['/repo/./'])).toBe(true)
  })

  test('does not prefix-match sibling or child directories', () => {
    expect(isTrustedProjectRoot('/repo', ['/repo-evil'])).toBe(false)
    expect(isTrustedProjectRoot('/repo-evil', ['/repo'])).toBe(false)
    expect(isTrustedProjectRoot('/repo/sub', ['/repo'])).toBe(false)
    expect(isTrustedProjectRoot('/repo', ['/repo/sub'])).toBe(false)
  })

  test('is false for an empty allowlist', () => {
    expect(isTrustedProjectRoot('/repo', [])).toBe(false)
  })
})

describe('getTrustedRootsPath', () => {
  test('joins the injected home directory with the allowlist subpath', () => {
    expect(getTrustedRootsPath('/home/tester')).toBe(expectedAllowlistPath)
  })

  test('defaults to the current user home and always ends with the subpath', () => {
    expect(
      getTrustedRootsPath().endsWith(
        path.join('.config', 'openbuff', 'trusted-roots.json'),
      ),
    ).toBe(true)
  })
})

describe('resolveTrustedRootsPath (config-dir precedence, RF-14)', () => {
  test('OPENBUFF_CONFIG_DIR wins over every other source', () => {
    expect(
      resolveTrustedRootsPath({
        env: { OPENBUFF_CONFIG_DIR: '/cfg' },
        platform: 'linux',
        homeDir: '/home/tester',
      }),
    ).toBe(path.join('/cfg', 'trusted-roots.json'))
  })

  test('win32 APPDATA maps to APPDATA/openbuff', () => {
    expect(
      resolveTrustedRootsPath({
        env: { APPDATA: '/u/AppData/Roaming' },
        platform: 'win32',
        homeDir: '/home/tester',
      }),
    ).toBe(path.join('/u/AppData/Roaming', 'openbuff', 'trusted-roots.json'))
  })

  test('XDG_CONFIG_HOME maps to XDG_CONFIG_HOME/openbuff', () => {
    expect(
      resolveTrustedRootsPath({
        env: { XDG_CONFIG_HOME: '/xdg' },
        platform: 'linux',
        homeDir: '/home/tester',
      }),
    ).toBe(path.join('/xdg', 'openbuff', 'trusted-roots.json'))
  })

  test('no env overrides fall back to the home-based CLI config dir', () => {
    expect(
      resolveTrustedRootsPath({
        env: {},
        platform: 'linux',
        homeDir: '/home/tester',
      }),
    ).toBe(expectedAllowlistPath)
  })

  test('APPDATA is ignored off win32 (parity with resolveOpenbuffConfigDir)', () => {
    expect(
      resolveTrustedRootsPath({
        env: { APPDATA: '/u/AppData/Roaming' },
        platform: 'linux',
        homeDir: '/home/tester',
      }),
    ).toBe(expectedAllowlistPath)
  })

  test('loadTrustedRoots reads the allowlist through OPENBUFF_CONFIG_DIR when set', async () => {
    const reads: string[] = []
    const { options } = makeOptions({
      env: { OPENBUFF_CONFIG_DIR: '/cfg' },
      readFile: (p: string) => {
        reads.push(p)
        return '["/repo"]'
      },
      statMode: () => 0o600,
    })
    await expect(loadTrustedRoots(options)).resolves.toEqual(['/repo'])
    expect(reads).toEqual([path.join('/cfg', 'trusted-roots.json')])
  })
})
