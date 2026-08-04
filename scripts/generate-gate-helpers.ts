#!/usr/bin/env bun
/**
 * Deterministic code generator for the reviewer-gate helper functions.
 *
 * The helpers in `agents/base2/gate-paths.ts`, `agents/base2/gate-reviewer.ts`,
 * `agents/base2/gate-repair.ts`, `agents/base2/gate-concurrency.ts`, and
 * `agents/base2/gate-fingerprint.ts` are duplicated inline inside the
 * `createBase2` `handleSteps` generator (because that generator is serialized
 * via `handleSteps.toString()` and reconstructed with `new Function(...)`,
 * which loses the module closure). This script is the single source of truth
 * for that inline region: it reads the five canonical modules, parses them with
 * the TypeScript compiler API, and emits a consolidated block of nested
 * function/type declarations (no `export`, no `import`) suitable for splicing
 * verbatim into the middle of the `handleSteps` generator body.
 *
 * Modes:
 *   (no args)        print the wrapped block to stdout
 *   --check <path>   compare the marker region in <path> to the fresh block
 *   --write <path>   replace the marker region in <path> with the fresh block
 *
 * Output is deterministic (stable ordering, no timestamps) so `--check` can
 * compare bytes.
 *
 *   bun run scripts/generate-gate-helpers.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import ts from 'typescript'

const OPEN_MARKER =
  '// <gate-helpers-generated> DO NOT EDIT — regenerate via: bun run scripts/generate-gate-helpers.ts'
const CLOSE_MARKER = '// </gate-helpers-generated>'

// Emitted in this order; within each module source order is preserved.
const SOURCE_MODULES = [
  'gate-paths.ts',
  'gate-reviewer.ts',
  'gate-repair.ts',
  'gate-concurrency.ts',
  'gate-fingerprint.ts',
]

type DeclarationWithModifiers =
  | ts.FunctionDeclaration
  | ts.TypeAliasDeclaration
  | ts.InterfaceDeclaration

/**
 * Return a copy of `node` with any `export` (and `default`) modifier removed at
 * the AST level. Working at the modifier level — rather than a
 * `text.replace(/^export /, '')` on the printed text — means the keyword is
 * stripped even when the declaration is preceded by a leading comment or JSDoc
 * block. The updated node keeps its original source position, so the printer
 * still emits those leading comments, and all type annotations are preserved.
 */
function stripExportModifier(
  node: DeclarationWithModifiers,
): DeclarationWithModifiers {
  const modifiers = ts.getModifiers(node)
  if (
    !modifiers ||
    !modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword,
    )
  ) {
    return node
  }
  const kept = modifiers.filter(
    (modifier) =>
      modifier.kind !== ts.SyntaxKind.ExportKeyword &&
      modifier.kind !== ts.SyntaxKind.DefaultKeyword,
  )
  if (ts.isFunctionDeclaration(node)) {
    return ts.factory.updateFunctionDeclaration(
      node,
      kept,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      node.body,
    )
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return ts.factory.updateTypeAliasDeclaration(
      node,
      kept,
      node.name,
      node.typeParameters,
      node.type,
    )
  }
  return ts.factory.updateInterfaceDeclaration(
    node,
    kept,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    node.members,
  )
}

/**
 * Collect and transform the top-level function/type/interface declarations from
 * the canonical gate modules and wrap them between the marker lines.
 */
function generateBlock(): string {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const parts: string[] = []

  for (const moduleName of SOURCE_MODULES) {
    const filePath = path.join(
      import.meta.dir,
      '..',
      'agents',
      'base2',
      moduleName,
    )
    const text = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
    )

    for (const statement of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)
      ) {
        // Drop the `export` modifier at the AST level (see stripExportModifier)
        // so it is removed even when the declaration is preceded by a leading
        // comment / JSDoc block. Type annotations are kept so the spliced
        // region typechecks under base2.ts's strict mode. Imports are never
        // emitted; imported types stay as bare annotations because the region
        // is only ever compiled inside base2.ts (which imports them).
        const printed = printer.printNode(
          ts.EmitHint.Unspecified,
          stripExportModifier(statement),
          sourceFile,
        )
        parts.push(printed)
      }
    }
  }

  const body = parts.join('\n\n')
  return `${OPEN_MARKER}\n${body}\n${CLOSE_MARKER}`
}

/**
 * Extract the substring between the two marker lines (inclusive) from `text`,
 * or null when either marker is missing.
 */
function extractRegion(text: string): string | null {
  const start = text.indexOf(OPEN_MARKER)
  if (start === -1) return null
  const closeStart = text.indexOf(CLOSE_MARKER, start)
  if (closeStart === -1) return null
  return text.slice(start, closeStart + CLOSE_MARKER.length)
}

/** Trim trailing whitespace on each line so the comparison ignores it. */
function normalizeTrailingWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}

/** Print a compact line-level summary of the first differences. */
function summarizeDiff(current: string, fresh: string): void {
  const currentLines = current.split('\n')
  const freshLines = fresh.split('\n')
  console.log(
    `gate-helpers region differs: current ${currentLines.length} line(s), generated ${freshLines.length} line(s)`,
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
  if (region === null) {
    console.error(
      `gate-helpers markers not found in ${targetPath} (expected ${OPEN_MARKER} ... ${CLOSE_MARKER})`,
    )
    process.exit(1)
  }
  const currentNormalized = normalizeTrailingWhitespace(region)
  const freshNormalized = normalizeTrailingWhitespace(block)
  if (currentNormalized === freshNormalized) {
    console.log('gate-helpers region is fresh')
    return
  }
  summarizeDiff(currentNormalized, freshNormalized)
  console.log(
    `gate-helpers region is STALE — run: bun run scripts/generate-gate-helpers.ts --write ${targetPath}`,
  )
  process.exit(1)
}

function runWrite(targetPath: string, block: string): void {
  const absolute = path.resolve(targetPath)
  const text = fs.readFileSync(absolute, 'utf8')
  const start = text.indexOf(OPEN_MARKER)
  if (start === -1) {
    console.error(
      `gate-helpers open marker not found in ${targetPath}; refusing to guess an insertion point`,
    )
    process.exit(1)
  }
  const closeStart = text.indexOf(CLOSE_MARKER, start)
  if (closeStart === -1) {
    console.error(
      `gate-helpers close marker not found in ${targetPath}; refusing to guess an insertion point`,
    )
    process.exit(1)
  }
  const end = closeStart + CLOSE_MARKER.length
  // Preserve everything outside the markers byte-for-byte.
  const next = text.slice(0, start) + block + text.slice(end)
  fs.writeFileSync(absolute, next)
  console.log(`gate-helpers region written to ${targetPath}`)
}

async function main() {
  const args = process.argv.slice(2)
  const block = generateBlock()

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
    'Usage: generate-gate-helpers.ts [--check <path> | --write <path>]',
  )
  process.exit(1)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
