import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS,
  DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS,
  MODEL_CONTEXT_MAX_RESERVED_FRACTION,
  MODEL_CONTEXT_MAX_RESERVED_TOKENS,
  MODEL_CONTEXT_MIN_RESERVED_TOKENS,
  MODEL_CONTEXT_RESERVED_FRACTION,
  SEMANTIC_COMPACTION_HEADROOM_FRACTION,
  SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS,
  SEMANTIC_COMPACTION_MAX_TARGET_TOKENS,
  SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS,
  SEMANTIC_COMPACTION_MIN_TARGET_TOKENS,
  SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS,
  SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS,
  SEMANTIC_COMPACTION_TARGET_FRACTION,
  SEMANTIC_COMPACTION_TRIGGER_FRACTION,
} from '@codebuff/agent-runtime/util/context-pruning'

import {
  CLOSE_MARKER,
  OPEN_MARKER,
  extractRegion,
  generateBlock,
  normalizeTrailingWhitespace,
  readCanonicalSource,
} from '../../scripts/generate-pruner-budgets'

// The test file lives at agents/__tests__/, so ../../ reaches the repo root.
const repoRoot = new URL('../../', import.meta.url).pathname

/**
 * Extract the marker region using the generator's canonical helper so the
 * freshness gate's extraction semantics stay byte-identical with the
 * generator's --check path. The canonical extractRegion returns null when a
 * marker is missing; fail fast with a clear message in that case.
 */
function requireRegion(source: string): string {
  const region = extractRegion(source)
  if (region === null) {
    throw new Error(
      `pruner-budgets markers not found in context-pruner.ts (expected ${OPEN_MARKER} ... ${CLOSE_MARKER})`,
    )
  }
  return region
}

function prunerSource(): string {
  return readFileSync(new URL('../context-pruner.ts', import.meta.url), 'utf8')
}

/**
 * Read a `const <name> = <number>` declaration out of the generated region.
 * Fails when the constant is absent so a dropped mirror is caught explicitly.
 */
function regionConstant(region: string, name: string): number {
  const pattern = new RegExp(
    `\\bconst\\s+${name}\\s*=\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`,
  )
  const match = region.match(pattern)
  if (!match) {
    throw new Error(`Unable to find ${name} in the generated pruner region`)
  }
  return Number(match[1].replaceAll('_', ''))
}

// RF-3 structural sync guard (replaces the previous value-drift check): the
// budget constants used inside `agents/context-pruner.ts`'s serialized
// `handleSteps` are GENERATED from
// `packages/agent-runtime/src/util/context-pruning.ts` by
// `scripts/generate-pruner-budgets.ts`. handleSteps is reconstructed via
// `new Function(...)` and cannot import the canonical module, so codegen — not a
// hand-copied literal block — is the single source of truth. A one-sided edit on
// either side now fails as a STALE REGION, which is stronger than comparing
// numbers: renames, dropped constants, and edits inside the region are all
// caught.
describe('pruner-budgets freshness', () => {
  test('generated region matches context-pruner.ts inline block', () => {
    const generated = generateBlock(readCanonicalSource(repoRoot))

    const region = requireRegion(prunerSource())

    if (
      normalizeTrailingWhitespace(region) !==
      normalizeTrailingWhitespace(generated)
    ) {
      throw new Error(
        'pruner-budgets region in context-pruner.ts is stale — run: bun run scripts/generate-pruner-budgets.ts --write agents/context-pruner.ts',
      )
    }

    // The region is spliced into a generator body, so it must stay free of
    // module-level syntax that `new Function(...)` cannot evaluate. Match on
    // statement starts only — prose like "cannot import the canonical module"
    // inside the generated header comment is not module syntax.
    const statements = region
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('//'))
    for (const statement of statements) {
      expect(statement.startsWith('export ')).toBe(false)
      expect(statement.startsWith('import ')).toBe(false)
    }
  })

  test('every generated literal equals the canonical agent-runtime constant', () => {
    const region = requireRegion(prunerSource())
    const expected: Array<[string, number]> = [
      ['DEFAULT_MAX_CONTEXT_LENGTH', DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS],
      [
        'DEFAULT_TARGET_CONTEXT_LENGTH',
        DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS,
      ],
      ['SEMANTIC_TRIGGER_FRACTION', SEMANTIC_COMPACTION_TRIGGER_FRACTION],
      ['SEMANTIC_TARGET_FRACTION', SEMANTIC_COMPACTION_TARGET_FRACTION],
      ['SEMANTIC_HEADROOM_FRACTION', SEMANTIC_COMPACTION_HEADROOM_FRACTION],
      ['SEMANTIC_MIN_HEADROOM_TOKENS', SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS],
      ['SEMANTIC_MAX_HEADROOM_TOKENS', SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS],
      ['SEMANTIC_MIN_TARGET_TOKENS', SEMANTIC_COMPACTION_MIN_TARGET_TOKENS],
      ['SEMANTIC_MAX_TARGET_TOKENS', SEMANTIC_COMPACTION_MAX_TARGET_TOKENS],
      [
        'SEMANTIC_SMALL_WINDOW_THRESHOLD_TOKENS',
        SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS,
      ],
      [
        'SEMANTIC_SMALL_WINDOW_MIN_HEADROOM_TOKENS',
        SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS,
      ],
      ['MODEL_CONTEXT_MIN_RESERVED_TOKENS', MODEL_CONTEXT_MIN_RESERVED_TOKENS],
      ['MODEL_CONTEXT_MAX_RESERVED_TOKENS', MODEL_CONTEXT_MAX_RESERVED_TOKENS],
      ['MODEL_CONTEXT_RESERVED_FRACTION', MODEL_CONTEXT_RESERVED_FRACTION],
      [
        'MODEL_CONTEXT_MAX_RESERVED_FRACTION',
        MODEL_CONTEXT_MAX_RESERVED_FRACTION,
      ],
    ]

    for (const [prunerName, canonicalValue] of expected) {
      expect(
        regionConstant(region, prunerName),
        `budget drift: ${prunerName} does not match its canonical constant`,
      ).toBe(canonicalValue)
    }
  })

  test('pruner-local EXPLICIT_LIMIT_TARGET_FRACTION stays outside the generated region', () => {
    const source = prunerSource()
    const region = requireRegion(source)
    // It has no canonical counterpart, so the generator must not own it —
    // otherwise regeneration would silently delete it.
    expect(region).not.toContain('EXPLICIT_LIMIT_TARGET_FRACTION')
    expect(source).toContain('const EXPLICIT_LIMIT_TARGET_FRACTION = 0.6')
  })
})
