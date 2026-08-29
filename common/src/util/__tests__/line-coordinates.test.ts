import { describe, expect, test } from 'bun:test'

import { getContentHash } from '../content-hash'
import {
  describeLineBounds,
  describeReanchorFailure,
  getLineCoordinates,
  getRangeSlice,
  isWholeFileCoveringRange,
  reanchorCapabilityRange,
  resolveLineRange,
} from '../line-coordinates'

describe('getLineCoordinates', () => {
  test('collapses empty content to zero visible lines with one bindable line', () => {
    const coordinates = getLineCoordinates('')
    expect(coordinates).toMatchObject({
      normalized: '',
      lines: [''],
      visibleLineCount: 0,
      maxCapabilityLine: 1,
    })
  })

  test('reports one extra bindable line for content ending in a newline', () => {
    const coordinates = getLineCoordinates('a\nb\n')
    expect(coordinates.lines).toEqual(['a', 'b', ''])
    expect(coordinates.visibleLineCount).toBe(2)
    expect(coordinates.maxCapabilityLine).toBe(3)
  })

  test('collapses both ceilings for content without a trailing newline', () => {
    const coordinates = getLineCoordinates('a\nb')
    expect(coordinates.lines).toEqual(['a', 'b'])
    expect(coordinates.visibleLineCount).toBe(2)
    expect(coordinates.maxCapabilityLine).toBe(2)
  })

  test('normalizes CRLF before counting lines', () => {
    const coordinates = getLineCoordinates('a\r\nb\r\n')
    expect(coordinates.normalized).toBe('a\nb\n')
    expect(coordinates.lines).toEqual(['a', 'b', ''])
    expect(coordinates.visibleLineCount).toBe(2)
    expect(coordinates.maxCapabilityLine).toBe(3)
  })
})

describe('resolveLineRange', () => {
  const coordinates = getLineCoordinates('a\nb\n')

  test('accepts an endLine equal to maxCapabilityLine without clamping', () => {
    expect(resolveLineRange({ coordinates, startLine: 1, endLine: 3 })).toEqual(
      { ok: true, startLine: 1, endLine: 3 },
    )
  })

  test('clamps an endLine above maxCapabilityLine and reports the request', () => {
    expect(resolveLineRange({ coordinates, startLine: 2, endLine: 9 })).toEqual(
      {
        ok: true,
        startLine: 2,
        endLine: 3,
        clampedFrom: { startLine: 2, endLine: 9 },
      },
    )
  })

  test('rejects an inverted range', () => {
    expect(resolveLineRange({ coordinates, startLine: 3, endLine: 2 })).toEqual(
      {
        ok: false,
        reason: 'inverted',
        visibleLineCount: 2,
        maxCapabilityLine: 3,
      },
    )
  })

  test('rejects a startLine past the capability ceiling', () => {
    expect(resolveLineRange({ coordinates, startLine: 4, endLine: 4 })).toEqual(
      {
        ok: false,
        reason: 'start_beyond_file',
        visibleLineCount: 2,
        maxCapabilityLine: 3,
      },
    )
  })
})

describe('getRangeSlice', () => {
  test('returns the visible slice a full-file range read hashes', () => {
    expect(getRangeSlice(getLineCoordinates('a\nb\n'), 1, 2)).toBe('a\nb')
  })

  test('includes the trailing empty entry for a capability-space range', () => {
    expect(getRangeSlice(getLineCoordinates('a\nb\n'), 1, 3)).toBe('a\nb\n')
  })

  test('returns a sub-range without a trailing newline', () => {
    expect(getRangeSlice(getLineCoordinates('a\nb\nc'), 2, 3)).toBe('b\nc')
  })

  test('returns an empty slice for empty content', () => {
    expect(getRangeSlice(getLineCoordinates(''), 1, 1)).toBe('')
  })
})

describe('reanchorCapabilityRange', () => {
  test('reports the unchanged location without a delta', () => {
    const coordinates = getLineCoordinates('a\nb\nc\n')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 2,
        expectedHash: getContentHash('a\nb'),
      }),
    ).toEqual({ ok: true, startLine: 1, endLine: 2 })
  })

  test('shifts down after an insertion above the span', () => {
    const coordinates = getLineCoordinates('x\na\nb\nc\n')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 2,
        expectedHash: getContentHash('a\nb'),
      }),
    ).toEqual({ ok: true, startLine: 2, endLine: 3, shiftedBy: 1 })
  })

  test('shifts up after a deletion above the span', () => {
    const coordinates = getLineCoordinates('a\nb\nc\n')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 3,
        endLine: 4,
        expectedHash: getContentHash('b\nc'),
      }),
    ).toEqual({ ok: true, startLine: 2, endLine: 3, shiftedBy: -1 })
  })

  test('fails closed when the observed content is gone', () => {
    const coordinates = getLineCoordinates('a\nb\nc\n')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 2,
        expectedHash: getContentHash('a\nZ'),
      }),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  test('fails closed when a window longer than the file cannot fit', () => {
    const coordinates = getLineCoordinates('a\nb')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 5,
        expectedHash: getContentHash('a\nb\nc\nd\ne'),
      }),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  test('fails closed on two identical candidate spans', () => {
    const coordinates = getLineCoordinates('x\na\nb\na\nb\n')
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 2,
        expectedHash: getContentHash('a\nb'),
      }),
    ).toEqual({ ok: false, reason: 'ambiguous', matchCount: 2 })
  })

  test('refuses a scan whose line product exceeds the budget', () => {
    const coordinates = getLineCoordinates('x\n'.repeat(3000))
    // 3001 lines x a 700-line window is above MAX_REANCHOR_SCAN_LINE_PRODUCT,
    // so the scan is refused rather than partially run.
    expect(
      reanchorCapabilityRange({
        coordinates,
        startLine: 1,
        endLine: 700,
        expectedHash: getContentHash('something else'),
      }),
    ).toEqual({ ok: false, reason: 'over_budget' })
  })
})

describe('describeReanchorFailure', () => {
  test('names each distinguishing cause', () => {
    expect(describeReanchorFailure({ ok: false, reason: 'not_found' })).toBe(
      'the observed content was not found anywhere in the file',
    )
    expect(
      describeReanchorFailure({
        ok: false,
        reason: 'ambiguous',
        matchCount: 3,
      }),
    ).toBe(
      'the observed content now appears at 3 identical candidate spans, so the target is ambiguous',
    )
    expect(describeReanchorFailure({ ok: false, reason: 'over_budget' })).toBe(
      'the file is too large to search for the observed content',
    )
  })
})

describe('isWholeFileCoveringRange', () => {
  test('accepts both the visible and capability ceilings for a newline-terminated file', () => {
    const coordinates = getLineCoordinates('a\nb\n')
    expect(isWholeFileCoveringRange(coordinates, 1, 2)).toBe(true)
    expect(isWholeFileCoveringRange(coordinates, 1, 3)).toBe(true)
  })

  test('rejects a proper subset', () => {
    const coordinates = getLineCoordinates('a\nb\n')
    expect(isWholeFileCoveringRange(coordinates, 1, 1)).toBe(false)
    expect(isWholeFileCoveringRange(coordinates, 2, 3)).toBe(false)
  })

  test('accepts the single collapsed ceiling without a trailing newline', () => {
    const coordinates = getLineCoordinates('a\nb')
    expect(isWholeFileCoveringRange(coordinates, 1, 2)).toBe(true)
    expect(isWholeFileCoveringRange(coordinates, 1, 3)).toBe(false)
  })

  test('treats an empty file read as 1-1 as whole-file covering', () => {
    expect(isWholeFileCoveringRange(getLineCoordinates(''), 1, 1)).toBe(true)
  })
})

describe('describeLineBounds', () => {
  test('names both ceilings when content ends in a newline', () => {
    expect(describeLineBounds(getLineCoordinates('a\nb\n'))).toBe(
      'the file has 2 visible line(s); a read capability may bind up to line 3 (the trailing entry a read reports past the final newline)',
    )
  })

  test('collapses to one ceiling when the counts are equal', () => {
    expect(describeLineBounds(getLineCoordinates('a\nb'))).toBe(
      'the file has 2 visible line(s)',
    )
  })
})
