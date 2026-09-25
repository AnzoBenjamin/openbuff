import type { Logger } from '@codebuff/common/types/contracts/logger'
import { escapeRegexForLiteral as escapeRegex } from '@codebuff/common/util/language-profiles'

/**
 * Fixed import-line regex for the JS/TS family, compiled once at module
 * load instead of per import-processing call.
 */
const JS_IMPORT_REGEX =
  /^import(?:\s+type)?(?:\s+[\s\S]*?\s+from\s+['"][^'"]+['"]|\s+['"][^'"]+['"]);?\r?\n?/gm

/** Non-matching regex shared by extensions with no import-line syntax. */
const NO_MATCH_IMPORT_REGEX = /$a/g

/**
 * Hoisted literal patterns (per-call-regex-literals-in-import-paths / RF-12):
 * each of these used to be evaluated as a regex literal inside the
 * import-processing helpers — a fresh RegExp per call or per import range
 * (up to ~3 per statement across removeImport's filter over a large file).
 * All are non-global (or used only via matchAll/replace, which never retain
 * shared lastIndex state), so the shared instances are safe for repeated
 * exec/test/match.
 */
const TRAILING_SEMICOLON_REGEX = /;$/
const FILE_EXTENSION_REGEX = /\.[^.\/]+$/
const GO_IMPORT_CLAUSE_REGEX = /^import\s+(.+)$/s
const GO_QUOTED_SPECIFIER_REGEX = /["`]([^"`]+)["`]/
const GO_IMPORT_BLOCK_REGEX =
  /(^[ \t]*import[ \t]*\([ \t]*\r?\n)([\s\S]*?)(^[ \t]*\)[ \t]*\r?\n?)/m
const QUOTED_FROM_CLAUSE_REGEX = /\sfrom\s+['"]([^'"]+)['"]\s*;?$/
const QUOTED_SIDE_EFFECT_IMPORT_REGEX = /^import\s+['"]([^'"]+)['"]\s*;?$/
const QUOTED_STRING_REGEX = /['"]([^'"]+)['"]/
const JS_NAMED_IMPORT_STATEMENT_REGEX =
  /^import(?:\s+type)?\s+[\s\S]+\s+from\s+['"][^'"]+['"]$/
const JS_SIDE_EFFECT_IMPORT_STATEMENT_REGEX = /^import\s+['"][^'"]+['"]$/
const JS_USE_STRICT_REGEX = /^(?:['"]use strict['"];?\r?\n)/
const PY_IMPORT_STATEMENT_REGEX =
  /^(?:from\s+[.\w]+\s+import\s+.+|import\s+[\w.]+(?:\s+as\s+\w+)?)$/
const PY_CODING_COOKIE_REGEX = /^#.*coding[:=][ \t]*[-\w.]+[ \t]*\r?\n/
const PY_DOCSTRING_REGEX =
  /^(?:[ \t]*\r?\n)*[rubfRUBF]*("""|''')[\s\S]*?\1[ \t]*\r?\n?/
const PY_FROM_MODULE_REGEX = /^from\s+([.\w]+)\s+import/
const PY_IMPORT_MODULE_REGEX = /^import\s+([\w.]+)/
const RS_IMPORT_STATEMENT_REGEX = /^(?:pub\s+)?(?:use\s+[^;]+|mod\s+\w+);?$/
const RS_PROLOGUE_REGEX = /^(?:(?:#!\[[^\n]+\]|\/\/![^\n]*)[ \t]*\r?\n)*/
const RS_USE_PATH_REGEX = /^(?:pub\s+)?(?:use|mod)\s+([^;]+)/
const GO_LINE_IMPORT_STATEMENT_REGEX =
  /^import\s+(?:[\w.]+\s+)?["`][^"`]+["`]$/
const GO_BLOCK_IMPORT_STATEMENT_REGEX =
  /^import\s*\([\s\S]*["`][^"`]+["`][\s\S]*\)$/
const GO_PACKAGE_LINE_REGEX = /^[ \t]*package\s+\w+[ \t]*\r?\n/m
const JVM_IMPORT_STATEMENT_REGEX = /^import\s+(?:static\s+)?[\w.*]+;?$/
const JVM_PACKAGE_LINE_REGEX = /^[ \t]*package\s+[\w.]+[ \t]*;?[ \t]*\r?\n/m
const JVM_IMPORT_MODULE_REGEX = /^import\s+(?:static\s+)?([\w.*]+)/
const CS_IMPORT_STATEMENT_REGEX =
  /^(?:global\s+)?using\s+(?:\w+\s*=\s*)?[\w.]+;?$/
const CS_USING_MODULE_REGEX = /using\s+(?:\w+\s*=\s*)?([\w.]+)/
const C_INCLUDE_STATEMENT_REGEX = /^#\s*include\s*[<"][^>"]+[>"]$/
const C_INCLUDE_PATH_REGEX = /[<"]([^>"]+)[>"]/
const RB_REQUIRE_STATEMENT_REGEX =
  /^require(?:_relative)?\s*[('" ]+[^'"\s)]+['"]?\)?$/
const RB_REQUIRE_TARGET_REGEX = /require(?:_relative)?\s*[('" ]+([^'"\s)]+)/
const PHP_IMPORT_STATEMENT_REGEX =
  /^(?:use\s+[\w\\]+|(?:require|require_once|include|include_once)\s*\(\s*['"][^'"]+['"]\)?);?$/
const PHP_OPEN_TAG_REGEX = /^\uFEFF?<\?php\b/
const PHP_DECLARE_REGEX = /^declare\s*\([^)]*\)\s*;/
const PHP_NAMESPACE_REGEX = /^namespace\s+[\w\\]+\s*(?:;|\{)/
const PHP_USE_MODULE_REGEX = /^use\s+([\w\\]+)/
const PHP_TRIVIA_REGEX =
  /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$)|#(?!\[)[^\n]*(?:\n|$))/
const SWIFT_IMPORT_STATEMENT_REGEX = /^import\s+(?:\w+\s+)?[\w.]+$/
const SWIFT_IMPORT_MODULE_REGEX = /^import\s+(?:\w+\s+)?([\w.]+)/
const GD_PRELOAD_STATEMENT_REGEX =
  /^(?:const|var)\s+\w+(?::[^=]+)?\s*=\s*(?:preload|load)\(\s*["']res:\/\/[^"']+["']\s*\)$/
const GD_PRELOAD_PATH_REGEX = /["']res:\/\/([^"']+)["']/
const GD_HEADER_LINE_REGEX =
  /^[ \t]*(?:@tool|class_name\s+\w+|extends\s+.+)[ \t]*\r?\n/gm
const LEADING_NEWLINE_REGEX = /^[ \t]*\r?\n/
const BACKSLASH_GLOBAL_REGEX = /\\/g

/**
 * Memoized RegExp cache keyed by a caller-namespaced string (import-line,
 * go-block, go-line, ...). Bounded with per-entry LRU eviction so
 * model-supplied keys — module-specifier text, file extensions on edit
 * paths — can't grow the cache unboundedly
 * (import-line-regex-cache-unbounded), while a hot key hit on every call
 * survives adversarial cold-key churn instead of being dropped with the
 * whole cache on each overflow (regex-cache-clear-on-overflow-thrash).
 * Also the seam the CASE 4 rows in scripts/measure-perf-guards-baseline.ts
 * measure, so that benchmark's after row times this shipped cache.
 */
const REGEX_CACHE = new Map<string, RegExp>()
const REGEX_CACHE_LIMIT = 512

export function cachedRegExp(key: string, build: () => RegExp): RegExp {
  const cached = REGEX_CACHE.get(key)
  if (cached) {
    // Refresh recency: Map iterates in insertion order, so re-inserting the
    // hit key at the end marks it most-recently-used for the eviction below
    // (O(1) bookkeeping, far cheaper than the RegExp construction it avoids).
    REGEX_CACHE.delete(key)
    REGEX_CACHE.set(key, cached)
    return cached
  }
  if (REGEX_CACHE.size >= REGEX_CACHE_LIMIT) {
    // Evict ONLY the least-recently-used entry (the first insertion-order
    // key after the hit-refresh above). The previous clear-on-overflow policy
    // dropped every hot key each time adversarial key churn filled the cache,
    // making the memo strictly more per-call work than uncached RegExp
    // construction.
    const oldest = REGEX_CACHE.keys().next()
    if (!oldest.done) {
      REGEX_CACHE.delete(oldest.value)
    }
  }
  const regex = build()
  REGEX_CACHE.set(key, regex)
  return regex
}

export type InsertTextStructuredOperation = {
  kind: 'insert_text'
  position: {
    line: number
    column: number
  }
  text: string
}

export type InsertImportStructuredOperation = {
  kind: 'insert_import'
  importStatement: string
}

export type RemoveImportStructuredOperation = {
  kind: 'remove_import'
  importStatement?: string
  moduleSpecifier?: string
}

export type StructuredEditOperation =
  | InsertTextStructuredOperation
  | InsertImportStructuredOperation
  | RemoveImportStructuredOperation

export type StructuredTransactionEdit = {
  id?: string
  type: 'structured'
  path: string
  operation: StructuredEditOperation
}

type StructuredEditResult =
  | {
      content: string
      messages: string[]
    }
  | {
      error: string
    }

export async function processStructuredEdit(params: {
  edit: StructuredTransactionEdit
  initialContentPromise: Promise<string | null>
  logger: Logger
}): Promise<StructuredEditResult> {
  const { edit, initialContentPromise, logger } = params
  const initialContent = await initialContentPromise

  if (initialContent === null) {
    return {
      error: `Cannot apply structured ${edit.operation.kind} edit to ${edit.path}: file does not exist or could not be read.`,
    }
  }

  switch (edit.operation.kind) {
    case 'insert_text':
      return insertText({
        edit: { ...edit, operation: edit.operation },
        content: initialContent,
        logger,
      })
    case 'insert_import':
      return insertImport({
        edit: { ...edit, operation: edit.operation },
        content: initialContent,
        logger,
      })
    case 'remove_import':
      return removeImport({
        edit: { ...edit, operation: edit.operation },
        content: initialContent,
        logger,
      })
  }
}

function insertText(params: {
  edit: StructuredTransactionEdit & { operation: InsertTextStructuredOperation }
  content: string
  logger: Logger
}): StructuredEditResult {
  const { edit, content, logger } = params
  const { line, column } = edit.operation.position

  if (line < 1 || column < 1) {
    return {
      error: `Invalid insert_text position for ${edit.path}: line and column are 1-indexed and must be >= 1.`,
    }
  }

  const lineStartOffsets = getLineStartOffsets(content)
  if (line > lineStartOffsets.length) {
    return {
      error: `Invalid insert_text position for ${edit.path}: line ${line} is past end of file (${lineStartOffsets.length} line(s)).`,
    }
  }

  const lineStart = lineStartOffsets[line - 1]
  const lineEnd = getLineEndOffset(content, lineStart)
  const lineLength = lineEnd - lineStart
  if (column > lineLength + 1) {
    return {
      error: `Invalid insert_text position for ${edit.path}: column ${column} is past end of line (${lineLength + 1}).`,
    }
  }

  const offset = lineStart + column - 1
  logger.debug(
    {
      path: edit.path,
      operation: edit.operation.kind,
      line,
      column,
      insertedLength: edit.operation.text.length,
    },
    'Applying structured edit',
  )

  return {
    content: `${content.slice(0, offset)}${edit.operation.text}${content.slice(offset)}`,
    messages: [
      `Applied structured insert_text at ${edit.path}:${line}:${column}.`,
    ],
  }
}

function insertImport(params: {
  edit: StructuredTransactionEdit & {
    operation: InsertImportStructuredOperation
  }
  content: string
  logger: Logger
}): StructuredEditResult {
  const { edit, content, logger } = params
  const importStatement = normalizeImportStatement(
    edit.operation.importStatement,
    edit.path,
  )
  if (!isValidImportStatement(edit.path, importStatement)) {
    return {
      error: `Invalid insert_import statement for ${edit.path}: expected a complete language-native import declaration.`,
    }
  }

  const goBlockInsertion = insertIntoGoImportBlock(
    edit.path,
    content,
    importStatement,
  )
  if (goBlockInsertion) {
    if ('error' in goBlockInsertion) return goBlockInsertion
    return {
      content: goBlockInsertion.content,
      messages: [`Applied structured insert_import in ${edit.path}.`],
    }
  }

  const existingImport = findImportStatement(
    edit.path,
    content,
    importStatement,
  )
  if (existingImport) {
    return {
      error: `Cannot insert import into ${edit.path}: import already exists.`,
    }
  }

  const insertionOffset = getImportInsertionOffset(edit.path, content)
  const prefix = content.slice(0, insertionOffset)
  const suffix = content.slice(insertionOffset)
  const separator = prefix.length === 0 || prefix.endsWith('\n') ? '' : '\n'
  const trailing =
    suffix.length === 0 ? '' : suffix.startsWith('\n') ? '' : '\n'
  logger.debug(
    { path: edit.path, operation: edit.operation.kind, importStatement },
    'Applying structured edit',
  )

  return {
    content: `${prefix}${separator}${importStatement}\n${trailing}${suffix}`,
    messages: [`Applied structured insert_import in ${edit.path}.`],
  }
}

function removeImport(params: {
  edit: StructuredTransactionEdit & {
    operation: RemoveImportStructuredOperation
  }
  content: string
  logger: Logger
}): StructuredEditResult {
  const { edit, content, logger } = params
  const importStatement = edit.operation.importStatement
    ? normalizeImportStatement(edit.operation.importStatement, edit.path)
    : undefined
  const moduleSpecifier = edit.operation.moduleSpecifier

  if (!importStatement && !moduleSpecifier) {
    return {
      error: `Invalid remove_import operation for ${edit.path}: provide importStatement or moduleSpecifier.`,
    }
  }
  if (importStatement && !isValidImportStatement(edit.path, importStatement)) {
    return {
      error: `Invalid remove_import statement for ${edit.path}: expected a complete language-native import declaration.`,
    }
  }

  if (moduleSpecifier && extensionForPath(edit.path) === '.go') {
    const goRemoval = removeFromGoImportBlock(content, moduleSpecifier)
    if (goRemoval) {
      return {
        content: goRemoval,
        messages: [`Applied structured remove_import in ${edit.path}.`],
      }
    }
  }

  const ranges = getImportRanges(edit.path, content)
  const matchingRanges = ranges.filter((range) => {
    const statement = content.slice(range.start, range.end).trim()
    if (
      importStatement &&
      normalizeImportStatement(statement, edit.path) === importStatement
    ) {
      return true
    }
    return moduleSpecifier
      ? getImportModuleSpecifier(edit.path, statement) === moduleSpecifier
      : false
  })

  if (matchingRanges.length === 0) {
    return {
      error: `Cannot remove import from ${edit.path}: no matching import declaration found.`,
    }
  }
  if (matchingRanges.length > 1) {
    return {
      error: `Cannot remove import from ${edit.path}: ${matchingRanges.length} matching import declarations found.`,
    }
  }

  const range = matchingRanges[0]
  logger.debug(
    {
      path: edit.path,
      operation: edit.operation.kind,
      importStatement,
      moduleSpecifier,
    },
    'Applying structured edit',
  )

  return {
    content: `${content.slice(0, range.start)}${content.slice(range.end)}`,
    messages: [`Applied structured remove_import in ${edit.path}.`],
  }
}

function normalizeImportStatement(statement: string, filePath: string): string {
  const trimmed = statement.trim()
  return [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mts',
    '.cts',
    '.mjs',
    '.cjs',
  ].includes(extensionForPath(filePath))
    ? trimmed.replace(TRAILING_SEMICOLON_REGEX, '')
    : trimmed
}

function insertIntoGoImportBlock(
  filePath: string,
  content: string,
  importStatement: string,
): { content: string } | { error: string } | null {
  if (extensionForPath(filePath) !== '.go') return null
  const specifier = importStatement.match(GO_IMPORT_CLAUSE_REGEX)?.[1]
  if (!specifier || specifier.startsWith('(')) return null
  const moduleSpecifier = specifier.match(GO_QUOTED_SPECIFIER_REGEX)?.[1]
  const block = GO_IMPORT_BLOCK_REGEX.exec(content)
  if (!block) return null
  if (
    moduleSpecifier &&
    cachedRegExp(`go-block:${moduleSpecifier}`, () =>
      new RegExp(`["\`]${escapeRegex(moduleSpecifier)}["\`]`),
    ).test(block[2])
  ) {
    return {
      error: `Cannot insert import into ${filePath}: import already exists.`,
    }
  }
  const closingOffset = block.index + block[1].length + block[2].length
  return {
    content: `${content.slice(0, closingOffset)}\t${specifier}\n${content.slice(closingOffset)}`,
  }
}

function removeFromGoImportBlock(
  content: string,
  moduleSpecifier: string,
): string | null {
  const block = GO_IMPORT_BLOCK_REGEX.exec(content)
  if (!block) return null
  const lineRegex = cachedRegExp(`go-line:${moduleSpecifier}`, () =>
    new RegExp(
      `^[ \\t]*(?:[\\w.]+\\s+)?["\`]${escapeRegex(moduleSpecifier)}["\`][ \\t]*(?:\\/\\/.*)?\\r?\\n?`,
      'm',
    ),
  )
  const line = lineRegex.exec(block[2])
  if (!line) return null
  const start = block.index + block[1].length + line.index
  return `${content.slice(0, start)}${content.slice(start + line[0].length)}`
}

function extensionForPath(filePath: string): string {
  const match = filePath.toLowerCase().match(FILE_EXTENSION_REGEX)
  return match?.[0] ?? ''
}

function isValidImportStatement(filePath: string, statement: string): boolean {
  const extension = extensionForPath(filePath)
  if (
    ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(
      extension,
    )
  ) {
    return (
      JS_NAMED_IMPORT_STATEMENT_REGEX.test(statement) ||
      JS_SIDE_EFFECT_IMPORT_STATEMENT_REGEX.test(statement)
    )
  }
  if (['.py', '.pyi'].includes(extension)) {
    return PY_IMPORT_STATEMENT_REGEX.test(statement)
  }
  if (extension === '.rs')
    return RS_IMPORT_STATEMENT_REGEX.test(statement)
  if (extension === '.go')
    return (
      GO_LINE_IMPORT_STATEMENT_REGEX.test(statement) ||
      GO_BLOCK_IMPORT_STATEMENT_REGEX.test(statement)
    )
  if (['.java', '.kt', '.kts'].includes(extension))
    return JVM_IMPORT_STATEMENT_REGEX.test(statement)
  if (extension === '.cs')
    return CS_IMPORT_STATEMENT_REGEX.test(statement)
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(
      extension,
    )
  ) {
    return C_INCLUDE_STATEMENT_REGEX.test(statement)
  }
  if (extension === '.rb')
    return RB_REQUIRE_STATEMENT_REGEX.test(statement)
  if (extension === '.php')
    return PHP_IMPORT_STATEMENT_REGEX.test(statement)
  if (extension === '.swift')
    return SWIFT_IMPORT_STATEMENT_REGEX.test(statement)
  if (extension === '.gd')
    return GD_PRELOAD_STATEMENT_REGEX.test(statement)
  return false
}

function findImportStatement(
  filePath: string,
  content: string,
  importStatement: string,
): boolean {
  return getImportRanges(filePath, content).some(
    (range) =>
      normalizeImportStatement(
        content.slice(range.start, range.end),
        filePath,
      ) === importStatement,
  )
}

function getImportInsertionOffset(filePath: string, content: string): number {
  const ranges = getImportRanges(filePath, content)
  if (ranges.length > 0) {
    return ranges[ranges.length - 1].end
  }

  const extension = extensionForPath(filePath)
  const shebangEnd = content.startsWith('#!') ? content.indexOf('\n') + 1 : 0
  if (['.py', '.pyi'].includes(extension)) {
    let offset = shebangEnd
    const afterShebang = content.slice(offset)
    const encoding = afterShebang.match(PY_CODING_COOKIE_REGEX)
    if (encoding) offset += encoding[0].length
    const docstring = content.slice(offset).match(PY_DOCSTRING_REGEX)
    if (docstring) offset += docstring[0].length
    return offset
  }
  if (extension === '.rs') {
    const prologue = content.match(RS_PROLOGUE_REGEX)
    return prologue?.[0].length ?? 0
  }
  if (extension === '.go') {
    const packageMatch = content.match(GO_PACKAGE_LINE_REGEX)
    return packageMatch ? packageMatch.index! + packageMatch[0].length : 0
  }
  if (['.java', '.kt', '.kts'].includes(extension)) {
    const packageMatch = content.match(JVM_PACKAGE_LINE_REGEX)
    return packageMatch ? packageMatch.index! + packageMatch[0].length : 0
  }
  if (extension === '.php') {
    return getPhpImportInsertionOffset(content)
  }
  if (extension === '.gd') {
    const headerMatches = [
      ...content.matchAll(GD_HEADER_LINE_REGEX),
    ]
    const lastHeader = headerMatches.at(-1)
    return lastHeader?.index !== undefined
      ? lastHeader.index + lastHeader[0].length
      : 0
  }
  const useStrictMatch = content.slice(shebangEnd).match(JS_USE_STRICT_REGEX)
  return shebangEnd + (useStrictMatch?.[0].length ?? 0)
}

function getPhpImportInsertionOffset(content: string): number {
  let offset = content.match(PHP_OPEN_TAG_REGEX)?.[0].length ?? 0
  offset = skipPhpTrivia(content, offset)

  const declareMatch = content.slice(offset).match(PHP_DECLARE_REGEX)
  if (declareMatch) {
    offset += declareMatch[0].length
    offset = skipPhpTrivia(content, offset)
  }

  const namespaceMatch = content
    .slice(offset)
    .match(PHP_NAMESPACE_REGEX)
  if (namespaceMatch) offset += namespaceMatch[0].length

  const newline = content.slice(offset).match(LEADING_NEWLINE_REGEX)
  return offset + (newline?.[0].length ?? 0)
}

function skipPhpTrivia(content: string, start: number): number {
  let offset = start
  while (offset < content.length) {
    const trivia = content.slice(offset).match(PHP_TRIVIA_REGEX)
    if (!trivia) break
    offset += trivia[0].length
  }
  return offset
}

function getImportRanges(
  filePath: string,
  content: string,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  const extension = extensionForPath(filePath)
  const importRegex = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mts',
    '.cts',
    '.mjs',
    '.cjs',
  ].includes(extension)
    ? JS_IMPORT_REGEX
    : importLineRegex(extension)
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function importLineRegex(extension: string): RegExp {
  return cachedRegExp(`import-line:${extension}`, () =>
    buildImportLineRegex(extension),
  )
}

function buildImportLineRegex(extension: string): RegExp {
  if (['.py', '.pyi'].includes(extension))
    return /^[ \t]*(?:from\s+[.\w]+\s+import\s+.+|import\s+.+)\r?\n?/gm
  if (extension === '.rs')
    return /^[ \t]*(?:pub\s+)?(?:use\s+[^;]+;?|mod\s+\w+;?)[ \t]*\r?\n?/gm
  if (extension === '.go')
    return /^[ \t]*import(?:\s+(?:[\w.]+\s+)?["`][^"`]+["`][ \t]*|[ \t]*\([\s\S]*?^[ \t]*\)[ \t]*)\r?\n?/gm
  if (['.java', '.kt', '.kts'].includes(extension))
    return /^[ \t]*import\s+(?:static\s+)?[\w.*]+[ \t]*;?[ \t]*\r?\n?/gm
  if (extension === '.cs')
    return /^[ \t]*(?:global\s+)?using\s+(?:\w+\s*=\s*)?[\w.]+[ \t]*;[ \t]*\r?\n?/gm
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(
      extension,
    )
  )
    return /^[ \t]*#\s*include\s*[<"][^>"]+[>"][ \t]*\r?\n?/gm
  if (extension === '.rb')
    return /^[ \t]*require(?:_relative)?\s*[('" ]+[^'"\s)]+['"]?\)?[ \t]*\r?\n?/gm
  if (extension === '.php')
    return /^[ \t]*(?:use\s+[\w\\]+|(?:require|require_once|include|include_once)\s*\(?\s*['"][^'"]+['"]\)?)[ \t]*;?[ \t]*\r?\n?/gm
  if (extension === '.swift')
    return /^[ \t]*import\s+(?:\w+\s+)?[\w.]+[ \t]*\r?\n?/gm
  if (extension === '.gd')
    return /^[ \t]*(?:const|var)\s+\w+(?::[^=]+)?\s*=\s*(?:preload|load)\(\s*["']res:\/\/[^"']+["']\s*\)[ \t]*\r?\n?/gm
  return NO_MATCH_IMPORT_REGEX
}

function getImportModuleSpecifier(
  filePath: string,
  statement: string,
): string | null {
  const extension = extensionForPath(filePath)
  const fromMatch = statement.match(QUOTED_FROM_CLAUSE_REGEX)
  if (fromMatch) return fromMatch[1]
  const sideEffectMatch = statement.match(QUOTED_SIDE_EFFECT_IMPORT_REGEX)
  if (sideEffectMatch) return sideEffectMatch[1]
  if (['.py', '.pyi'].includes(extension)) {
    return (
      statement.match(PY_FROM_MODULE_REGEX)?.[1] ??
      statement.match(PY_IMPORT_MODULE_REGEX)?.[1] ??
      null
    )
  }
  if (extension === '.rs')
    return statement.match(RS_USE_PATH_REGEX)?.[1] ?? null
  if (extension === '.go')
    return statement.match(GO_QUOTED_SPECIFIER_REGEX)?.[1] ?? null
  if (['.java', '.kt', '.kts'].includes(extension))
    return statement.match(JVM_IMPORT_MODULE_REGEX)?.[1] ?? null
  if (extension === '.cs')
    return statement.match(CS_USING_MODULE_REGEX)?.[1] ?? null
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(
      extension,
    )
  )
    return statement.match(C_INCLUDE_PATH_REGEX)?.[1] ?? null
  if (extension === '.rb')
    return (
      statement.match(RB_REQUIRE_TARGET_REGEX)?.[1] ?? null
    )
  if (extension === '.php')
    return (
      statement.match(PHP_USE_MODULE_REGEX)?.[1]?.replace(BACKSLASH_GLOBAL_REGEX, '/') ??
      statement.match(QUOTED_STRING_REGEX)?.[1] ??
      null
    )
  if (extension === '.swift')
    return statement.match(SWIFT_IMPORT_MODULE_REGEX)?.[1] ?? null
  if (extension === '.gd')
    return statement.match(GD_PRELOAD_PATH_REGEX)?.[1] ?? null
  return null
}

function getLineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n' && index + 1 < content.length) {
      offsets.push(index + 1)
    }
  }
  return offsets
}

function getLineEndOffset(content: string, lineStart: number): number {
  const newlineIndex = content.indexOf('\n', lineStart)
  const rawLineEnd = newlineIndex === -1 ? content.length : newlineIndex
  return rawLineEnd > lineStart && content[rawLineEnd - 1] === '\r'
    ? rawLineEnd - 1
    : rawLineEnd
}
