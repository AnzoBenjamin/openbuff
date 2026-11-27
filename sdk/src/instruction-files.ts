import path from 'path'

import { isKnowledgeFile } from '@codebuff/common/constants/knowledge'
import {
  INSTRUCTION_IMPORT_MAX_CHARS,
  INSTRUCTION_IMPORT_MAX_DEPTH,
  INSTRUCTION_IMPORT_MAX_FILES,
  extractInstructionImports,
  instructionFileNameRank,
  isInstructionFileName,
} from '@codebuff/common/util/instruction-files'
import { getErrorObject } from '@codebuff/common/util/error'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { InstructionFileRecord } from '@codebuff/common/util/instruction-files'

/** Bound on the upward walk looking for the git root. */
const MAX_ANCESTOR_LEVELS = 32

type InstructionFs = Pick<CodebuffFileSystem, 'readdir' | 'readFile' | 'stat'> &
  Partial<Pick<CodebuffFileSystem, 'realpath'>>

export type LoadedInstructionFiles = {
  /** Path (relative to the project root) to content, for `fileContext.knowledgeFiles`. */
  knowledgeFiles: Record<string, string>
  /** Load-order records for `fileContext.instructionFiles`. */
  instructionFiles: InstructionFileRecord[]
}

const toPosix = (value: string) => value.split(path.sep).join('/')

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return (
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/**
 * Nearest directory at or above `projectRoot` that contains `.git`. Falls
 * back to `projectRoot` itself, so no ancestor directory is ever read in a
 * project that is not inside a repository.
 */
export async function findInstructionBoundary(params: {
  projectRoot: string
  fs: InstructionFs
}): Promise<string> {
  const start = path.resolve(params.projectRoot)
  let current = start
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    try {
      await params.fs.stat(path.join(current, '.git'))
      return current
    } catch {
      // keep walking
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * Selects every knowledge file in a list of project paths, all names per
 * directory (knowledge.md, AGENTS.md, CLAUDE.md, *.knowledge.md), ordered by
 * directory depth and then by name rank.
 */
export function selectAllKnowledgeFilePaths(filePaths: string[]): string[] {
  const normalized = filePaths.map(toPosix).filter(isKnowledgeFile)
  const depth = (p: string) => p.split('/').length
  return [...new Set(normalized)].sort((a, b) => {
    const byDepth = depth(a) - depth(b)
    if (byDepth !== 0) return byDepth
    const byDir = path.posix.dirname(a).localeCompare(path.posix.dirname(b))
    if (byDir !== 0) return byDir
    const byRank =
      instructionFileNameRank(path.posix.basename(a)) -
      instructionFileNameRank(path.posix.basename(b))
    return byRank !== 0 ? byRank : a.localeCompare(b)
  })
}

/**
 * Loads the instruction files in effect for a project:
 *
 * 1. Every AGENTS.md / CLAUDE.md / knowledge.md in each directory from the
 *    git root down to (not including) the project root (`ancestor`).
 * 2. Every knowledge file in the project root (`project`) and in its
 *    subdirectories (`nested`, injected later when the agent touches them).
 * 3. `@path` imports of any of those, resolved relative to the importing
 *    file, bounded by depth and count, contained to the git root (or the
 *    project root outside a repository), and cycle-safe.
 *
 * Each file is recorded once: a file that is both an instruction file and an
 * import keeps its first record.
 */
export async function loadInstructionFiles(params: {
  projectRoot: string
  /** Project-relative paths discovered for the project. */
  filePaths: string[]
  /** Required unless `readVirtualFile` is given. */
  fs?: InstructionFs
  logger: Logger
  /** Defaults to the git root found above `projectRoot`. */
  boundaryRoot?: string
  /** Reads a project-relative file without the fs (virtual projects). */
  readVirtualFile?: (relativePath: string) => string | undefined
}): Promise<LoadedInstructionFiles> {
  const { fs, logger, readVirtualFile } = params
  const projectRoot = path.resolve(params.projectRoot)
  const boundaryRoot = path.resolve(
    params.boundaryRoot ??
      (readVirtualFile || !fs
        ? projectRoot
        : await findInstructionBoundary({ projectRoot, fs })),
  )
  const containmentRoot = isInside(boundaryRoot, projectRoot)
    ? boundaryRoot
    : projectRoot

  const knowledgeFiles: Record<string, string> = {}
  const instructionFiles: InstructionFileRecord[] = []
  let importedCount = 0

  const keyFor = (absolute: string) =>
    toPosix(path.relative(projectRoot, absolute)) || path.basename(absolute)

  const readAbsolute = async (absolute: string): Promise<string | undefined> => {
    if (readVirtualFile) {
      return readVirtualFile(keyFor(absolute))
    }
    if (!fs) return undefined
    try {
      if (fs.realpath) {
        const real = await fs.realpath(absolute)
        const realRoot = await fs.realpath(containmentRoot).catch(
          () => containmentRoot,
        )
        if (!isInside(realRoot, real)) {
          logger.debug?.(
            { file: absolute },
            'Skipping instruction file that resolves outside the project',
          )
          return undefined
        }
      }
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) return undefined
      return await fs.readFile(absolute, 'utf8')
    } catch (error) {
      logger.debug?.(
        { file: absolute, error: getErrorObject(error) },
        'Failed to read instruction file',
      )
      return undefined
    }
  }

  const visitImports = async (
    importerAbsolute: string,
    content: string,
    depth: number,
  ): Promise<void> => {
    if (depth >= INSTRUCTION_IMPORT_MAX_DEPTH) return
    for (const target of extractInstructionImports(content)) {
      if (importedCount >= INSTRUCTION_IMPORT_MAX_FILES) return
      const absolute = path.resolve(path.dirname(importerAbsolute), target)
      if (!isInside(containmentRoot, absolute)) continue
      const key = keyFor(absolute)
      if (Object.prototype.hasOwnProperty.call(knowledgeFiles, key)) continue
      const imported = await readAbsolute(absolute)
      if (imported === undefined || imported.length > INSTRUCTION_IMPORT_MAX_CHARS)
        continue
      importedCount++
      knowledgeFiles[key] = imported
      instructionFiles.push({
        path: key,
        scope: 'import',
        importedBy: keyFor(importerAbsolute),
        chars: imported.length,
      })
      await visitImports(absolute, imported, depth + 1)
    }
  }

  const addFile = async (
    absolute: string,
    scope: 'ancestor' | 'project' | 'nested',
  ) => {
    const key = keyFor(absolute)
    if (Object.prototype.hasOwnProperty.call(knowledgeFiles, key)) return
    const content = await readAbsolute(absolute)
    if (content === undefined) return
    knowledgeFiles[key] = content
    instructionFiles.push({ path: key, scope, chars: content.length })
    await visitImports(absolute, content, 0)
  }

  // 1. Ancestors, root first.
  const ancestorDirs: string[] = []
  for (
    let dir = path.dirname(projectRoot);
    isInside(boundaryRoot, dir) && dir !== projectRoot;
    dir = path.dirname(dir)
  ) {
    ancestorDirs.unshift(dir)
    if (dir === boundaryRoot || path.dirname(dir) === dir) break
  }
  for (const dir of readVirtualFile ? [] : ancestorDirs) {
    if (!fs) break
    let entries: string[]
    try {
      entries = (await fs.readdir(dir)) as unknown as string[]
    } catch {
      continue
    }
    const names = entries
      .map(String)
      .filter(isInstructionFileName)
      .sort((a, b) => instructionFileNameRank(a) - instructionFileNameRank(b))
    for (const name of names) {
      await addFile(path.join(dir, name), 'ancestor')
    }
  }

  // 2. Project root and nested files.
  for (const relative of selectAllKnowledgeFilePaths(params.filePaths)) {
    const scope = relative.includes('/') ? 'nested' : 'project'
    await addFile(path.join(projectRoot, relative), scope)
  }

  return { knowledgeFiles, instructionFiles }
}
