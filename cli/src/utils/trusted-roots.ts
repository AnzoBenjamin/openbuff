import fs from 'fs'
import os from 'os'
import path from 'path'

import { getCliEnv } from './env'

/**
 * NEW-2 serve trust (design §12.8): user-level allowlist of project roots
 * whose project-scope `.agents/**` definitions and `.agents/mcp.json` may be
 * loaded by `openbuff serve` without `--trust-project-agents`. The file lives
 * under the user's own config directory and must be owner-only (0600):
 * anything group/other-readable is rejected (fail closed). The POSIX mode
 * gate applies on POSIX platforms only — on win32 Node's statSync reports
 * emulated 0o666-style bits that carry no POSIX semantics, and the file is
 * protected by the NTFS ACL of the user's own config directory instead.
 */

/** Legacy home-relative subpath kept for {@link getTrustedRootsPath}. */
export const TRUSTED_ROOTS_PATH = path.join(
  '.config',
  'openbuff',
  'trusted-roots.json',
)

/**
 * Absolute path of the trusted-roots allowlist for the given home directory
 * (defaults to the current user's home). Legacy home-based helper; production
 * resolution goes through {@link resolveTrustedRootsPath}. Exported for tests.
 */
export function getTrustedRootsPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), TRUSTED_ROOTS_PATH)
}

/**
 * The env vars the trusted-roots path resolution consults (mirrors
 * `resolveOpenbuffConfigDir` in ../auth).
 */
export type TrustedRootsPathEnv = {
  OPENBUFF_CONFIG_DIR?: string
  XDG_CONFIG_HOME?: string
  APPDATA?: string
}

/**
 * Resolves the trusted-roots allowlist path following the CLI's config-dir
 * precedence — exactly `resolveOpenbuffConfigDir` in ../auth, so the
 * allowlist lives where every other openbuff config file lives:
 * `OPENBUFF_CONFIG_DIR` → (win32) `APPDATA/openbuff` →
 * `XDG_CONFIG_HOME/openbuff` → `~/.config/openbuff`. Pure and injectable so
 * tests stay hermetic; production defaults read the live CLI env (reviewer
 * finding trusted-roots-path-ignores-config-env / RF-14).
 */
export function resolveTrustedRootsPath(options?: {
  env?: TrustedRootsPathEnv
  platform?: NodeJS.Platform
  homeDir?: string
}): string {
  const env = options?.env ?? getCliEnv()
  const platform = options?.platform ?? process.platform
  const homeDir = options?.homeDir ?? os.homedir()
  if (env.OPENBUFF_CONFIG_DIR) {
    return path.join(env.OPENBUFF_CONFIG_DIR, 'trusted-roots.json')
  }
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'openbuff', 'trusted-roots.json')
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'openbuff', 'trusted-roots.json')
  }
  return path.join(homeDir, '.config', 'openbuff', 'trusted-roots.json')
}

export type LoadTrustedRootsOptions = {
  /** Home directory fallback (defaults to os.homedir()). */
  homeDir?: string
  /**
   * Config-dir env vars consulted before the home fallback (defaults to the
   * live CLI env). Injected in tests to stay hermetic.
   */
  env?: TrustedRootsPathEnv
  /**
   * Platform for the win32 APPDATA branch and the POSIX-only owner-only mode
   * gate (defaults to process.platform).
   */
  platform?: NodeJS.Platform
  /** Reads the allowlist file; defaults to fs.promises.readFile(utf8). */
  readFile?: (path: string) => string | Promise<string>
  /** Returns the file mode bits (or undefined); defaults to fs.statSync. */
  statMode?: (path: string) => number | undefined
  /** Human warn sink; defaults to a stderr write. */
  warn?: (line: string) => void
}

/**
 * Load the trusted-roots allowlist. Fails closed everywhere: a missing file,
 * a read error, invalid JSON, a non-array payload, non-string entries, or an
 * undeterminable/permissive file mode all yield an EMPTY allowlist — nothing
 * is trusted on any validation failure. The only user-visible signal is a
 * single stderr warning (naming the path, never the contents) when the file
 * exists but carries any group/other permission bit.
 */
export async function loadTrustedRoots(
  options?: LoadTrustedRootsOptions,
): Promise<string[]> {
  const platform = options?.platform ?? process.platform
  const filePath = resolveTrustedRootsPath({
    env: options?.env,
    platform,
    homeDir: options?.homeDir,
  })
  const readFile =
    options?.readFile ?? ((p: string) => fs.promises.readFile(p, 'utf8'))
  const statMode =
    options?.statMode ??
    ((p: string): number | undefined => {
      try {
        return fs.statSync(p).mode
      } catch {
        return undefined
      }
    })
  const warn =
    options?.warn ?? ((line: string) => process.stderr.write(line + '\n'))

  let raw: string
  try {
    raw = await readFile(filePath)
  } catch {
    // Missing or unreadable allowlist: fail closed with an empty list.
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const entries: unknown[] = parsed
  const roots: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      // One bad entry poisons the whole list: fail closed.
      return []
    }
    roots.push(entry)
  }

  // POSIX owner-only gate: any group/other permission bit disqualifies the
  // file. On win32 Node's statSync reports emulated 0o666-style bits that
  // carry no POSIX semantics, so the bit check would reject EVERY allowlist
  // and leave the config contract platform-dead; there the file is protected
  // by the NTFS ACL of the user's own config directory and the gate is
  // skipped. POSIX platforms keep the fail-closed check.
  if (platform !== 'win32') {
    const mode = statMode(filePath)
    if (mode === undefined) {
      return []
    }
    if ((mode & 0o077) !== 0) {
      warn(
        `openbuff: ignoring ${filePath}: trusted-roots.json must be readable only by the owner (chmod 600)`,
      )
      return []
    }
  }

  return roots
}

/**
 * Check: is the project root EXACTLY present in the allowlist? Both sides
 * are canonicalized identically — path.resolve normalization followed by
 * fs.realpathSync, so a symlinked allowlist entry (or a symlinked project
 * root) matches its real target; a missing path falls back to its resolved
 * form. No prefix matching — trusting `/repo` does not trust `/repo-evil` or
 * `/repo/sub`.
 */
export function isTrustedProjectRoot(
  projectRoot: string,
  roots: string[],
): boolean {
  const canonicalize = (value: string): string => {
    const resolved = path.resolve(value)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  const resolvedRoot = canonicalize(projectRoot)
  return roots.some((root) => canonicalize(root) === resolvedRoot)
}
