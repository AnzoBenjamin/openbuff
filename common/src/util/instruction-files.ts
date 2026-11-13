import path from 'path'

import { KNOWLEDGE_FILE_NAMES_LOWERCASE } from '../constants/knowledge'

/**
 * Instruction files (AGENTS.md / CLAUDE.md / knowledge.md and their `@path`
 * imports) as recorded on `ProjectFileContext.instructionFiles`.
 *
 * - `ancestor`: a file in a directory between the git root and the project
 *   root (exclusive). Its key is relative to the project root (`../AGENTS.md`).
 * - `project`: a file directly in the project root.
 * - `nested`: a file in a subdirectory of the project root. It reaches the
 *   model only once the agent touches a path under that directory.
 * - `import`: a file pulled in by an `@path` line of another instruction file.
 *   It follows the visibility of the file that imported it.
 *
 * Every key appears once; the content lives in `fileContext.knowledgeFiles`.
 */
export type InstructionFileScope = 'ancestor' | 'project' | 'nested' | 'import'

export interface InstructionFileRecord {
  /** POSIX path relative to the project root (may start with `../`). */
  path: string
  scope: InstructionFileScope
  /** Key of the file whose `@path` line imported this one. */
  importedBy?: string
  /** Content length in characters. */
  chars: number
}

/** Tag on the runtime message that carries nested instruction files. */
export const NESTED_INSTRUCTION_FILES_TAG = 'NESTED_INSTRUCTION_FILES'

/** Opening marker of one nested file inside that message. */
export const instructionFileMarker = (filePath: string) =>
  `<instruction_file path="${filePath}">`

/** Max `@path` hops from an instruction file (Claude Code uses 5). */
export const INSTRUCTION_IMPORT_MAX_DEPTH = 5
/** Max imported files per session, across all instruction files. */
export const INSTRUCTION_IMPORT_MAX_FILES = 32
/** Imported files larger than this are skipped. */
export const INSTRUCTION_IMPORT_MAX_CHARS = 100_000

/** True for the exact instruction file names (case-insensitive). */
export function isInstructionFileName(fileName: string): boolean {
  return KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(fileName.toLowerCase())
}

/** Rank of an instruction file name inside one directory (knowledge, AGENTS, CLAUDE). */
export function instructionFileNameRank(fileName: string): number {
  const rank = KNOWLEDGE_FILE_NAMES_LOWERCASE.indexOf(fileName.toLowerCase())
  return rank === -1 ? KNOWLEDGE_FILE_NAMES_LOWERCASE.length : rank
}

/**
 * Extracts `@path` import targets from instruction-file markdown. Lines inside
 * fenced code blocks and inline code spans are ignored, as are absolute and
 * home-relative targets (imports must stay inside the project). Targets are
 * returned as written; the caller resolves and contains them.
 */
export function extractInstructionImports(content: string): string[] {
  const withoutFences = content.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  const withoutSpans = withoutFences.replace(/`[^`\n]*`/g, '')
  const targets: string[] = []
  const seen = new Set<string>()
  const pattern = /(?:^|[\s(])@((?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_.\-/]*)/gm
  for (const match of withoutSpans.matchAll(pattern)) {
    const target = match[1].replace(/[.,;:)]+$/, '')
    if (!target || seen.has(target)) continue
    seen.add(target)
    targets.push(target)
  }
  return targets
}

function topLevelOwner(
  record: InstructionFileRecord,
  byPath: Map<string, InstructionFileRecord>,
): InstructionFileRecord {
  let current = record
  const visited = new Set<string>()
  while (current.scope === 'import' && current.importedBy) {
    if (visited.has(current.path)) break
    visited.add(current.path)
    const parent = byPath.get(current.importedBy)
    if (!parent) break
    current = parent
  }
  return current
}

/** Directory (POSIX, relative to the project root) a nested file governs. */
export function instructionFileDir(filePath: string): string {
  const dir = path.posix.dirname(filePath)
  return dir === '.' ? '' : dir
}

/**
 * Keys of the instruction files that belong in the system prompt: ancestor
 * and project-root files plus their imports, in load order, each once.
 * Returns undefined when the context carries no instruction-file records
 * (an older session or an SDK caller that passed `knowledgeFiles` directly).
 */
export function selectAlwaysOnInstructionFiles(fileContext: {
  instructionFiles?: InstructionFileRecord[]
}): string[] | undefined {
  const records = fileContext.instructionFiles
  if (!records) return undefined
  const byPath = new Map(records.map((record) => [record.path, record]))
  const result: string[] = []
  for (const record of records) {
    const owner = topLevelOwner(record, byPath)
    if (owner.scope === 'ancestor' || owner.scope === 'project') {
      result.push(record.path)
    }
  }
  return [...new Set(result)]
}

/**
 * Normalizes a tool path argument to a POSIX path relative to the project
 * root, or undefined when it points outside the project.
 */
export function toProjectRelativePath(
  projectRoot: string,
  rawPath: string,
): string | undefined {
  if (!rawPath || rawPath.includes('\0')) return undefined
  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(projectRoot || '/', rawPath)
  const relative = path.relative(projectRoot || '/', absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

/**
 * Nested instruction files (with their imports) that govern any of the
 * touched project-relative paths, in load order. A file governs a path when
 * the path lies inside the file's directory.
 */
export function selectNestedInstructionFilesForPaths(
  fileContext: { instructionFiles?: InstructionFileRecord[] },
  touchedPaths: readonly string[],
): string[] {
  const records = fileContext.instructionFiles
  if (!records || touchedPaths.length === 0) return []
  const byPath = new Map(records.map((record) => [record.path, record]))
  const governs = (dir: string) =>
    touchedPaths.some(
      (touched) => touched === dir || touched.startsWith(`${dir}/`),
    )
  const result: string[] = []
  for (const record of records) {
    const owner = topLevelOwner(record, byPath)
    if (owner.scope !== 'nested') continue
    if (governs(instructionFileDir(owner.path))) result.push(record.path)
  }
  return [...new Set(result)]
}

/**
 * Adds the `@path` imports (transitively) of each listed key right after it,
 * keeping first-occurrence order and dropping duplicates.
 */
export function expandWithInstructionImports(
  fileContext: { instructionFiles?: InstructionFileRecord[] },
  keys: readonly string[],
): string[] {
  const records = fileContext.instructionFiles ?? []
  const childrenOf = new Map<string, string[]>()
  for (const record of records) {
    if (record.scope !== 'import' || !record.importedBy) continue
    const list = childrenOf.get(record.importedBy) ?? []
    list.push(record.path)
    childrenOf.set(record.importedBy, list)
  }
  const result: string[] = []
  const seen = new Set<string>()
  const visit = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    result.push(key)
    for (const child of childrenOf.get(key) ?? []) visit(child)
  }
  for (const key of keys) visit(key)
  return result
}

/**
 * Drops entries whose trimmed content is empty or identical to an earlier
 * entry (a CLAUDE.md that copies AGENTS.md is injected once).
 */
export function dedupeInstructionContents(
  entries: ReadonlyArray<readonly [string, string]>,
): Array<[string, string]> {
  const seenContent = new Set<string>()
  const seenPath = new Set<string>()
  const result: Array<[string, string]> = []
  for (const [filePath, raw] of entries) {
    const content = (raw ?? '').trim()
    if (!content || seenPath.has(filePath) || seenContent.has(content)) continue
    seenPath.add(filePath)
    seenContent.add(content)
    result.push([filePath, content])
  }
  return result
}

/**
 * Text for the `/context` "Instruction files" section: every instruction
 * file loaded for the session with its scope, size and whether it is in the
 * prompt. Returns '' when the session has no instruction files.
 *
 * - `ledgerLabels`: labels recorded while building the system prompt
 *   (`instruction:<path>`); undefined before the first turn.
 * - `injectedNested`: nested files already injected as messages.
 */
export function formatInstructionFilesForCli(params: {
  instructionFiles?: InstructionFileRecord[]
  knowledgeFiles?: Record<string, string>
  userKnowledgeFiles?: Record<string, string>
  ledgerLabels?: ReadonlySet<string>
  injectedNested?: ReadonlySet<string>
}): string {
  const records: Array<InstructionFileRecord | { path: string; scope: 'user'; chars: number; importedBy?: undefined }> =
    params.instructionFiles
      ? [...params.instructionFiles]
      : Object.entries(params.knowledgeFiles ?? {}).map(([filePath, content]) => ({
          path: filePath,
          scope: filePath.includes('/') ? ('nested' as const) : ('project' as const),
          chars: content.length,
        }))
  for (const [filePath, content] of Object.entries(params.userKnowledgeFiles ?? {})) {
    records.push({ path: filePath, scope: 'user', chars: content.length })
  }
  if (records.length === 0) return ''
  const byPath = new Map(
    (params.instructionFiles ?? []).map((record) => [record.path, record]),
  )
  const status = (record: (typeof records)[number]): string => {
    const label = `instruction:${record.path}`
    if (params.ledgerLabels?.has(label)) return 'in prompt'
    const owner =
      record.scope === 'import'
        ? topLevelOwner(record as InstructionFileRecord, byPath)
        : record
    if (owner.scope === 'nested') {
      if (params.injectedNested?.has(record.path)) return 'injected'
      const dir = instructionFileDir(owner.path)
      return `loads when ${dir}/ is touched`
    }
    if (!params.ledgerLabels) return 'loaded'
    return 'not in prompt (duplicate content or not routed)'
  }
  const width = Math.min(
    48,
    Math.max(...records.map((record) => record.path.length)),
  )
  const lines = ['Instruction files']
  for (const record of records) {
    const from = record.importedBy ? ` (from ${record.importedBy})` : ''
    lines.push(
      `${record.path.padEnd(width)}  ${record.scope.padEnd(8)}  ${String(record.chars).padStart(7)} chars  ${status(record)}${from}`,
    )
  }
  return lines.join('\n')
}
