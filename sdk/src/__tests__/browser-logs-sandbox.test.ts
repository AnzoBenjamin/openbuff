import { afterEach, describe, expect, test } from 'bun:test'

import {
  chromeSandboxArgs,
  __setChromeSandboxDiagnosticForTest,
  __setChromeSandboxProbeForTest,
  type ChromeSandboxProbe,
} from '../tools/browser-logs'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function setGetuid(fn: (() => number) | undefined): void {
  Object.defineProperty(process, 'getuid', {
    value: fn,
    configurable: true,
    writable: true,
  })
}

describe('chromeSandboxArgs', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalGetuid) {
      Object.defineProperty(process, 'getuid', originalGetuid)
    } else {
      // getuid is not defined on non-POSIX platforms; remove the stub.
      delete (process as unknown as { getuid?: unknown }).getuid
    }
    // Restore the real /proc probes and console diagnostics between tests.
    __setChromeSandboxProbeForTest(null)
    __setChromeSandboxDiagnosticForTest(null)
  })

  /**
   * In-memory stand-in for the /proc probe seam, mirroring the file's
   * existing test-mock conventions: files maps probe paths to contents and
   * `throwOn` models an unreadable procfs entry (EACCES).
   */
  function makeProbe(
    files: Record<string, string>,
    throwOn?: string,
  ): ChromeSandboxProbe {
    return {
      existsSync: (probePath) => probePath in files,
      readFileSync: (probePath) => {
        if (probePath === throwOn) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          })
        }
        return files[probePath] ?? ''
      },
    }
  }

  test('non-linux platforms never disable the sandbox', () => {
    setPlatform('darwin')
    expect(chromeSandboxArgs()).toEqual([])
  })

  test('linux running as root disables the sandbox', () => {
    setPlatform('linux')
    setGetuid(() => 0)
    expect(chromeSandboxArgs()).toEqual(['--no-sandbox'])
  })

  test('linux non-root returns a deterministic sandbox decision', () => {
    // The real runner may have none of the /proc probe files, which is a
    // legitimate undeterminable state now; silence the (correct) warn
    // diagnostic so the deterministic assertion stays quiet.
    __setChromeSandboxDiagnosticForTest(() => {})
    setPlatform('linux')
    setGetuid(() => 1000)
    // The exact result depends on the runner's /proc state, so assert only
    // that it is one of the two valid outputs and that it is deterministic.
    const first = chromeSandboxArgs()
    expect([JSON.stringify([]), JSON.stringify(['--no-sandbox'])]).toContain(
      JSON.stringify(first),
    )
    expect(chromeSandboxArgs()).toEqual(first)
  })

  test("Ubuntu 24.04's apparmor userns restriction forces --no-sandbox even when max_user_namespaces is positive", () => {
    setPlatform('linux')
    setGetuid(() => 1000)
    __setChromeSandboxProbeForTest(
      makeProbe({
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
        // Ubuntu 24.04 keeps this positive while AppArmor blocks userns;
        // without the apparmor check first, this probe would wrongly
        // report the sandbox as usable.
        '/proc/sys/user/max_user_namespaces': '1518515\n',
      }),
    )
    expect(chromeSandboxArgs()).toEqual(['--no-sandbox'])
  })

  test('apparmor knob set to 0 leaves the sandbox enabled when userns is available', () => {
    setPlatform('linux')
    setGetuid(() => 1000)
    __setChromeSandboxProbeForTest(
      makeProbe({
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
        '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
      }),
    )
    expect(chromeSandboxArgs()).toEqual([])
  })

  test('a failed probe keeps the --no-sandbox fallback and logs a warn diagnostic naming the reason', () => {
    setPlatform('linux')
    setGetuid(() => 1000)
    const diagnostics: string[] = []
    __setChromeSandboxDiagnosticForTest((message) => {
      diagnostics.push(message)
    })
    __setChromeSandboxProbeForTest(
      makeProbe(
        { '/proc/sys/kernel/unprivileged_userns_clone': '1\n' },
        '/proc/sys/kernel/unprivileged_userns_clone',
      ),
    )
    // Documented fallback is unchanged on a probe error...
    expect(chromeSandboxArgs()).toEqual(['--no-sandbox'])
    // ...but the failure is no longer silent: the diagnostic names the
    // probe that could not be read and the fallback it justified.
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('unprivileged_userns_clone')
    expect(diagnostics[0]).toContain('undeterminable')
    expect(diagnostics[0]).toContain('--no-sandbox')
  })

  test('no readable probe file is undeterminable: --no-sandbox fallback with a warn diagnostic', () => {
    setPlatform('linux')
    setGetuid(() => 1000)
    const diagnostics: string[] = []
    __setChromeSandboxDiagnosticForTest((message) => {
      diagnostics.push(message)
    })
    __setChromeSandboxProbeForTest(makeProbe({}))
    expect(chromeSandboxArgs()).toEqual(['--no-sandbox'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('undeterminable')
    expect(diagnostics[0]).toContain('apparmor_restrict_unprivileged_userns')
  })
})
