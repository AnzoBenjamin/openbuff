import { describe, expect, it } from 'bun:test'

import { classifyReadBlockAuthority } from '../tools/handlers/tool/read-authority-ladder'

import type { ReadBlockCoverage } from '../tools/handlers/tool/read-authority-ladder'

// A complete, capability-eligible read of every line of a 7-line file with
// real undecorated source text: the only shape that may authorize a whole-file
// overwrite. Each test below flips exactly one field off this baseline.
function wholeFileCoverage(
  overrides: Partial<ReadBlockCoverage> = {},
): ReadBlockCoverage {
  return {
    complete: true,
    startLine: 1,
    endLine: 7,
    totalLines: 7,
    sourceContent: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n'),
    ...overrides,
  }
}

describe('classifyReadBlockAuthority', () => {
  it('classifies a complete 1..totalLines read with real sourceContent as whole_file', () => {
    expect(classifyReadBlockAuthority(wholeFileCoverage())).toBe('whole_file')
  })

  it('classifies a proper sub-range as scoped', () => {
    expect(
      classifyReadBlockAuthority({
        complete: true,
        startLine: 4,
        endLine: 6,
        totalLines: 7,
        sourceContent: 'l4\nl5\nl6',
      }),
    ).toBe('scoped')
  })

  it('classifies a partial tail that reaches the last line as scoped', () => {
    expect(
      classifyReadBlockAuthority({
        complete: true,
        startLine: 2,
        endLine: 7,
        totalLines: 7,
        sourceContent: 'l2\nl3\nl4\nl5\nl6\nl7',
      }),
    ).toBe('scoped')
  })

  it('fails closed to none for an incomplete block even when it covers 1..totalLines', () => {
    // Incompleteness is checked first: full coverage cannot rescue a truncated
    // block.
    expect(classifyReadBlockAuthority(wholeFileCoverage({ complete: false }))).toBe(
      'none',
    )
  })

  it('fails closed to none when sourceContent is undefined even for full coverage', () => {
    expect(
      classifyReadBlockAuthority(wholeFileCoverage({ sourceContent: undefined })),
    ).toBe('none')
  })

  it('fails closed to none when the block is not capability eligible', () => {
    expect(
      classifyReadBlockAuthority(wholeFileCoverage({ capabilityEligible: false })),
    ).toBe('none')
  })

  it('treats capabilityEligible true and undefined identically', () => {
    expect(
      classifyReadBlockAuthority(wholeFileCoverage({ capabilityEligible: true })),
    ).toBe('whole_file')
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ capabilityEligible: undefined }),
      ),
    ).toBe('whole_file')
  })

  it('does not classify an empty file (totalLines 0) as whole_file', () => {
    const authority = classifyReadBlockAuthority({
      complete: true,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      sourceContent: '',
    })

    expect(authority).not.toBe('whole_file')
    expect(authority).toBe('scoped')
  })

  it('fails closed to none for an incomplete read regardless of eligibility or content', () => {
    // Ordering: !complete wins over both the eligibility and sourceContent
    // checks, so no combination of the later fields can upgrade the verdict.
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ complete: false, capabilityEligible: true }),
      ),
    ).toBe('none')
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ complete: false, sourceContent: undefined }),
      ),
    ).toBe('none')
  })
})
