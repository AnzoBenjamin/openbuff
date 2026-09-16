import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getCliEnv } from '../utils/env'

export type UpdateStatusDeps = {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  homeDir?: string
  metadataFileName?: string
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: 'utf8') => string
  cliVersion?: string | null
  compareVersions?: (current: string, pending: string) => number
}

type WrapperMetadata = {
  version?: unknown
  pendingVersion?: unknown
}

function resolveUpdateConfigDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  homeDir: string,
): string {
  if (env.OPENBUFF_CONFIG_DIR) return env.OPENBUFF_CONFIG_DIR
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'openbuff')
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'openbuff')
  }
  return path.join(homeDir, '.config', 'openbuff')
}

function compareUpdateVersions(current: string, pending: string): number {
  if (!current || !pending) return 0
  // A non-semver current label (e.g. "dev") is always treated as outdated.
  if (!current.match(/^\d+(\.\d+)*(?:-[0-9A-Za-z.-]+)?$/)) {
    return -1
  }
  const parseVersion = (version: string) => {
    const parts = version.split('-')
    const mainParts = parts[0].split('.').map(Number)
    const prereleaseParts = parts[1] ? parts[1].split('.') : []
    return { main: mainParts, prerelease: prereleaseParts }
  }
  const p1 = parseVersion(current)
  const p2 = parseVersion(pending)
  for (let i = 0; i < Math.max(p1.main.length, p2.main.length); i++) {
    const n1 = p1.main[i] || 0
    const n2 = p2.main[i] || 0
    if (n1 < n2) return -1
    if (n1 > n2) return 1
  }
  if (p1.prerelease.length === 0 && p2.prerelease.length === 0) return 0
  if (p1.prerelease.length === 0) return 1
  if (p2.prerelease.length === 0) return -1
  for (
    let i = 0;
    i < Math.max(p1.prerelease.length, p2.prerelease.length);
    i++
  ) {
    if (i >= p1.prerelease.length) return -1
    if (i >= p2.prerelease.length) return 1
    const pr1 = p1.prerelease[i]
    const pr2 = p2.prerelease[i]
    const isNum1 = /^\d+$/.test(pr1)
    const isNum2 = /^\d+$/.test(pr2)
    if (isNum1 && isNum2) {
      const num1 = Number(pr1)
      const num2 = Number(pr2)
      if (num1 < num2) return -1
      if (num1 > num2) return 1
    } else if (isNum1 && !isNum2) {
      return -1
    } else if (!isNum1 && isNum2) {
      return 1
    } else if (pr1 < pr2) {
      return -1
    } else if (pr1 > pr2) {
      return 1
    }
  }
  return 0
}

function asVersionString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read wrapper metadata (openbuff-metadata.json) plus the CLI version fallback
 * and return a short user-facing update status string. Sync, no network, no
 * downloads: the TUI only reports what the wrapper staged in the background.
 */
export function buildUpdateStatusMessage(deps: UpdateStatusDeps = {}): string {
  try {
    const env = deps.env ?? (getCliEnv() as unknown as Record<string, string | undefined>)
    const platform = deps.platform ?? process.platform
    const homeDir = deps.homeDir ?? os.homedir()
    const metadataFileName = deps.metadataFileName ?? 'openbuff-metadata.json'
    const existsSync = deps.existsSync ?? nodeExistsSync
    const readFileSync =
      (deps.readFileSync as
        | ((path: string, encoding: 'utf8') => string)
        | undefined) ?? nodeReadFileSync
    const compare = deps.compareVersions ?? compareUpdateVersions
    const cliVersion =
      deps.cliVersion !== undefined
        ? deps.cliVersion
        : (getCliEnv().CODEBUFF_CLI_VERSION ?? null)

    const metadataPath = path.join(
      resolveUpdateConfigDir(env, platform, homeDir),
      metadataFileName,
    )

    let metadata: WrapperMetadata = {}
    if (existsSync(metadataPath)) {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as WrapperMetadata
    }

    const current = asVersionString(metadata.version) ?? cliVersion
    const pending = asVersionString(metadata.pendingVersion)

    if (
      pending &&
      (current === null || current === undefined || compare(current, pending) < 0)
    ) {
      return [
        `Update ${pending} staged (current ${current ?? 'unknown'}) \u2014 restart to apply.`,
        'The binary cannot update while running; run `openbuff --update` from your shell to apply now.',
      ].join(' ')
    }

    return `Openbuff is up to date (${current ?? 'unknown'}). Background wrapper checks stage updates; run \`openbuff --check-update\` from your shell to check now.`
  } catch {
    return 'Openbuff update status unavailable (could not read update metadata). Run `openbuff --check-update` from your shell to check now.'
  }
}
