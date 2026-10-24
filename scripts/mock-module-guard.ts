/**
 * Guard against the bun `mock.module` capture traps that hung CI `test-cli`
 * (see cli/knowledge.md, knowledge refresh 2026-10-02e).
 *
 * bun's `mock.module` is registry-wide for the whole test process and patches
 * the target module's ESM namespace IN PLACE. A test that captures the "real"
 * module and then delegates to it from inside its mock factory must capture a
 * frozen SNAPSHOT of the real exports, otherwise the delegate calls the mock
 * itself (unbounded self-recursion / a ~98% CPU busy spin in a sibling suite).
 *
 * Flagged pattern (test files only, i.e. `*.test.ts` / `*.test.tsx`): a LIVE
 * binding of a module that the same file mocks — captured as
 *   - `const ns = await import('<spec>')` (plain identifier, no spread),
 *   - `import * as ns from '<spec>'`, or
 *   - `const ns = req('<spec>')` where `req` came from `createRequire(...)`
 * — whose members are read LAZILY (`ns.fn`) inside that module's own
 * `mock.module('<spec>', ...)` factory. An eager `...ns` spread is NOT
 * flagged: it copies the real values when the factory is evaluated.
 *
 * Safe shape: `const real = { ...(await import('<spec>')) }` before
 * `mock.module('<spec>', () => ({ ...real, fn: (...a) => real.fn(...a) }))`.
 *
 * Second check class — first-party FULL-REPLACEMENT factories: a
 * `mock.module('<spec>', ...)` whose specifier is first-party (relative
 * `./`/`../`, or the `@codebuff/`/`@openbuff/` scopes) and whose factory
 * body contains no `...identifier` spread. bun's `mock.module` is
 * registry-wide for the whole worker process (and `bun test --isolate`
 * reuses worker processes across test files), so such a factory drops
 * every un-overridden export of the real module for all sibling suites in
 * the same worker. Fix: snapshot-spread (`const real = { ...(await
 * import('<spec>')) }` + `{ ...real, ...overrides }`) or the shared
 * `mockModules()` helper from `@codebuff/common/testing/mock-modules`.
 * Builtins (`node:*`, `bun:*`, and a small builtin list) are skipped, and
 * an inline `mock-module-guard: intentional full replacement` marker (on
 * the `mock.module(` line or the comment line directly above it) exempts
 * a call.
 *
 * Heuristic, regex-based (no AST): both checks target their exact leak
 * traps, not every possible aliasing. Run: `bun scripts/mock-module-guard.ts`
 * (exit 1 on findings).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type MockModuleFinding = {
  path: string
  line: number
  message: string
  /**
   * Which check emitted the finding. Only the second check class sets it;
   * full-replacement findings sort after lazy-binding findings per file.
   */
  kind?: 'full-replacement'
}

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
])
const TEST_FILE_REGEX = /\.test\.tsx?$/
// The guard's own suite embeds leaky patterns as string fixtures.
const EXCLUDED_PATHS = new Set(['scripts/__tests__/mock-module-guard.test.ts'])

const MOCK_MODULE_CALL_REGEX = /mock\.module\(\s*(['"`])([^'"`]+)\1/g
const CREATE_REQUIRE_BINDING_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g
// `const ns = await import('spec')` — a plain identifier, so NOT `{ ...` and
// NOT a `{ a, b }` destructure.
const LIVE_DYNAMIC_IMPORT_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*(['"`])([^'"`]+)\2\s*\)/g
const STATIC_NAMESPACE_IMPORT_REGEX =
  /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"`])([^'"`]+)\2/g

// Second check class (first-party full-replacement factories): any
// `...identifier` spread in the factory body counts as keeping the real
// exports alive. This also matches `...rest` parameters inside the factory
// body — an acceptable false positive, since a rest parameter implies a
// delegating wrapper, which is the safe shape this check wants anyway.
const SPREAD_IN_FACTORY_REGEX = /\.\.\.\s*[A-Za-z_$][\w$]*/
// Exact exemption token for intentional full replacements; honored on the
// `mock.module(` line itself or on the comment line directly above it.
const INTENTIONAL_FULL_REPLACEMENT_MARKER =
  'mock-module-guard: intentional full replacement'
// Bare builtins have no sibling first-party exports to drop;
// `node:`/`bun:`-prefixed specifiers are skipped for the same reason.
const BUILTIN_SPECIFIERS = new Set([
  'fs',
  'path',
  'os',
  'net',
  'http',
  'crypto',
  'url',
  'util',
  'child_process',
])

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Blanks out the interior of `//` line comments and C-style block comments
 * with spaces while preserving every newline and all non-comment characters
 * byte-for-byte, so indices and `lineOf` still map to the original line
 * numbers. String literals ('...', "...", `...`) are tracked FIRST, so a
 * `//` inside a string (e.g. 'http://localhost:1455') is never treated as a
 * comment. Backtick template literals are handled as plain strings; nested
 * `${...}` interpolation inside a template may be misclassified — an
 * acceptable trade-off for a heuristic guard.
 */
function stripCommentsPreservingLines(content: string): string {
  const chars = content.split('')
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' =
    'code'
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1] ?? ''
    if (state === 'code') {
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      else if (ch === '/' && next === '/') {
        state = 'line'
        chars[i] = ' '
        chars[i + 1] = ' '
        i += 2
        continue
      } else if (ch === '/' && next === '*') {
        state = 'block'
        chars[i] = ' '
        chars[i + 1] = ' '
        i += 2
        continue
      }
      i++
      continue
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code'
      }
      i++
      continue
    }
    if (state === 'line') {
      if (ch === '\n') state = 'code'
      else chars[i] = ' '
      i++
      continue
    }
    // Block comment: blank the interior (newlines kept) and the closing
    // delimiter, so comment text can never match a regex pass below.
    if (ch === '*' && next === '/') {
      state = 'code'
      chars[i] = ' '
      chars[i + 1] = ' '
      i += 2
      continue
    }
    if (ch !== '\n') chars[i] = ' '
    i++
  }
  return chars.join('')
}

/**
 * Returns the source text of each `mock.module(...)` call (balanced parens),
 * so references inside the factory can be checked.
 */
function mockModuleCalls(
  content: string,
): Array<{ specifier: string; body: string; index: number }> {
  const calls: Array<{ specifier: string; body: string; index: number }> = []
  for (const match of content.matchAll(MOCK_MODULE_CALL_REGEX)) {
    const start = match.index ?? 0
    const open = content.indexOf('(', start)
    let depth = 0
    let end = content.length
    for (let i = open; i < content.length; i++) {
      const ch = content[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    calls.push({
      specifier: match[2]!,
      body: content.slice(open, end),
      index: start,
    })
  }
  return calls
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A specifier whose module is owned by this workspace. */
function isFirstPartySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('@codebuff/') ||
    specifier.startsWith('@openbuff/')
  )
}

/**
 * Specifiers whose mocks never need a spread: bare builtins have no sibling
 * first-party exports to drop, and `node:`/`bun:`-prefixed builtins likewise.
 */
function isSkippedSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    specifier.startsWith('bun:') ||
    BUILTIN_SPECIFIERS.has(specifier)
  )
}

/** Analyze one test file's source with both checks. `path` is only used for reporting. */
export function analyzeTestFile(
  path: string,
  content: string,
): MockModuleFinding[] {
  // Regex passes run on a comment-stripped view: a `mock.module(...)` mention
  // inside a comment must not create a phantom call, and `import * as` inside
  // a comment must not create a phantom binding. The stripped text preserves
  // every newline, so indices still map to the original line numbers.
  const stripped = stripCommentsPreservingLines(content)
  const calls = mockModuleCalls(stripped)
  if (calls.length === 0) return []

  const findings: MockModuleFinding[] = []
  const bindings: Array<{ name: string; specifier: string; index: number }> =
    []
  for (const m of stripped.matchAll(LIVE_DYNAMIC_IMPORT_REGEX)) {
    bindings.push({ name: m[1]!, specifier: m[3]!, index: m.index ?? 0 })
  }
  for (const m of stripped.matchAll(STATIC_NAMESPACE_IMPORT_REGEX)) {
    bindings.push({ name: m[1]!, specifier: m[3]!, index: m.index ?? 0 })
  }
  for (const r of stripped.matchAll(CREATE_REQUIRE_BINDING_REGEX)) {
    const requireFn = escapeRegex(r[1]!)
    const requireCall = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${requireFn}\\(\\s*(['"\`])([^'"\`]+)\\2\\s*\\)`,
      'g',
    )
    for (const m of stripped.matchAll(requireCall)) {
      bindings.push({ name: m[1]!, specifier: m[3]!, index: m.index ?? 0 })
    }
  }

  for (const binding of bindings) {
    // Lazy VALUE member access only (`ns.fn`): never an eager `...ns` spread,
    // and never a type position (`typeof ns.fn`), which is erased at runtime.
    const usage = new RegExp(
      `(?<!typeof\\s+)(?<![\\w$.])${escapeRegex(binding.name)}\\s*\\.\\s*[A-Za-z_$]`,
    )
    const referencedInSameFactory = calls.some(
      (call) => call.specifier === binding.specifier && usage.test(call.body),
    )
    if (referencedInSameFactory) {
      findings.push({
        path,
        line: lineOf(content, binding.index),
        message: `live binding \`${binding.name}\` of '${binding.specifier}' is read lazily inside mock.module('${binding.specifier}') — mock.module patches that module in place, so the delegate can call itself; snapshot it with \`const ${binding.name} = { ...(await import('${binding.specifier}')) }\``,
      })
    }
  }

  // Second check class: first-party FULL-REPLACEMENT factories. A factory
  // that never spreads the real module's exports drops every un-overridden
  // export for all sibling suites in the same worker (bun's mock.module is
  // registry-wide; `bun test --isolate` reuses worker processes).
  const fullReplacementFindings: MockModuleFinding[] = []
  const lines = content.split('\n')
  for (const call of calls) {
    if (!isFirstPartySpecifier(call.specifier)) continue
    if (isSkippedSpecifier(call.specifier)) continue
    if (SPREAD_IN_FACTORY_REGEX.test(call.body)) continue
    const callLineIndex = lineOf(content, call.index) - 1
    const callLine = lines[callLineIndex] ?? ''
    const previousLine =
      callLineIndex > 0 ? (lines[callLineIndex - 1] ?? '') : ''
    if (
      callLine.includes(INTENTIONAL_FULL_REPLACEMENT_MARKER) ||
      previousLine.includes(INTENTIONAL_FULL_REPLACEMENT_MARKER)
    ) {
      continue
    }
    fullReplacementFindings.push({
      path,
      line: callLineIndex + 1,
      kind: 'full-replacement',
      message: `full-replacement mock of first-party module '${call.specifier}' never spreads the real exports, dropping every un-overridden export for all sibling suites in the same worker (bun's mock.module is registry-wide; \`bun test --isolate\` reuses worker processes) — spread a snapshot instead: \`const real = { ...(await import('${call.specifier}')) }\` + \`{ ...real, ...overrides }\`, or use the shared helper \`mockModules()\` from '@codebuff/common/testing/mock-modules' (if intentional, add \`// mock-module-guard: intentional full replacement\` above the call)`,
    })
  }

  // New-class findings sort after the original lazy-binding findings per
  // file; each group keeps line order.
  return [
    ...findings.sort((a, b) => a.line - b.line),
    ...fullReplacementFindings.sort((a, b) => a.line - b.line),
  ]
}

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* testFiles(join(dir, entry.name))
    } else if (entry.isFile() && TEST_FILE_REGEX.test(entry.name)) {
      yield join(dir, entry.name)
    }
  }
}

export function runMockModuleGuard(root: string): MockModuleFinding[] {
  const findings: MockModuleFinding[] = []
  for (const file of testFiles(root)) {
    const projectPath = relative(root, file).split(sep).join('/')
    if (EXCLUDED_PATHS.has(projectPath)) continue
    findings.push(...analyzeTestFile(projectPath, readFileSync(file, 'utf8')))
  }
  return findings.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    // Full-replacement findings sort after the original lazy-binding
    // findings within the same file, regardless of line.
    const rank = (f: MockModuleFinding) =>
      f.kind === 'full-replacement' ? 1 : 0
    return rank(a) - rank(b) || a.line - b.line
  })
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = runMockModuleGuard(root)
  if (findings.length === 0) {
    console.log('Mock-module guard passed: 0 findings.')
    process.exit(0)
  }
  console.error(`Mock-module guard: ${findings.length} finding(s)`)
  for (const f of findings) {
    console.error(`${f.path}:${f.line}: ${f.message}`)
  }
  process.exit(1)
}
