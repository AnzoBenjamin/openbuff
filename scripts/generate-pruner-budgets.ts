#!/usr/bin/env bun
/**
 * Deterministic code generator for the context-pruner budget constants.
 *
 * `agents/context-pruner.ts` declares its budget constants inline inside the
 * `handleSteps` generator, because that generator is serialized via
 * `handleSteps.toString()` and reconstructed with `new Function(...)`, which
 * loses the module closure (it cannot import
 * `packages/agent-runtime/src/util/context-pruning.ts` at runtime).
 *
 * This script is the single source of truth for that inline region: it parses
 * the canonical module with the TypeScript compiler API, reads the exported
 * numeric constants, and emits an indented block of `const` declarations under
 * the pruner-local names, suitable for splicing verbatim into the marker region
 * inside `handleSteps`. Because the literal text is copied from the canonical
 * AST, the mirror cannot drift: a one-sided edit makes the region stale and the
 * freshness check fails.
 *
 * Modes:
 *   (no args)        print the wrapped block to stdout
 *   --check <path>   compare the marker region in <path> to the fresh block
 *   --write <path>   replace the marker region in <path> with the fresh block
 *
 * Output is deterministic (stable ordering, no timestamps) so `--check` can
 * compare bytes.
 *
 *   bun run scripts/generate-pruner-budgets.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import ts from 'typescript'

export const OPEN_MARKER =
  '// <pruner-budgets-generated> DO NOT EDIT — regenerate via: bun run scripts/generate-pruner-budgets.ts'
export const CLOSE_MARKER = '// </pruner-budgets-generated>'

/** Indentation of the marker region inside the `handleSteps` body. */
const INDENT = '    '

/** Canonical module that owns every mirrored budget literal. */
export const CANONICAL_MODULE =
  'packages/agent-runtime/src/util/context-pruning.ts'

/**
 * Canonical budget exports, in deterministic emit order, that MUST be mirrored
 * into the pruner's generated region. Each is a numeric constant in
 * `packages/agent-runtime/src/util/context-pruning.ts` whose name matches a
 * budget pattern (see `isBudgetPatternName`). Keeping this as the single
 * ordering list means a NEW canonical budget constant is never silently
 * dropped: `deriveBudgetMirrors` asserts that exactly these (no more, no
 * fewer) budget-pattern exports exist in the canonical module, throwing a
 * loud error otherwise.
 */
export const BUDGET_CANONICAL_NAMES: readonly string[] = [
  'DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS',
  'DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS',
  'SEMANTIC_COMPACTION_TRIGGER_FRACTION',
  'SEMANTIC_COMPACTION_TARGET_FRACTION',
  'SEMANTIC_COMPACTION_HEADROOM_FRACTION',
  'SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS',
  'SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS',
  'SEMANTIC_COMPACTION_MIN_TARGET_TOKENS',
  'SEMANTIC_COMPACTION_MAX_TARGET_TOKENS',
  'SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS',
  'SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS',
  'MODEL_CONTEXT_MIN_RESERVED_TOKENS',
  'MODEL_CONTEXT_MAX_RESERVED_TOKENS',
  'MODEL_CONTEXT_RESERVED_FRACTION',
  'MODEL_CONTEXT_MAX_RESERVED_FRACTION',
]

/**
 * A canonical budget constant is any exported numeric constant whose name
 * relates to the semantic-compaction or model-reserve budget. Non-budget
 * exported numeric constants in the module are intentionally not mirrored.
 */
export function isBudgetPatternName(name: string): boolean {
  return (
    name.startsWith('DEFAULT_SEMANTIC_COMPACTION_') ||
    name.startsWith('SEMANTIC_COMPACTION_') ||
    name.startsWith('MODEL_CONTEXT_')
  )
}

/**
 * Deterministically derive the pruner-local name for a canonical budget
 * constant. Fail-loud on an unrecognized budget name so a future irregular
 * name surfaces a clear error instead of silently producing a broken alias.
 *
 * Conventions:
 *   - `MODEL_CONTEXT_*` keeps its name (no change).
 *   - `DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS` -> `DEFAULT_MAX_CONTEXT_LENGTH`.
 *   - `DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS` -> `DEFAULT_TARGET_CONTEXT_LENGTH`.
 *   - `SEMANTIC_COMPACTION_<REST>` -> `SEMANTIC_<REST>` (strip `COMPACTION_`).
 */
export function derivePrunerLocalName(canonicalName: string): string {
  if (canonicalName.startsWith('MODEL_CONTEXT_')) {
    return canonicalName
  }
  if (canonicalName === 'DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS') {
    return 'DEFAULT_MAX_CONTEXT_LENGTH'
  }
  if (canonicalName === 'DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS') {
    return 'DEFAULT_TARGET_CONTEXT_LENGTH'
  }
  if (canonicalName.startsWith('SEMANTIC_COMPACTION_')) {
    return `SEMANTIC_${canonicalName.slice('SEMANTIC_COMPACTION_'.length)}`
  }
  throw new Error(
    `Unable to derive pruner-local name for canonical budget constant ${canonicalName}`,
  )
}

/**
 * Derive the `[canonical, prunerLocal]` mirror pairs in emit order.
 *
 * Exhaustive and fail-loud: asserts that the set of budget-pattern exported
 * numeric constants in the canonical module is EXACTLY `BUDGET_CANONICAL_NAMES`.
 * A newly added budget constant (or a removed/renamed one) therefore throws,
 * telling the developer to update `BUDGET_CANONICAL_NAMES` rather than letting
 * the drift go silently.
 */
export function deriveBudgetMirrors(
  literals: Map<string, string>,
): ReadonlyArray<readonly [string, string]> {
  const observedBudgetNames = Array.from(literals.keys()).filter(
    isBudgetPatternName,
  )
  const observed = new Set(observedBudgetNames)
  const expected = new Set(BUDGET_CANONICAL_NAMES)
  for (const name of observedBudgetNames) {
    if (!expected.has(name)) {
      throw new Error(
        `New mirrored budget constant ${name} found in ${CANONICAL_MODULE} but is not in BUDGET_CANONICAL_NAMES. Add it to BUDGET_CANONICAL_NAMES in scripts/generate-pruner-budgets.ts.`,
      )
    }
  }
  for (const name of BUDGET_CANONICAL_NAMES) {
    if (!observed.has(name)) {
      throw new Error(
        `Expected mirrored budget constant ${name} is missing from ${CANONICAL_MODULE}. It may have been renamed; update BUDGET_CANONICAL_NAMES or the canonical module.`,
      )
    }
  }
  return BUDGET_CANONICAL_NAMES.map(
    (canonicalName) =>
      [canonicalName, derivePrunerLocalName(canonicalName)] as const,
  )
}

export function projectRootFromMeta(metaUrl = import.meta.url): string {
  return path.resolve(path.dirname(new URL(metaUrl).pathname), '..')
}

/**
 * Collect `export const <NAME> = <numeric literal>` declarations from the
 * canonical module, keyed by name with the literal's exact source text as the
 * value. Reading the literal text (rather than the parsed number) keeps digit
 * separators such as `140_000` byte-identical in the generated mirror.
 */
export function readCanonicalLiterals(source: string): Map<string, string> {
  const sourceFile = ts.createSourceFile(
    CANONICAL_MODULE,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const literals = new Map<string, string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const isExported = ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!isExported) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const initializer = declaration.initializer
      if (!initializer || !ts.isNumericLiteral(initializer)) continue
      literals.set(declaration.name.text, initializer.getText(sourceFile))
    }
  }

  return literals
}

/**
 * Build the indented marker block from the canonical literals. Throws when a
 * mirrored constant is missing or is no longer a plain numeric literal, so a
 * rename or refactor in the canonical module fails loudly instead of silently
 * dropping a budget.
 */
export function generateBlock(canonicalSource: string): string {
  const literals = readCanonicalLiterals(canonicalSource)
  const budgetMirrors = deriveBudgetMirrors(literals)
  const lines: string[] = [
    `${INDENT}${OPEN_MARKER}`,
    `${INDENT}// Source of truth: ${CANONICAL_MODULE}`,
    `${INDENT}// handleSteps is serialized (new Function) and cannot import the`,
    `${INDENT}// canonical module, so these literals are generated, not hand-copied.`,
  ]

  for (const [canonicalName, prunerName] of budgetMirrors) {
    const literal = literals.get(canonicalName)
    if (literal === undefined) {
      throw new Error(
        `Unable to find exported numeric constant ${canonicalName} in ${CANONICAL_MODULE}`,
      )
    }
    const suffix = canonicalName === prunerName ? '' : ` // ${canonicalName}`
    lines.push(`${INDENT}const ${prunerName} = ${literal}${suffix}`)
  }

  lines.push(`${INDENT}${CLOSE_MARKER}`)
  return lines.join('\n')
}

export function readCanonicalSource(root: string): string {
  return fs.readFileSync(path.join(root, CANONICAL_MODULE), 'utf8')
}

/**
 * Extract the substring between the two marker lines (inclusive) from `text`,
 * or null when either marker is missing. The leading indentation of the open
 * marker line is included so `--check` compares the block byte-for-byte.
 */
export function extractRegion(text: string): string | null {
  const markerIndex = text.indexOf(OPEN_MARKER)
  if (markerIndex === -1) return null
  const lineStart = text.lastIndexOf('\n', markerIndex) + 1
  const closeIndex = text.indexOf(CLOSE_MARKER, markerIndex)
  if (closeIndex === -1) return null
  // End at the close marker itself (not its line start) so the region's own
  // indentation is not truncated; otherwise --check always reports stale.
  return text.slice(lineStart, closeIndex + CLOSE_MARKER.length)
}

/** Trim trailing whitespace on each line so the comparison ignores it. */
export function normalizeTrailingWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}

/**
 * Whether the marker region in `text` equals `block`, ignoring trailing
 * whitespace. Returns false when either marker is absent (matching runCheck's
 * fail-closed behavior). This is the pure, side-effect-free core of runCheck.
 */
export function regionIsFresh(text: string, block: string): boolean {
  const region = extractRegion(text)
  if (region === null) return false
  return (
    normalizeTrailingWhitespace(region) === normalizeTrailingWhitespace(block)
  )
}

/**
 * Byte-preserving replacement of the marker region: returns `text` with the
 * whole region (open marker line through close marker) replaced by `block`,
 * leaving everything outside the markers unchanged. This is the exact splice
 * runWrite performs inline. Throws when either marker is absent, matching
 * runWrite's fail-closed policy.
 */
export function spliceRegion(text: string, block: string): string {
  const markerIndex = text.indexOf(OPEN_MARKER)
  if (markerIndex === -1) {
    throw new Error(
      'pruner-budgets open marker not found in text; refusing to guess an insertion point',
    )
  }
  const closeIndex = text.indexOf(CLOSE_MARKER, markerIndex)
  if (closeIndex === -1) {
    throw new Error(
      'pruner-budgets close marker not found in text; refusing to guess an insertion point',
    )
  }
  const start = text.lastIndexOf('\n', markerIndex) + 1
  const end = closeIndex + CLOSE_MARKER.length
  return text.slice(0, start) + block + text.slice(end)
}

/** Print a compact line-level summary of the first differences. */
function summarizeDiff(current: string, fresh: string): void {
  const currentLines = current.split('\n')
  const freshLines = fresh.split('\n')
  console.log(
    `pruner-budgets region differs: current ${currentLines.length} line(s), generated ${freshLines.length} line(s)`,
  )
  const max = Math.max(currentLines.length, freshLines.length)
  let shown = 0
  for (let i = 0; i < max && shown < 10; i++) {
    const a = currentLines[i] ?? ''
    const b = freshLines[i] ?? ''
    if (a !== b) {
      console.log(`  - ${a}`)
      console.log(`  + ${b}`)
      shown++
    }
  }
}

function runCheck(targetPath: string, block: string): void {
  const absolute = path.resolve(targetPath)
  const text = fs.readFileSync(absolute, 'utf8')
  const region = extractRegion(text)
  if (regionIsFresh(text, block)) {
    console.log('pruner-budgets region is fresh')
    return
  }
  if (region === null) {
    console.error(
      `pruner-budgets markers not found in ${targetPath} (expected ${OPEN_MARKER} ... ${CLOSE_MARKER})`,
    )
    process.exit(1)
  }
  summarizeDiff(
    normalizeTrailingWhitespace(region),
    normalizeTrailingWhitespace(block),
  )
  console.log(
    `pruner-budgets region is STALE — run: bun run scripts/generate-pruner-budgets.ts --write ${targetPath}`,
  )
  process.exit(1)
}

function runWrite(targetPath: string, block: string): void {
  const absolute = path.resolve(targetPath)
  const text = fs.readFileSync(absolute, 'utf8')
  const markerIndex = text.indexOf(OPEN_MARKER)
  if (markerIndex === -1) {
    console.error(
      `pruner-budgets open marker not found in ${targetPath}; refusing to guess an insertion point`,
    )
    process.exit(1)
  }
  const closeIndex = text.indexOf(CLOSE_MARKER, markerIndex)
  if (closeIndex === -1) {
    console.error(
      `pruner-budgets close marker not found in ${targetPath}; refusing to guess an insertion point`,
    )
    process.exit(1)
  }
  // Preserve everything outside the markers byte-for-byte.
  fs.writeFileSync(absolute, spliceRegion(text, block))
  console.log(`pruner-budgets region written to ${targetPath}`)
}

async function main() {
  const args = process.argv.slice(2)
  const root = projectRootFromMeta()
  const block = generateBlock(readCanonicalSource(root))

  const mode = args[0]
  if (!mode) {
    process.stdout.write(`${block}\n`)
    return
  }

  if (mode === '--check' || mode === '--write') {
    const targetPath = args[1]
    if (!targetPath) {
      console.error(`Error: ${mode} requires a <path> argument`)
      process.exit(1)
    }
    if (mode === '--check') {
      runCheck(targetPath, block)
    } else {
      runWrite(targetPath, block)
    }
    return
  }

  console.error(`Unknown argument: ${mode}`)
  console.error(
    'Usage: generate-pruner-budgets.ts [--check <path> | --write <path>]',
  )
  process.exit(1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
