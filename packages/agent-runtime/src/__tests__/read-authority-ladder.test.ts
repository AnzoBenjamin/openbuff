import { describe, expect, it } from 'bun:test'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import { classifyReadBlockAuthority } from '../tools/handlers/tool/read-authority-ladder'

import type { ReadBlockCoverage } from '../tools/handlers/tool/read-authority-ladder'

const sourceContent = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')
const document = captureTextDocument(sourceContent)

// The caller authenticates this exact whole-byte basis before asking the pure
// coverage classifier whether the observed block grants whole-file authority.
function wholeFileCoverage(
  overrides: Partial<ReadBlockCoverage> = {},
): ReadBlockCoverage {
  return {
    complete: true,
    startLine: 1,
    endLine: 7,
    totalLines: 7,
    sourceContent,
    rawBasis: getRawReadBasis(document, 1, 7, 'whole'),
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
        rawBasis: getRawReadBasis(document, 4, 6, 'lines'),
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
        rawBasis: getRawReadBasis(document, 2, 7, 'lines'),
      }),
    ).toBe('scoped')
  })

  it('fails closed to none for an incomplete block even when it covers 1..totalLines', () => {
    // Incompleteness is checked first: full coverage cannot rescue a truncated
    // block.
    expect(
      classifyReadBlockAuthority(wholeFileCoverage({ complete: false })),
    ).toBe('none')
  })

  it('fails closed to none when sourceContent is undefined even for full coverage', () => {
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ sourceContent: undefined }),
      ),
    ).toBe('none')
  })

  it('fails closed to none when the block is not capability eligible', () => {
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ capabilityEligible: false }),
      ),
    ).toBe('none')
  })

  it('treats capabilityEligible true and undefined identically', () => {
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ capabilityEligible: true }),
      ),
    ).toBe('whole_file')
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({ capabilityEligible: undefined }),
      ),
    ).toBe('whole_file')
  })

  it('keeps an empty scoped read distinct from an explicit whole empty-file read', () => {
    const emptyDocument = captureTextDocument('')
    const authority = classifyReadBlockAuthority({
      complete: true,
      startLine: 1,
      endLine: 1,
      totalLines: 0,
      sourceContent: '',
      rawBasis: getRawReadBasis(emptyDocument, 1, 1, 'lines'),
    })

    expect(authority).not.toBe('whole_file')
    expect(authority).toBe('scoped')
    expect(
      classifyReadBlockAuthority({
        complete: true,
        startLine: 1,
        endLine: 1,
        totalLines: 0,
        sourceContent: '',
        rawBasis: getRawReadBasis(emptyDocument, 1, 1, 'whole'),
      }),
    ).toBe('whole_file')
  })

  it('keeps all-visible-line scoped authority scoped', () => {
    expect(
      classifyReadBlockAuthority(
        wholeFileCoverage({
          rawBasis: getRawReadBasis(document, 1, 7, 'lines'),
        }),
      ),
    ).toBe('scoped')
  })

  it('grants no authority without the authenticated raw basis', () => {
    expect(
      classifyReadBlockAuthority(wholeFileCoverage({ rawBasis: undefined })),
    ).toBe('none')
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
