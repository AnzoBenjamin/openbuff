import { isSandboxSensitivePath } from '@codebuff/common/util/filesystem-sandbox'

import type { FileFilter } from './read-files'

export function isReadPathBlocked(
  filePath: string,
  fileFilter?: FileFilter,
  policyToken?: object,
): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const aliases = [...new Set([normalized, normalized.toLowerCase()])]
  return (
    aliases.some(alias => isSandboxSensitivePath(alias, policyToken)) ||
    Boolean(
      fileFilter &&
      aliases.some((alias) => fileFilter(alias).status === 'blocked'),
    )
  )
}
