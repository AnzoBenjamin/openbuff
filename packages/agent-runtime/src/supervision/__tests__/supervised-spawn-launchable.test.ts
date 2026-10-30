/**
 * P2-T8: launchability rule for the default supervised seam. The SDK turns
 * process supervision on by default only where the child can be launched,
 * so these cases pin the fallback for Node, a missing child entry (bundled
 * dist), the compiled-binary embedded filesystem, and Windows.
 *
 * P2-T8d SELF-EXEC: a compiled `bun build --compile` binary is LAUNCHABLE —
 * the child is the parent binary itself, re-executed via the shared
 * `SUPERVISED_SELF_EXEC_FLAG` — detected as: embedded `$bunfs`/`~BUN` entry
 * path PLUS a `process.execPath` that is NOT the bun runtime itself. Under
 * the plain bun runtime the embedded entry stays not launchable.
 */
import { describe, expect, it } from 'bun:test'

import { SUPERVISED_SELF_EXEC_FLAG } from '../self-exec-flag'
import {
  isSupervisedSpawnLaunchable,
  isSupervisedSpawnSupported,
  looksLikeBunRuntimeExecPath,
  resolveSupervisedChildEntryPath,
} from '../supervised-spawn'

const LAUNCHABLE = {
  hasBunRuntime: true,
  platform: 'linux',
  childEntryPath: '/repo/packages/agent-runtime/src/supervision/child-entry.ts',
  childEntryExists: true,
  // P2-T8d: named for the plain bun runtime by default (source mode).
  execPath: '/usr/local/bin/bun',
}

describe('supervised spawn launchability (P2-T8)', () => {
  it('is launchable under Bun on a POSIX platform with the child entry on disk', () => {
    expect(isSupervisedSpawnLaunchable(LAUNCHABLE)).toBe(true)
    expect(
      isSupervisedSpawnLaunchable({ ...LAUNCHABLE, platform: 'darwin' }),
    ).toBe(true)
  })

  it('is not launchable without the Bun runtime (Node)', () => {
    expect(
      isSupervisedSpawnLaunchable({ ...LAUNCHABLE, hasBunRuntime: false }),
    ).toBe(false)
  })

  it('is not launchable when the child entry file is missing (bundled dist)', () => {
    expect(
      isSupervisedSpawnLaunchable({ ...LAUNCHABLE, childEntryExists: false }),
    ).toBe(false)
  })

  it('is not launchable from the embedded filesystem under the plain bun runtime', () => {
    expect(
      isSupervisedSpawnLaunchable({
        ...LAUNCHABLE,
        childEntryPath: '/$bunfs/root/child-entry.ts',
      }),
    ).toBe(false)
    expect(
      isSupervisedSpawnLaunchable({
        ...LAUNCHABLE,
        childEntryPath: 'B:/~BUN/root/child-entry.ts',
      }),
    ).toBe(false)
    // Windows still blocks even in the compiled-binary shape.
    expect(
      isSupervisedSpawnLaunchable({
        ...LAUNCHABLE,
        platform: 'win32',
        childEntryPath: '/$bunfs/root/child-entry.ts',
        execPath: '/opt/openbuff/openbuff',
      }),
    ).toBe(false)
  })

  it('is launchable in the compiled-binary SELF-EXEC case (bunfs entry + non-bun execPath)', () => {
    const compiled = {
      ...LAUNCHABLE,
      childEntryPath: '/$bunfs/root/child-entry.ts',
      childEntryExists: false,
      execPath: '/usr/local/bin/openbuff',
    }
    expect(isSupervisedSpawnLaunchable(compiled)).toBe(true)
    // The ~BUN (Windows-style) marker inside childEntryPath is the same
    // embedded-filesystem fingerprint.
    expect(
      isSupervisedSpawnLaunchable({
        ...compiled,
        childEntryPath: '~BUN/root/child-entry.ts',
      }),
    ).toBe(true)
    // The bun RUNTIME as execPath does not prove self-exec: under plain bun
    // a bunfs path has no on-disk entry for `bun run`.
    expect(
      isSupervisedSpawnLaunchable({ ...compiled, execPath: 'bun' }),
    ).toBe(false)
    expect(
      isSupervisedSpawnLaunchable({ ...compiled, execPath: './bun.exe' }),
    ).toBe(false)
    // No execPath → cannot prove self-exec, fails closed.
    expect(
      isSupervisedSpawnLaunchable({ ...compiled, execPath: undefined }),
    ).toBe(false)
  })

  it('looksLikeBunRuntimeExecPath matches only the bun runtime binary names', () => {
    expect(looksLikeBunRuntimeExecPath('/usr/local/bin/bun')).toBe(true)
    expect(looksLikeBunRuntimeExecPath('bun')).toBe(true)
    expect(looksLikeBunRuntimeExecPath('C:\\tools\\bun.exe')).toBe(true)
    expect(looksLikeBunRuntimeExecPath('/usr/local/bin/openbuff')).toBe(false)
    expect(looksLikeBunRuntimeExecPath('/usr/local/bin/bunbun')).toBe(false)
  })

  it('exports the shared self-exec flag (one source of truth with the CLI)', () => {
    expect(SUPERVISED_SELF_EXEC_FLAG).toBe('--supervised-child')
  })

  it('is not launchable on Windows', () => {
    expect(
      isSupervisedSpawnLaunchable({ ...LAUNCHABLE, platform: 'win32' }),
    ).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'resolves the child entry next to the module and is supported when running from source under Bun',
    () => {
      expect(resolveSupervisedChildEntryPath().endsWith('child-entry.ts')).toBe(
        true,
      )
      expect(isSupervisedSpawnSupported()).toBe(true)
    },
  )
})
