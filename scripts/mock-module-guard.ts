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
 * Heuristic, regex-based (no AST): it targets the exact hang trap, not every
 * possible aliasing. Run: `bun scripts/mock-module-guard.ts` (exit 1 on
 * findings).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type MockModuleFinding = {
  path: string
  line: number
  message: string
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

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Returns the source text of each `mock.module(...)` call (balanced parens),
 * so references inside the factory can be checked.
 */
function mockModuleCalls(
  content: string,
): Array<{ specifier: string; body: string }> {
  const calls: Array<{ specifier: string; body: string }> = []
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
    calls.push({ specifier: match[2]!, body: content.slice(open, end) })
  }
  return calls
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Analyze one test file's source. `path` is only used for reporting. */
export function analyzeTestFile(
  path: string,
  content: string,
): MockModuleFinding[] {
  const calls = mockModuleCalls(content)
  if (calls.length === 0) return []

  const findings: MockModuleFinding[] = []
  const bindings: Array<{ name: string; specifier: string; index: number }> =
    []
  for (const m of content.matchAll(LIVE_DYNAMIC_IMPORT_REGEX)) {
    bindings.push({ name: m[1]!, specifier: m[3]!, index: m.index ?? 0 })
  }
  for (const m of content.matchAll(STATIC_NAMESPACE_IMPORT_REGEX)) {
    bindings.push({ name: m[1]!, specifier: m[3]!, index: m.index ?? 0 })
  }
  for (const r of content.matchAll(CREATE_REQUIRE_BINDING_REGEX)) {
    const requireFn = escapeRegex(r[1]!)
    const requireCall = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${requireFn}\\(\\s*(['"\`])([^'"\`]+)\\2\\s*\\)`,
      'g',
    )
    for (const m of content.matchAll(requireCall)) {
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

  return findings.sort((a, b) => a.line - b.line)
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
  return findings.sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
  )
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
