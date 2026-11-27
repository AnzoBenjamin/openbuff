import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ProjectRootViolation = {
  path: string
  line: number
  text: string
}

const TOOLS_DIRECTORY = 'packages/agent-runtime/src/tools'

const SCAN_EXTENSIONS = ['.ts', '.tsx']

const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx']

const TEST_DIRECTORY_MARKER = '/__tests__/'

const GUARD_OK_MARKER = 'guard-ok: projectRoot'

const COMMENT_PREFIXES = ['//', '*']

// True/false branches of a multi-line ternary. A line starting with `?` or `:`
// can only run after the condition on a preceding line was evaluated, so the
// root was already truth-tested there.
const TERNARY_CONTINUATION_PREFIXES = ['?', ':']

// `fileContext.projectRoot` dereferenced with a plain dot. The sanctioned form
// `fileContext?.projectRoot` must not match, so the dot is matched literally.
const UNGUARDED_DEREF = /\bfileContext\.projectRoot\b/

// A guard operator directly after the deref short-circuits or substitutes an
// absent root on the same line: `?? fallback`, `&& check`, `|| fallback`, or a
// ternary test. `?.` never reaches here (the base regex rejects it) but is
// listed so the intent stays explicit. No nested quantifiers: the lookahead is
// bounded and cannot backtrack pathologically.
const GUARDED_AFTER = /\bfileContext\.projectRoot\s*(?:\?\?|\?\.|\?|&&|\|\|)/

// Deliberate tradeoff: this is a heuristic line scanner, not a proof of safety.
// A deref split across lines in an exotic shape (`fileContext\n  .projectRoot`)
// can still slip through, and a multi-line ternary whose condition is not the
// root would be treated as guarded. It is a regression tripwire for the shapes
// that actually occurred, which is why a standalone deref line stays strict.

const SKIP_DIRECTORIES = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function toProjectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function isCommentLine(text: string): boolean {
  const trimmed = text.trim()
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function isGuardedLine(text: string): boolean {
  const trimmed = text.trim()

  // Comments may quote the pattern without ever dereferencing it.
  if (isCommentLine(text)) {
    return true
  }

  // Explicit escape hatch for a reviewed site the scanner cannot classify.
  if (text.includes(GUARD_OK_MARKER)) {
    return true
  }

  // A guard operator right after the deref handles the absent root inline.
  if (GUARDED_AFTER.test(text)) {
    return true
  }

  // Ternary branch line: the condition was evaluated on a preceding line.
  return TERNARY_CONTINUATION_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  )
}

function isScannedSourcePath(projectPath: string): boolean {
  if (projectPath.includes(TEST_DIRECTORY_MARKER)) {
    return false
  }

  if (TEST_FILE_SUFFIXES.some((suffix) => projectPath.endsWith(suffix))) {
    return false
  }

  return SCAN_EXTENSIONS.some((extension) => projectPath.endsWith(extension))
}

function* sourceFiles(
  root: string,
  directory = join(root, TOOLS_DIRECTORY),
): Generator<string> {
  if (!existsSync(directory)) {
    return
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    const projectPath = toProjectPath(root, absolutePath)

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue
      }
      yield* sourceFiles(root, absolutePath)
      continue
    }

    if (entry.isFile() && isScannedSourcePath(projectPath)) {
      yield absolutePath
    }
  }
}

export function findUnguardedProjectRootDerefs(
  root = projectRoot(),
): ProjectRootViolation[] {
  const violations: ProjectRootViolation[] = []

  for (const path of sourceFiles(root)) {
    const projectPath = toProjectPath(root, path)
    const lines = readFileSync(path, 'utf8').split('\n')

    lines.forEach((line, index) => {
      if (!UNGUARDED_DEREF.test(line)) {
        return
      }

      if (isGuardedLine(line)) {
        return
      }

      violations.push({
        path: projectPath,
        line: index + 1,
        text: line.trim(),
      })
    })
  }

  return violations
}

export function formatProjectRootViolations(
  violations: ProjectRootViolation[],
): string {
  if (violations.length === 0) {
    return 'Project-root guard passed: no unguarded fileContext.projectRoot dereferences found.'
  }

  return [
    'Unguarded fileContext.projectRoot dereferences:',
    ...violations.map(
      (violation) => `${violation.path}:${violation.line}: ${violation.text}`,
    ),
  ].join('\n')
}

if (import.meta.main) {
  const violations = findUnguardedProjectRootDerefs()

  if (violations.length > 0) {
    console.error(formatProjectRootViolations(violations))
    process.exit(1)
  }

  console.log(formatProjectRootViolations(violations))
}
