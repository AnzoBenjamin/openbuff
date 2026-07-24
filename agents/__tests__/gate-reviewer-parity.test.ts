import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { isTestCoverageReviewerFinding } from '../base2/gate-reviewer'

// Parity: inline base2 mirror must match the gate-reviewer export used for
// exclusive all-coverage → test-writer routing.
type GateReviewerHelpers = {
  isTestCoverageReviewerFinding: (text: string) => boolean
}

type GateReviewerFunctionName = keyof GateReviewerHelpers
type InlineHelperFactory = () => GateReviewerHelpers

const INLINE_HELPER_NAMES: GateReviewerFunctionName[] = [
  'isTestCoverageReviewerFinding',
]

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  const bodyStart = source.indexOf('{', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      return source.slice(declarationStart, index + 1)
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

function loadInlineGateReviewerHelpers(): GateReviewerHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = INLINE_HELPER_NAMES.map((functionName) =>
    extractInlineFunctionSource(base2JavaScript, functionName),
  ).join('\n\n')
  const buildHelpers = new Function(
    `"use strict";\n${helperSource}\nreturn { isTestCoverageReviewerFinding }`,
  ) as InlineHelperFactory

  return buildHelpers()
}

describe('gate-reviewer helpers — inline copies match canonical exports', () => {
  test('isTestCoverageReviewerFinding parity across representative inputs', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()

    const inputs: unknown[] = [
      // coverage-only findings (expect true)
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      'test coverage is insufficient',
      'TEST COVERAGE missing',
      'BLOCKING: coverage gap: add a case to src/foo.test.ts for the new behavior',
      'coverage missing; extend widget.test.tsx',
      // generic test/coverage mentions that keep the repair-editor path (false)
      'BLOCKING: add tests for the parser',
      'BLOCKING: this path is not tested',
      'BLOCKING: coverage of edge cases is unclear',
      'BLOCKING: update foo.test.ts to match the new API',
      'BLOCKING: fix the null dereference in parse()',
      '',
      '   ',
      // non-string inputs (false)
      undefined,
      null,
      42,
      {},
      ['test coverage'],
    ]

    for (const input of inputs) {
      expect(
        inlineHelpers.isTestCoverageReviewerFinding(input as string),
      ).toBe(isTestCoverageReviewerFinding(input as string))
    }
  })
})

// Direct behavioral coverage for the canonical gate-reviewer.ts export (as
// opposed to the parity suite above, which only asserts the inline base2 copy
// matches the export). These assertions also keep the export consumed so it
// is not dead code.
describe('gate-reviewer helpers — canonical export behavior', () => {
  test('isTestCoverageReviewerFinding keys on the test-coverage bigram or coverage plus a .test.* token', () => {
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      ),
    ).toBe(true)
    expect(isTestCoverageReviewerFinding('TEST COVERAGE missing')).toBe(true)
    expect(
      isTestCoverageReviewerFinding('coverage missing; extend widget.test.tsx'),
    ).toBe(true)
  })

  test('isTestCoverageReviewerFinding stays conservative for generic test/coverage mentions', () => {
    expect(
      isTestCoverageReviewerFinding('BLOCKING: add tests for the parser'),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: coverage of edge cases is unclear',
      ),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: update foo.test.ts to match the new API',
      ),
    ).toBe(false)
    expect(isTestCoverageReviewerFinding('')).toBe(false)
  })

  test('isTestCoverageReviewerFinding rejects non-string inputs', () => {
    expect(
      isTestCoverageReviewerFinding(undefined as unknown as string),
    ).toBe(false)
    expect(isTestCoverageReviewerFinding(null as unknown as string)).toBe(
      false,
    )
    expect(isTestCoverageReviewerFinding(42 as unknown as string)).toBe(false)
  })
})
