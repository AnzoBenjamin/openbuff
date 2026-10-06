/**
 * P2-T8: launchability rule for the default supervised seam. The SDK turns
 * process supervision on by default only where the child can be launched,
 * so these cases pin the fallback for Node, a missing child entry (bundled
 * dist), the compiled-binary embedded filesystem, and Windows.
 */
import { describe, expect, it } from 'bun:test'

import {
  isSupervisedSpawnLaunchable,
  isSupervisedSpawnSupported,
  resolveSupervisedChildEntryPath,
} from '../supervised-spawn'

const LAUNCHABLE = {
  hasBunRuntime: true,
  platform: 'linux',
  childEntryPath: '/repo/packages/agent-runtime/src/supervision/child-entry.ts',
  childEntryExists: true,
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

  it('is not launchable from a compiled binary embedded filesystem', () => {
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
