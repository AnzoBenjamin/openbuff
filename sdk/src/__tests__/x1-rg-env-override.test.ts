import fs, { accessSync, constants, statSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'bun:test'

import { getBundledRgPath } from '../native/ripgrep'

/**
 * X-1 (DEPTH-2026-09-27 D17) golden vectors for the CODEBUFF_RG_PATH
 * env-override contract on getBundledRgPath (sdk/src/native/ripgrep.ts) —
 * the last deferred X-1 item.
 *
 * These vectors pin the stable, non-secret parts of the override contract
 * that a native reimplementation of the resolution seam must preserve: the
 * exact string identity of a valid override, override-beats-PATH precedence,
 * fall-through on a stale override, ignoring an empty-string override, and
 * the terminal error naming CODEBUFF_RG_PATH. All asserted paths are
 * per-test temp-dir values and are never pinned; absolute host paths and
 * rg binary contents are intentionally not part of the contract.
 *
 * Companion to the X-1 golden-vector family root
 * common/src/tools/params/__tests__/x1-golden-vectors.test.ts; these
 * vectors live in sdk because the seam lives in sdk and common cannot
 * import sdk. Negative override cases (stale path, directory,
 * non-executable file) live in sdk/src/__tests__/code-search.test.ts and
 * are not duplicated here.
 */

const makeExecutableRg = (directory: string): string => {
  const candidate = path.join(directory, 'rg')
  // Content is irrelevant — the seam checks executability, not format.
  fs.writeFileSync(candidate, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return candidate
}

describe('CODEBUFF_RG_PATH env-override golden vectors', () => {
  it('honors a valid override verbatim (exact string identity)', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-rg-'))
    try {
      const candidate = makeExecutableRg(directory)

      // The core golden vector: a valid override is returned as the exact
      // configured string — not resolved, normalized, or rewritten.
      expect(
        getBundledRgPath(undefined, {
          CODEBUFF_RG_PATH: candidate,
          PATH: '',
        }),
      ).toBe(candidate)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('prefers a valid override over a PATH that would also resolve', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-rg-'))
    try {
      const candidate = makeExecutableRg(directory)

      // PATH points at the same temp dir, so the PATH fallback would
      // resolve too; the override still wins.
      expect(
        getBundledRgPath(undefined, {
          CODEBUFF_RG_PATH: candidate,
          PATH: directory,
        }),
      ).toBe(candidate)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('falls through to PATH when the override is stale', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-rg-'))
    try {
      const pathRg = makeExecutableRg(directory)
      const stalePath = '/definitely/missing/x1/rg'

      // A stale override must never be returned — the seam falls through to
      // the rest of the resolution order. The bundled vendor binary wins over
      // PATH when it exists (override → bundled → PATH), so this assertion
      // cannot pin which specific fallback resolves in an arbitrary checkout
      // (sdk/vendor/ripgrep/... may or may not be present). Pin instead:
      // (1) the stale path is never the result, and (2) the result is a real
      // executable file, mirroring the seam's own isExecutableFile check.
      const result = getBundledRgPath(undefined, {
        CODEBUFF_RG_PATH: stalePath,
        PATH: directory,
      })

      expect(result).not.toBe(stalePath)
      expect(statSync(result).isFile()).toBe(true)
      expect(() => accessSync(result, constants.X_OK)).not.toThrow()

      // Only when the resolution happens to land in our temp PATH dir is it
      // safe to pin the exact PATH binary; otherwise the bundled vendor rg
      // (which legitimately precedes PATH in the fallback order) wins.
      if (result.startsWith(directory + path.sep)) {
        expect(result).toBe(pathRg)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ignores an empty-string override', () => {
    try {
      const result = getBundledRgPath(undefined, {
        CODEBUFF_RG_PATH: '',
        PATH: '',
      })

      // '' must not be returned as the override; either the bundled
      // binary resolves or the resolution terminates in the terminal
      // error below.
      expect(result).not.toBe('')
    } catch (error) {
      expect((error as Error).message).toContain('Ripgrep binary not found')
    }
  })

  it('names CODEBUFF_RG_PATH in the terminal error remediation', () => {
    const unreachable = '/definitely/missing/x1/rg'

    try {
      // If a bundled binary resolves in this checkout, the terminal error
      // is not reached; the contract then only requires that the
      // unreachable override is never returned.
      expect(
        getBundledRgPath(undefined, {
          CODEBUFF_RG_PATH: unreachable,
          PATH: '',
        }),
      ).not.toBe(unreachable)
    } catch (error) {
      // The message text is the user-visible remediation contract: it must
      // keep naming the env var a user can set to fix the resolution.
      const message = (error as Error).message
      expect(message).toContain('Ripgrep binary not found')
      expect(message).toContain('CODEBUFF_RG_PATH')
    }
  })
})
