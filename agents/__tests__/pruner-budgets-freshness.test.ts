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
  BUDGET_CANONICAL_NAMES,
  CLOSE_MARKER,
  OPEN_MARKER,
  deriveBudgetMirrors,
  derivePrunerLocalName,
  extractRegion,
  generateBlock,
  normalizeTrailingWhitespace,
  readCanonicalSource,
  regionIsFresh,
  spliceRegion,
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
      [
        'DEFAULT_MAX_CONTEXT_LENGTH',
        DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS,
      ],
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

describe('pruner-budgets derivation & splice', () => {
  test('spliceRegion replaces the marker region byte-preservingly', () => {
    const prefix = 'line-before\n'
    const suffix = '\nline-after'
    const block = '    const FRESH_ONE = 1\n    const FRESH_TWO = 2'
    const text =
      prefix + `${OPEN_MARKER}\nstale content\n${CLOSE_MARKER}` + suffix

    const spliced = spliceRegion(text, block)

    // Prefix and suffix bytes are preserved exactly; the region (markers and
    // in-region content) is replaced verbatim by `block`.
    expect(spliced).toBe(prefix + block + suffix)
    expect(spliced.startsWith(prefix)).toBe(true)
    expect(spliced.endsWith(suffix)).toBe(true)
    expect(spliced).not.toContain(OPEN_MARKER)
    expect(spliced).not.toContain(CLOSE_MARKER)
    expect(spliced).not.toContain('stale content')
  })

  test('spliceRegion throws when a marker is absent', () => {
    expect(() => spliceRegion('no markers here', 'block')).toThrow(
      /open marker not found/,
    )
    const onlyOpen = `${OPEN_MARKER}\ncontent`
    expect(() => spliceRegion(onlyOpen, 'block')).toThrow(
      /close marker not found/,
    )
  })

  test('regionIsFresh reflects region staleness and marker presence', () => {
    const template = `prefix-line\n${OPEN_MARKER}\nOLD\n${CLOSE_MARKER}\nsuffix-line`
    const freshBlock = `${OPEN_MARKER}\n    const FRESH = 1\n${CLOSE_MARKER}`

    const freshText = spliceRegion(template, freshBlock)
    expect(regionIsFresh(freshText, freshBlock)).toBe(true)

    const staleText = spliceRegion(
      template,
      `${OPEN_MARKER}\nchanged\n${CLOSE_MARKER}`,
    )
    expect(regionIsFresh(staleText, freshBlock)).toBe(false)

    expect(regionIsFresh('no markers at all', freshBlock)).toBe(false)
  })

  test('deriveBudgetMirrors throws when a canonical constant is missing', () => {
    const literals = new Map<string, string>(
      BUDGET_CANONICAL_NAMES.map((name) => [name, '1']),
    )
    literals.delete('SEMANTIC_COMPACTION_TRIGGER_FRACTION')
    expect(() => deriveBudgetMirrors(literals)).toThrow(
      /SEMANTIC_COMPACTION_TRIGGER_FRACTION/,
    )
  })

  test('deriveBudgetMirrors throws on an unexpected budget-pattern name', () => {
    const literals = new Map<string, string>(
      BUDGET_CANONICAL_NAMES.map((name) => [name, '1']),
    )
    literals.set('SEMANTIC_COMPACTION_NEW_FACTOR', '0.5')
    expect(() => deriveBudgetMirrors(literals)).toThrow(
      /SEMANTIC_COMPACTION_NEW_FACTOR/,
    )
  })

  test('derivePrunerLocalName maps canonical names to pruner-local names', () => {
    expect(derivePrunerLocalName('MODEL_CONTEXT_MIN_RESERVED_TOKENS')).toBe(
      'MODEL_CONTEXT_MIN_RESERVED_TOKENS',
    )
    expect(derivePrunerLocalName('SEMANTIC_COMPACTION_TARGET_FRACTION')).toBe(
      'SEMANTIC_TARGET_FRACTION',
    )
    expect(
      derivePrunerLocalName('DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS'),
    ).toBe('DEFAULT_TARGET_CONTEXT_LENGTH')
    expect(() => derivePrunerLocalName('UNRELATED_CONSTANT')).toThrow(
      /UNRELATED_CONSTANT/,
    )
  })

  test('deriveBudgetMirrors returns all canonical pairs in emit order', () => {
    const literals = new Map<string, string>(
      BUDGET_CANONICAL_NAMES.map((name) => [name, '1']),
    )
    const mirrors = deriveBudgetMirrors(literals)
    expect(mirrors).toHaveLength(15)
    // MODEL_CONTEXT pairs keep their canonical name as the pruner-local name.
    expect(
      mirrors.find(
        ([canonical]) => canonical === 'MODEL_CONTEXT_MAX_RESERVED_TOKENS',
      ),
    ).toEqual([
      'MODEL_CONTEXT_MAX_RESERVED_TOKENS',
      'MODEL_CONTEXT_MAX_RESERVED_TOKENS',
    ])
    // SEMANTIC_COMPACTION strips the COMPACTION_ prefix.
    expect(
      mirrors.find(
        ([canonical]) => canonical === 'SEMANTIC_COMPACTION_TRIGGER_FRACTION',
      ),
    ).toEqual([
      'SEMANTIC_COMPACTION_TRIGGER_FRACTION',
      'SEMANTIC_TRIGGER_FRACTION',
    ])
    // DEFAULT_TRIGGER maps to DEFAULT_MAX_CONTEXT_LENGTH.
    expect(
      mirrors.find(
        ([canonical]) =>
          canonical === 'DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS',
      ),
    ).toEqual([
      'DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS',
      'DEFAULT_MAX_CONTEXT_LENGTH',
    ])
  })
})
