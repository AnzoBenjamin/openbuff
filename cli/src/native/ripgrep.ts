import { createHash } from 'crypto'
import { existsSync, renameSync, rmSync } from 'fs'
import path from 'path'

import { getBundledRgPath } from '@openbuff/sdk'
import { spawnSync } from 'bun'

import { getCliEnv } from '../utils/env'
import { logger } from '../utils/logger'

/**
 * Pinned sha256 digests for the vendored ripgrep binaries, keyed by the
 * require() paths used during self-extraction. 'UNPINNED' is a sentinel
 * meaning no digest has been recorded yet: verification is skipped with a
 * warning instead of failing closed, so the code is safe to merge before the
 * real digests are filled in.
 */
export const RG_SHA256: Record<string, string> = {
  '../../../sdk/dist/vendor/ripgrep/arm64-darwin/rg':
    '0e0cb83f5195f1f51bb8feef1fff5b0b171e82bd1db6bd35deee701a3e7102f8',
  '../../../sdk/dist/vendor/ripgrep/x64-darwin/rg':
    '923dcc25cab57d33f4e7dd0476d4b74a554401a38817e246a8d6101dcd51c50f',
  '../../../sdk/dist/vendor/ripgrep/arm64-linux/rg':
    'e07d5c85fa9ca740ff4ab8bbac60a1e11c7a5ce242435f7820a03f7c20ef6276',
  '../../../sdk/dist/vendor/ripgrep/x64-linux/rg':
    'f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7',
  '../../../sdk/dist/vendor/ripgrep/x64-win32/rg.exe':
    'f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2',
}

const UNPINNED_DIGEST = 'UNPINNED'

/**
 * Compute the sha256 digest of a ripgrep binary and compare it against the
 * pinned digest for `embeddedRgPath`. Returns true when the digest matches,
 * when no map entry resolves for the path, or when the entry is the
 * 'UNPINNED' sentinel (a warning is logged in both skip cases). Returns false
 * only on a digest mismatch.
 */
const verifyRipgrepDigest = (
  buffer: ArrayBuffer,
  embeddedRgPath: string,
): boolean => {
  const embeddedPath = embeddedRgPath.replace(/\\/g, '/')
  const digest =
    RG_SHA256[embeddedPath] ??
    Object.entries(RG_SHA256).find(([key]) =>
      embeddedPath.endsWith(key.replace(/^(?:\.\.\/)+/, '')),
    )?.[1]

  if (digest === undefined) {
    logger.warn(
      { embeddedRgPath },
      'No pinned sha256 digest for embedded ripgrep binary; skipping integrity verification',
    )
    return true
  }

  if (digest === UNPINNED_DIGEST) {
    logger.warn(
      { embeddedRgPath },
      `Embedded ripgrep binary ${embeddedRgPath} has an unpinned sha256 digest; skipping integrity verification`,
    )
    return true
  }

  const actualDigest = createHash('sha256')
    .update(new Uint8Array(buffer))
    .digest('hex')
  if (actualDigest !== digest) {
    logger.error(
      { embeddedRgPath, expectedDigest: digest, actualDigest },
      `Embedded ripgrep binary ${embeddedRgPath} failed sha256 integrity verification`,
    )
    return false
  }

  return true
}

/**
 * Verify the sha256 digest of an embedded ripgrep binary against RG_SHA256.
 * Returns true when the digest matches, when no map entry resolves for the
 * path, or when the entry is the 'UNPINNED' sentinel (a warning is logged in
 * both skip cases). Returns false only on a digest mismatch.
 */
export const verifyExtractedRipgrep = (
  buffer: ArrayBuffer,
  embeddedRgPath: string,
): boolean => verifyRipgrepDigest(buffer, embeddedRgPath)

/**
 * Verify the sha256 digest of the ripgrep binary actually on disk at the
 * extraction target against the same pinned RG_SHA256 digest map. This closes
 * the gap where the embedded buffer was verified pre-extraction but the file
 * subsequently read from disk (executed by every later call) was partial,
 * truncated, or modified.
 */
const verifyOnDiskRipgrep = (
  buffer: ArrayBuffer,
  embeddedRgPath: string,
): boolean => verifyRipgrepDigest(buffer, embeddedRgPath)

const getRipgrepPath = async (): Promise<string> => {
  const env = getCliEnv()
  // In dev mode, use the SDK's bundled ripgrep binary
  if (!env.CODEBUFF_IS_BINARY) {
    return getBundledRgPath()
  }

  // Compiled mode - self-extract the embedded binary to the same directory as the current binary
  const binaryDir = path.dirname(process.execPath)
  const rgFileName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const outPath = path.join(binaryDir, rgFileName)

  // The macOS 11/12 Intel release ships a separately compiled ripgrep sibling
  // because the standard bundled x64-darwin binary targets a newer macOS SDK.
  if (env.CODEBUFF_CLI_LEGACY_MACOS === 'true') {
    if (!existsSync(outPath)) {
      throw new Error(`Legacy ripgrep binary is missing at ${outPath}`)
    }
    return outPath
  }

  // Do NOT pre-delete any existing extraction: a concurrent CLI process may
  // have just verified the file and be about to execute it, and deleting it
  // here would make that process's subsequent rg spawn fail with ENOENT.
  // Instead, the atomic temp-file + rename below overwrites whatever is at
  // outPath in a single filesystem operation, and the on-disk digest
  // verification afterwards guarantees the binary this run executes is a
  // complete, unmodified ripgrep binary.

  // Extract the embedded binary
  try {
    // Use require() with literal paths to ensure the binary gets bundled into the compiled CLI
    // This is necessary for Bun's binary compilation to include the ripgrep binary
    let embeddedRgPath: string

    if (process.platform === 'darwin' && process.arch === 'arm64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/arm64-darwin/rg')
    } else if (process.platform === 'darwin' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-darwin/rg')
    } else if (process.platform === 'linux' && process.arch === 'arm64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/arm64-linux/rg')
    } else if (process.platform === 'linux' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-linux/rg')
    } else if (process.platform === 'win32' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-win32/rg.exe')
    } else {
      throw new Error(
        `Unsupported platform: ${process.platform}-${process.arch}`,
      )
    }

    // Fast path: reuse an already-extracted binary that still matches the
    // pinned digest instead of rewriting the shared rg file on every start.
    // Mere existence is not enough — verification keeps a partial, truncated,
    // or modified extraction from being executed — but a verified binary is
    // returned without a write, so a read-only install directory with a valid
    // pre-extracted binary keeps working instead of hitting a write failure
    // (and the bundled fallback) on every invocation.
    if (existsSync(outPath)) {
      try {
        const existingBuffer = await Bun.file(outPath).arrayBuffer()
        if (verifyOnDiskRipgrep(existingBuffer, embeddedRgPath)) {
          return outPath
        }
        // Digest mismatch: fall through so the corrupt binary is replaced.
      } catch {
        // Unreadable existing file: fall through to re-extraction.
      }
    }

    // Copy SDK's bundled binary to binary directory for portability
    const embeddedBuffer = await Bun.file(embeddedRgPath).arrayBuffer()
    if (!verifyExtractedRipgrep(embeddedBuffer, embeddedRgPath)) {
      // Fallback to SDK's bundled ripgrep if integrity verification fails
      return getBundledRgPath()
    }

    // Write atomically (temp file + rename): a direct write to the final
    // path lets two concurrent CLI processes race, where one executes a
    // partially written rg while the other is mid-write. The rename is a
    // single filesystem operation, so readers only ever see a complete
    // binary.
    const tmpOutPath = `${outPath}.${process.pid}.tmp`
    try {
      await Bun.write(tmpOutPath, embeddedBuffer)

      // Make executable on Unix systems
      if (process.platform !== 'win32') {
        const chmod = spawnSync(['chmod', '+x', tmpOutPath])
        // The chmod result MUST be checked: a failed chmod (binary missing
        // from PATH, permission denial) that was ignored would rename a
        // non-executable file into the shared rg path. Digest verification
        // only covers content bytes, so the non-executable binary would pass
        // and be returned as the rg path — every subsequent rg spawn would
        // then fail with EACCES with no error ever thrown in the extraction
        // path, so the bundled-binary fallback would never be taken. Throwing
        // here routes the failure into the outer catch, which falls back to
        // getBundledRgPath() (the finally block still cleans up the temp
        // file, and the shared outPath keeps any prior valid binary).
        if (!chmod.success) {
          throw new Error(
            `Failed to make extracted ripgrep binary executable: chmod exited with ${chmod.exitCode}`,
          )
        }
      }

      renameSync(tmpOutPath, outPath)
    } finally {
      try {
        rmSync(tmpOutPath, { force: true })
      } catch {
        // ignore
      }
    }

    // Integrity must cover the binary actually executed, not just the
    // embedded buffer before extraction: re-hash the file on disk after the
    // write and compare against the pinned digest.
    if (
      !verifyOnDiskRipgrep(
        await Bun.file(outPath).arrayBuffer(),
        embeddedRgPath,
      )
    ) {
      // Do NOT rmSync outPath here: a concurrent CLI process may have just
      // atomically renamed its own verified binary into the shared path
      // between our rename and this read, and deleting the shared path would
      // remove that valid binary — the same ENOENT hazard the extraction
      // path above avoids. A failed on-disk verification only means the
      // bytes this run renamed are suspect; fall back without touching the
      // shared path.
      // Fallback to SDK's bundled ripgrep if the extracted binary failed
      // integrity verification
      return getBundledRgPath()
    }

    return outPath
  } catch (error) {
    logger.error({ error }, 'Failed to extract ripgrep binary')
    // Fallback to SDK's bundled ripgrep if extraction fails
    return getBundledRgPath()
  }
}

// Cache the promise to avoid multiple extractions
let rgPathPromise: Promise<string> | null = null

export const getRgPath = (): Promise<string> => {
  if (!rgPathPromise) {
    // A failed extraction must not be cached permanently: a rejection (e.g. a
    // transiently missing binary or an unsupported-platform throw) drops the
    // cached promise so the next caller retries instead of failing for the
    // whole process lifetime.
    rgPathPromise = getRipgrepPath().catch((error: unknown) => {
      rgPathPromise = null
      throw error
    })
  }
  return rgPathPromise
}

/**
 * Reset the cached ripgrep path promise.
 * Used primarily for testing to force re-extraction.
 */
export const resetRgPathCache = (): void => {
  rgPathPromise = null
}
