import { constants, accessSync, statSync } from 'fs'
import { join, dirname, delimiter } from 'path'
import { fileURLToPath } from 'url'

import { getSdkEnv } from '../env'

import type { SdkEnv } from '../types/env'

declare const Bun: { embeddedFiles: readonly unknown[] }

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findExecutableOnPath(binaryName: string, env: SdkEnv): string | null {
  const pathEnv = env.PATH
  if (!pathEnv) return null

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binaryName)
    if (isExecutableFile(candidate)) return candidate
  }

  return null
}

/**
 * Get the path to the bundled ripgrep binary based on the current platform
 * @param importMetaUrl - Optional calling-module location for compatibility
 * @returns Path to the ripgrep binary
 */
export function getBundledRgPath(
  importMetaUrl?: string,
  env: SdkEnv = getSdkEnv(),
): string {
  // Allow override via environment variable, but do not return a stale path.
  // If the configured binary is missing, continue to bundled/PATH fallbacks.
  if (env.CODEBUFF_RG_PATH && isExecutableFile(env.CODEBUFF_RG_PATH)) {
    return env.CODEBUFF_RG_PATH
  }

  // Determine platform-specific directory name
  const platform = process.platform
  const arch = process.arch

  let platformDir: string
  if (platform === 'win32' && arch === 'x64') {
    platformDir = 'x64-win32'
  } else if (platform === 'darwin' && arch === 'arm64') {
    platformDir = 'arm64-darwin'
  } else if (platform === 'darwin' && arch === 'x64') {
    platformDir = 'x64-darwin'
  } else if (platform === 'linux' && arch === 'arm64') {
    platformDir = 'arm64-linux'
  } else if (platform === 'linux' && arch === 'x64') {
    platformDir = 'x64-linux'
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg'

  // Try to find the bundled binary relative to this module
  let vendorPath: string | undefined

  // Resolve the owning package first, even when an external caller supplies
  // its own module URL. The caller's cwd need not contain the installed SDK.
  for (const metaUrl of new Set([import.meta.url, importMetaUrl])) {
    if (!metaUrl) continue
    // ESM context - use import.meta.url to find relative path
    const currentFile = fileURLToPath(metaUrl)
    const currentDir = dirname(currentFile)

    // Try relative to current file (development - from src/native/ripgrep.ts to vendor/)
    const devPath = join(
      currentDir,
      '..',
      '..',
      'vendor',
      'ripgrep',
      platformDir,
      binaryName,
    )
    if (isExecutableFile(devPath)) {
      vendorPath = devPath
    }

    // Try relative to bundled dist file (production - from dist/index.mjs to dist/vendor/)
    const distPath = join(
      currentDir,
      'vendor',
      'ripgrep',
      platformDir,
      binaryName,
    )
    if (isExecutableFile(distPath)) {
      vendorPath = distPath
    }
    if (vendorPath) break
  }

  // If not found via importMetaUrl, try CJS approach or other methods
  if (!vendorPath) {
    // Try from __dirname if available (CJS context)
    // Read only fixed module metadata. Direct eval sees CommonJS's lexical
    // __dirname and prevents bundlers from baking the build checkout's path.
    let commonJsDir: unknown
    try {
      commonJsDir = eval('__dirname')
    } catch {}

    if (typeof commonJsDir === 'string') {
      const cjsPath = join(
        commonJsDir,
        '..',
        '..',
        'vendor',
        'ripgrep',
        platformDir,
        binaryName,
      )
      if (isExecutableFile(cjsPath)) {
        vendorPath = cjsPath
      }
      const cjsPath2 = join(
        commonJsDir,
        'vendor',
        'ripgrep',
        platformDir,
        binaryName,
      )
      if (isExecutableFile(cjsPath2)) {
        vendorPath = cjsPath2
      }
    }
  }

  // Standalone Bun applications ship an executable sibling, rather than an
  // on-disk SDK dist directory. Source Bun and Node keep package-local lookup.
  if (!vendorPath && typeof Bun !== 'undefined' && Bun.embeddedFiles.length > 0) {
    const standalonePath = join(dirname(process.execPath), binaryName)
    if (isExecutableFile(standalonePath)) vendorPath = standalonePath
  }

  if (vendorPath && isExecutableFile(vendorPath)) {
    return vendorPath
  }

  const pathRg = findExecutableOnPath(binaryName, env)
  if (pathRg) {
    return pathRg
  }

  // Fallback: try to find in dist/vendor (for published package)
  const distVendorPath = join(
    process.cwd(),
    'node_modules',
    '@openbuff',
    'sdk',
    'dist',
    'vendor',
    'ripgrep',
    platformDir,
    binaryName,
  )
  if (isExecutableFile(distVendorPath)) {
    return distVendorPath
  }

  const fallbackPathRg = findExecutableOnPath(binaryName, env)
  if (fallbackPathRg) {
    return fallbackPathRg
  }

  // No fallback available - bundled binaries are required
  throw new Error(
    `Ripgrep binary not found for ${platform}-${arch}. ` +
      `Expected at: ${vendorPath} or ${distVendorPath}, and no '${binaryName}' executable was found on PATH. ` +
      `Please run 'npm run fetch-ripgrep', install ripgrep, or set CODEBUFF_RG_PATH environment variable.`,
  )
}
