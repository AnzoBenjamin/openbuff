import { afterEach, describe, expect, test } from 'bun:test'

import { chromeSandboxArgs } from '../tools/browser-logs'

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
  })

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
})
