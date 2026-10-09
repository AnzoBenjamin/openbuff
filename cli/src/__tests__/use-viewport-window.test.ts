import { describe, test, expect } from 'bun:test'

import {
  computeAnchorDelta,
  computeTopSpacer,
  computeWindow,
  createMeasurementCapture,
  estimateMessageHeight,
  isFreshMeasurementNode,
  nextZeroHeightAttempt,
  pruneMeasuredHeights,
  resolveAnchorScrollTop,
  resolveMessageHeight,
  stepViewportLivenessGuard,
  ZERO_HEIGHT_MAX_ATTEMPTS,
  type MeasuredHeight,
  type ViewportLivenessPendingState,
} from '../hooks/use-viewport-window'
import {
  applyProgrammaticScrollTop,
  carryPendingVerifyResidual,
  carrySupersededAnimationResidual,
  classifyAnchorVerifyStepGate,
  classifyAnimationFoldGate,
  classifyAnimationRearmGate,
  classifyScrollChangeMovement,
  clampScrollValue,
  coalesceAnchorVerifyDesired,
  computeAnimationFrameScroll,
  computeAnchorVerifyCorrection,
  computeAnchorVerifyGuard,
  computeAutoScrollTarget,
  computeIsNearBottom,
  computePageScrollTarget,
  completionVerifyDesired,
  easeTargetWithCarriedResidual,
  foldAnimationVerifyDesired,
  readCanonicalScrollPosition,
  SCROLL_NEAR_BOTTOM_THRESHOLD,
  shouldSkipAutoScrollWrite,
  VERIFY_SETTLED_BOTTOM,
} from '../hooks/use-scroll-management'

import type { ChatMessage, ContentBlock, ToolContentBlock } from '../types/chat'
import type { BoxRenderable } from '@opentui/core'

const WIDTH = 80

const makeMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  variant: 'user',
  content: '',
  timestamp: '00:00',
  ...overrides,
})

const textBlock = (content: string): ContentBlock => ({
  type: 'text',
  content,
})

describe('estimateMessageHeight', () => {
  test('user message with short content wraps to a small height', () => {
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: 'hello world' }),
      WIDTH,
    )
    // 2 base rows + 1 content row
    expect(h).toBe(3)
  })

  test('long user content wraps to additional lines', () => {
    const longLine = 'a'.repeat(200) // ~200 wide -> ceil(200/(80-4)) = 3 lines
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: longLine }),
      WIDTH,
    )
    expect(h).toBe(2 + 3)
  })

  test('collapsed agent message has a fixed small height', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'agent',
        content: 'x'.repeat(500),
        metadata: { isCollapsed: true },
      }),
      WIDTH,
    )
    expect(h).toBe(2)
  })

  test('mode-divider single-block message is one row', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'ai',
        blocks: [{ type: 'mode-divider', mode: 'default' }],
      }),
      WIDTH,
    )
    expect(h).toBe(1)
  })

  test('ai message sums block estimates and includes footer base', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'ai',
        blocks: [textBlock('short')],
      }),
      WIDTH,
    )
    // 2 base rows + 1 text line
    expect(h).toBe(3)
  })

  test('ai message with many tool blocks grows the estimate', () => {
    const blocks: ContentBlock[] = Array.from(
      { length: 5 },
      (_, i): ToolContentBlock => ({
        type: 'tool',
        toolCallId: `t${i}`,
        toolName: 'read_file' as ToolContentBlock['toolName'],
        input: {},
      }),
    )
    const h = estimateMessageHeight(
      makeMessage({ variant: 'ai', blocks }),
      WIDTH,
    )
    // 2 base + 5 * 3 tool rows
    expect(h).toBe(2 + 15)
  })

  test('estimate is clamped to a sane minimum', () => {
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: '' }),
      WIDTH,
    )
    expect(h).toBeGreaterThanOrEqual(1)
  })
})

describe('computeWindow', () => {
  // Build 100 messages each 10 rows tall, stacked after a 2-row header.
  const COUNT = 100
  const HEIGHT = 10
  const HEADER = 2
  const heights = Array.from({ length: COUNT }, () => HEIGHT)
  const offsets = Array.from(
    { length: COUNT },
    (_, i) => HEADER + i * HEIGHT,
  )
  const totalHeight = HEADER + COUNT * HEIGHT

  test('windows only the intersecting subset for a mid-scroll viewport', () => {
    const { startIndex, endIndex } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: 500,
      viewportHeight: 100,
      overscanPx: 20,
    })
    // windowStart=480 -> message 47 ([472,482)); windowEnd=620 -> message 61.
    expect(startIndex).toBeGreaterThan(0)
    expect(endIndex).toBeLessThan(COUNT - 1)
    expect(endIndex).toBeGreaterThan(startIndex)
    // Mounted subset is far smaller than the full list.
    expect(endIndex - startIndex + 1).toBeLessThan(COUNT / 2)
  })

  test('at the top the window starts at index 0 with no top spacer', () => {
    const { startIndex, topSpacerHeight } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(startIndex).toBe(0)
    expect(topSpacerHeight).toBe(HEADER)
  })

  test('top and bottom spacers sum with the window to the total height', () => {
    const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } =
      computeWindow({
        offsets,
        heights,
        totalHeight,
        scrollTop: 500,
        viewportHeight: 100,
        overscanPx: 20,
      })
    const windowedHeight =
      offsets[endIndex] + heights[endIndex] - offsets[startIndex]
    expect(topSpacerHeight + windowedHeight + bottomSpacerHeight).toBe(
      totalHeight,
    )
  })

  test('empty message list produces an empty window', () => {
    const result = computeWindow({
      offsets: [],
      heights: [],
      totalHeight: 0,
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(result).toEqual({
      startIndex: 0,
      endIndex: -1,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    })
  })

  test('scrolling to the bottom includes the last message', () => {
    const { endIndex } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: totalHeight - 100,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(endIndex).toBe(COUNT - 1)
  })
})

describe('resolveMessageHeight', () => {
  const message = makeMessage({ variant: 'user', content: 'hello world' })

  test('measured height wins when the width matches', () => {
    expect(
      resolveMessageHeight(message, { width: WIDTH, height: 42 }, WIDTH),
    ).toBe(42)
  })

  test('width-mismatched measurement is ignored and falls back to estimate', () => {
    // Measured at a different width (a zoom): treated as absent.
    expect(
      resolveMessageHeight(message, { width: WIDTH + 20, height: 42 }, WIDTH),
    ).toBe(estimateMessageHeight(message, WIDTH))
  })

  test('never-measured message falls back to the estimate', () => {
    expect(resolveMessageHeight(message, undefined, WIDTH)).toBe(
      estimateMessageHeight(message, WIDTH),
    )
  })

  test('measured heights are NOT clamped while estimates ARE', () => {
    // Content far exceeding MAX_MESSAGE_HEIGHT (400) clamps the estimate...
    const huge = makeMessage({ variant: 'user', content: 'a\n'.repeat(600) })
    expect(estimateMessageHeight(huge, WIDTH)).toBe(400)
    // ...but a real measured height above the clamp is used verbatim.
    expect(resolveMessageHeight(huge, { width: WIDTH, height: 999 }, WIDTH)).toBe(
      999,
    )
  })
})

describe('computeTopSpacer', () => {
  // 100 messages each 10 rows after a 2-row header.
  const COUNT = 100
  const HEIGHT = 10
  const HEADER = 2
  const heights = Array.from({ length: COUNT }, () => HEIGHT)
  const offsets = Array.from({ length: COUNT }, (_, i) => HEADER + i * HEIGHT)

  test('at the top the content-area spacer is 0', () => {
    expect(
      computeTopSpacer(offsets, heights, 0, 100, 20, HEADER),
    ).toBe(0)
  })

  test('mid-scroll the spacer is offsets[startIndex] minus the header', () => {
    const scrollTop = 500
    const overscanPx = 20
    // windowStart = 480 -> first index with offsets[i]+heights[i] > 480 is 47
    // ([472, 482)). Content-area spacer = offsets[47] - HEADER.
    expect(
      computeTopSpacer(offsets, heights, scrollTop, 100, overscanPx, HEADER),
    ).toBe(offsets[47] - HEADER)
  })
})

describe('computeAnchorDelta', () => {
  // 100 messages each 10 rows after a 2-row header; anchor at mid-viewport.
  const COUNT = 100
  const HEIGHT = 10
  const HEADER = 2
  const baseHeights = Array.from({ length: COUNT }, () => HEIGHT)
  const offsetsOf = (hs: number[]): number[] => {
    const result = new Array<number>(hs.length)
    let acc = HEADER
    for (let i = 0; i < hs.length; i++) {
      result[i] = acc
      acc += hs[i]
    }
    return result
  }
  const idsOf = (n: number, prefix = 'm'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  const prevOffsets = offsetsOf(baseHeights)
  const prevIds = idsOf(COUNT)
  const scrollTop = 500 // anchor = first index with bottom > 500 -> index 49 ([492,502))

  test('a height change above the viewport yields that delta', () => {
    const nextHeights = [...baseHeights]
    nextHeights[10] += 5 // message 10 grows by 5, above the anchor
    const nextIds = prevIds
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(5)
  })

  test('a height change below the viewport yields 0', () => {
    const nextHeights = [...baseHeights]
    nextHeights[60] += 5 // message 60 grows, below the anchor
    const nextIds = prevIds
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(0)
  })

  test('streaming last-message growth while scrolled up yields 0', () => {
    const nextHeights = [...baseHeights]
    nextHeights[COUNT - 1] += 7 // the streaming last message grows
    const nextIds = prevIds
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(0)
  })

  test('a prepend above the viewport (LoadPrevious) compensates by the prepended height', () => {
    // LoadPrevious re-expands hidden messages above the viewport: the anchor
    // id now sits `prepended` positions later in the next layout. The old
    // positional-index version read nextOffsets[anchorIndex] — the offset of
    // a DIFFERENT message — and under-compensated (0 here); the id-anchored
    // delta is the summed prepended height.
    const prepended = 3
    const nextHeights = [
      ...Array.from({ length: prepended }, () => HEIGHT),
      ...baseHeights,
    ]
    const nextIds = [...idsOf(prepended, 'hidden'), ...prevIds]
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(prepended * HEIGHT)
  })

  test('pruning messages above the viewport compensates by the removed height', () => {
    // Messages above the anchor are removed: the anchor id shifts EARLIER in
    // the next layout, and the delta is the negative summed removed height —
    // the compensation the old positional read (which landed on the same
    // numeric offset by coincidence here) cannot be trusted to produce when
    // heights are non-uniform.
    const removed = 4
    const nextHeights = baseHeights.slice(removed)
    const nextIds = prevIds.slice(removed)
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(-removed * HEIGHT)
  })

  test('removing the anchor message itself yields 0 instead of a bogus delta', () => {
    // The regression case: the anchor message itself is pruned (or the list
    // was replaced), so the anchor id no longer exists in the next layout.
    // The old positional read landed on an unrelated message's offset (or,
    // with a short next list, read past the end and produced a large
    // negative delta whose clamped write snapped scrollTop to 0). The
    // id-anchored version finds no anchor and does not compensate at all.
    const nextHeights = baseHeights.slice(COUNT / 2)
    const nextIds = prevIds.slice(COUNT / 2)
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(0)
  })

  test('a reset to a list shorter than the anchor index does not clamp to the top', () => {
    // The off-the-end clamp-to-0 case: nextOffsets is shorter than the
    // positional anchor index (49) and contains entirely different messages
    // (a session reset/prune), so nextOffsets[anchorIndex] was undefined and
    // the old delta was a large negative value that clamped scrollTop to 0 —
    // an abrupt jump to the top. With no surviving anchor id the delta is 0.
    const nextHeights = [HEIGHT, HEIGHT]
    const nextIds = ['fresh-a', 'fresh-b']
    const nextOffsets = offsetsOf(nextHeights)
    expect(
      computeAnchorDelta(
        prevIds,
        prevOffsets,
        baseHeights,
        nextIds,
        nextOffsets,
        nextHeights,
        scrollTop,
      ),
    ).toBe(0)
  })
})

describe('computeAnimationFrameScroll', () => {
  test('frames ease from the start position toward the current target', () => {
    // easeOutCubic(0.5) = 1 - 0.5^3 = 0.875
    expect(computeAnimationFrameScroll(100, 200, 0.875)).toBeCloseTo(187.5)
  })

  test('an anchor compensation that redirects the target mid-flight is honored', () => {
    // Animation started at 100 toward 200; an above-viewport height change
    // lands a +10 delta on animationTargetRef mid-flight. The frame must
    // ease toward 210 — the old captured-distance formula would ease toward
    // the stale target 200 (198.4375 here), dropping the compensation and
    // snapping the viewport by the delta on completion.
    expect(computeAnimationFrameScroll(100, 210, 0.984375)).toBeCloseTo(
      100 + 110 * 0.984375,
    )
  })

  test('at completion (progress 1) the full redirected delta has landed', () => {
    expect(computeAnimationFrameScroll(100, 210, 1)).toBe(210)
  })
})

describe('clampScrollValue', () => {
  test('clamps an above-maxScroll value down to maxScroll', () => {
    // Every animation-frame write (including the final tick) clamps the
    // eased position to the box's valid range so a mid-flight anchor delta
    // can never park scrollTop outside it.
    expect(clampScrollValue(450, 300)).toBe(300)
  })

  test('clamps a negative value up to 0', () => {
    expect(clampScrollValue(-25, 300)).toBe(0)
  })

  test('leaves an in-range value untouched', () => {
    expect(clampScrollValue(150, 300)).toBe(150)
  })

  test('clamps everything to 0 when there is no overflow', () => {
    expect(clampScrollValue(50, 0)).toBe(0)
    expect(clampScrollValue(-50, 0)).toBe(0)
  })

  test('treats a negative maxScroll as zero overflow', () => {
    expect(clampScrollValue(5, -10)).toBe(0)
  })
})

describe('computeAnchorVerifyCorrection', () => {
  test('returns the re-clamped desired value when the write was swallowed', () => {
    // The anchor write wanted 610 but was clamped against the pre-settle
    // geometry (scrollTop 550), then child layout landed with maxScroll 600:
    // re-verification re-clamps 610 to 600 and re-applies the residual.
    // A desired value within the settled range re-clamps to itself.
    expect(computeAnchorVerifyCorrection(610, 550, 600, 0.5)).toBe(600)
    expect(computeAnchorVerifyCorrection(500, 600, 600, 0.5)).toBe(500)
  })

  test('returns null when the settled position already matches', () => {
    expect(computeAnchorVerifyCorrection(600, 600, 600, 0.5)).toBeNull()
    expect(computeAnchorVerifyCorrection(601, 600, 600, 0.5)).toBeNull()
  })

  test('returns null beyond the pass-budget tolerance in the other direction', () => {
    // The settled position drifted from the re-clamped desired value: a
    // corrective write is needed (a newer scroll intent owns the position,
    // handled by the caller's lastWritten guard, not here).
    expect(computeAnchorVerifyCorrection(500, 550, 600, 0.5)).toBe(500)
  })

  test('negative geometry yields a 0 clamp with the same semantics', () => {
    expect(computeAnchorVerifyCorrection(10, 5, -3, 0.5)).toBe(0)
  })
})

describe('computeAnchorVerifyGuard', () => {
  test('a landed write (position at lastWritten) proceeds', () => {
    expect(computeAnchorVerifyGuard(600, 600, 550, 0.5)).toBe('proceed')
    expect(computeAnchorVerifyGuard(600.4, 600, 550, 0.5)).toBe('proceed')
  })

  test('a silently-clamped write (position still at preWrite) proceeds, not newer-intent', () => {
    // The regression case: the initial compensating write was clamped
    // against stale geometry — the write was attempted (lastWritten 600)
    // but the position never left its pre-write value 550. The un-moved
    // position is NOT a newer scroll intent: deferred verification exists
    // to re-apply exactly this swallowed residual.
    expect(computeAnchorVerifyGuard(550, 600, 550, 0.5)).toBe('proceed')
  })

  test('no write attempted (lastWritten null) proceeds', () => {
    expect(computeAnchorVerifyGuard(550, null, 550, 0.5)).toBe('proceed')
  })

  test('movement away from both the write and the pre-write position is newer intent', () => {
    // A genuine user scroll (or the auto-scroll effect, or an animation)
    // moved the position after the verified write: do not fight it.
    expect(computeAnchorVerifyGuard(480, 600, 550, 0.5)).toBe('newer-intent')
    expect(computeAnchorVerifyGuard(620, 600, 550, 0.5)).toBe('newer-intent')
  })

  test('a no-op write (preWrite equals lastWritten) still proceeds', () => {
    // A write targeting the position it already had never moves anything;
    // that is not newer intent either.
    expect(computeAnchorVerifyGuard(550, 550, 550, 0.5)).toBe('proceed')
  })

  test('epsilon tolerance boundaries match the movement guard contract', () => {
    // Within epsilon of preWrite counts as un-moved (proceed)...
    expect(computeAnchorVerifyGuard(550.4, 600, 550, 0.5)).toBe('proceed')
    // ...and just beyond epsilon, still BETWEEN the pre-write value and the
    // written target, is a partially-applied write: the clamp moved the
    // position off its pre-write value but short of the target, so the
    // residual is owed rather than a newer scroll intent.
    expect(computeAnchorVerifyGuard(550.6, 600, 550, 0.5)).toBe(
      'partially-applied',
    )
  })

  test('a swallowed write composes with the correction to re-apply the residual', () => {
    // End-to-end shape of a deferred pass (the direct-write path's pass, and
    // the one the animation path defers at its final tick): the guard
    // proceeds on the un-moved position and the correction re-clamps the
    // desired value against settled geometry, so the swallowed residual
    // (610 clamped to 600) is re-applied instead of verification aborting.
    const position = 550
    expect(
      computeAnchorVerifyGuard(position, 600, position, 0.5),
    ).toBe('proceed')
    expect(computeAnchorVerifyCorrection(610, position, 600, 0.5)).toBe(600)
  })

  test('a partially-applied write (short of the written target) is not newer intent', () => {
    // The regression case: the corrective write targeted 600 (lastWritten)
    // from a pre-write position of 550, but OpenTUI clamped against
    // geometry that had grown only partway — the position moved to 575,
    // strictly between the pre-write value and the target. The previous
    // three-state classifier called this 'newer-intent', the chain
    // abandoned, and the remaining residual (toward the settled geometry)
    // was silently dropped: the bounded one-off viewport jump this state
    // machine exists to prevent.
    expect(computeAnchorVerifyGuard(575, 600, 550, 0.5)).toBe(
      'partially-applied',
    )
    // The mirrored downward clamp: a negative-delta compensation partially
    // applied between the pre-write value and its lower target.
    expect(computeAnchorVerifyGuard(520, 500, 550, 0.5)).toBe(
      'partially-applied',
    )
  })

  test('movement beyond the written target in the write direction is still newer intent', () => {
    // A partial clamp can never carry the position PAST the written value
    // (the assignment targeted lastWritten): landing beyond it means a
    // newer scroll intent overtook the write.
    expect(computeAnchorVerifyGuard(605, 600, 550, 0.5)).toBe('newer-intent')
  })

  test('a partially-applied write composes with the correction to re-apply the residual', () => {
    // End-to-end shape of the next deferred pass after a partial clamp: the
    // guard classifies the position (575, between preWrite 550 and
    // lastWritten 600) as partially applied, and the correction re-clamps
    // the chain's desired value (610) against settled geometry (maxScroll
    // 600) so the remaining residual is re-applied instead of dropped.
    const position = 575
    expect(computeAnchorVerifyGuard(position, 600, 550, 0.5)).toBe(
      'partially-applied',
    )
    expect(computeAnchorVerifyCorrection(610, position, 600, 0.5)).toBe(600)
  })
})

describe('nextZeroHeightAttempt', () => {
  test('advances the attempt counter within the budget', () => {
    expect(nextZeroHeightAttempt(0)).toBe(1)
    expect(nextZeroHeightAttempt(ZERO_HEIGHT_MAX_ATTEMPTS - 1)).toBe(
      ZERO_HEIGHT_MAX_ATTEMPTS,
    )
  })

  test('returns null once the budget is exhausted', () => {
    expect(nextZeroHeightAttempt(ZERO_HEIGHT_MAX_ATTEMPTS)).toBeNull()
    expect(nextZeroHeightAttempt(ZERO_HEIGHT_MAX_ATTEMPTS + 5)).toBeNull()
  })
})

describe('pruneMeasuredHeights', () => {
  test('removes entries for messages that left the list and keeps visible ones', () => {
    const heights = new Map<string, MeasuredHeight>([
      ['gone-a', { width: WIDTH, height: 5 }],
      ['kept', { width: WIDTH, height: 7 }],
      ['gone-b', { width: WIDTH + 2, height: 9 }],
    ])
    const pending = new Set(['gone-a', 'kept'])

    expect(pruneMeasuredHeights(heights, new Set(['kept']), pending)).toBe(2)
    expect(heights.size).toBe(1)
    expect(heights.get('kept')).toEqual({ width: WIDTH, height: 7 })
    // Pending ids for pruned messages are cleared too; a still-visible id's
    // pending measurement survives so its flush still bumps the version.
    expect(pending.has('gone-a')).toBe(false)
    expect(pending.has('kept')).toBe(true)
  })

  test('an empty visible list prunes everything', () => {
    const heights = new Map<string, MeasuredHeight>([
      ['m1', { width: WIDTH, height: 3 }],
    ])
    expect(pruneMeasuredHeights(heights, new Set())).toBe(1)
    expect(heights.size).toBe(0)
  })
})

type FakeScrollbox = {
  scrollTop: number
  verticalScrollBar: { scrollPosition: number }
}

const makeBox = (
  scrollTop: number,
  scrollPosition = scrollTop,
): FakeScrollbox => {
  const state = { scrollTop, scrollPosition }
  return {
    get scrollTop(): number {
      return state.scrollTop
    },
    set scrollTop(value: number) {
      // A real ScrollBoxRenderable's scrollbar position reflects the scrollTop
      // write (the 'change' event fires through the scrollbar); the divergent
      // and clamping fakes below model the exceptions explicitly.
      state.scrollTop = value
      state.scrollPosition = value
    },
    get verticalScrollBar(): { scrollPosition: number } {
      return {
        get scrollPosition(): number {
          return state.scrollPosition
        },
      }
    },
  }
}

/**
 * A scrollbox whose scrollTop assignment is silently clamped (the write
 * lands, the position never moves) — the stale-geometry failure mode the
 * leak-safe flag attribution exists to survive.
 */
const makeClampingBox = (pos: number): FakeScrollbox => ({
  get scrollTop(): number {
    return pos
  },
  set scrollTop(value: number) {
    // Clamped: never actually moves.
  },
  verticalScrollBar: { scrollPosition: pos },
})

/**
 * A scrollbox with transient scrollTop/scrollbar divergence: scrollTop reads
 * a stale pre-write value for a bounded window after a programmatic write
 * while the scrollbar position (the canonical source) already reports the
 * new value. Models the exact window the readback-source fix targets.
 */
const makeDivergentBox = (
  before: number,
  after: number,
): FakeScrollbox => {
  let written = false
  return {
    get scrollTop(): number {
      // scrollTop transiently still reports the pre-write value.
      return before
    },
    set scrollTop(_value: number) {
      // The write lands in the box core, but scrollTop's read path has not
      // caught up within the divergence window.
      written = true
    },
    verticalScrollBar: {
      get scrollPosition(): number {
        // The canonical scrollbar source reflects the write immediately:
        // pre-write it reports the old position, post-write the new one.
        return written ? after : before
      },
    },
  }
}

/**
 * A scrollbox whose scrollbar reports a fixed drifted/quantized position
 * after any write — models sub-row/float drift in the canonical readback
 * source (e.g. a write targeting 200 whose readback reports 150.5).
 */
const makeQuantizedBox = (before: number, landed: number): FakeScrollbox => {
  let written = false
  return {
    get scrollTop(): number {
      return written ? landed : before
    },
    set scrollTop(_value: number) {
      written = true
    },
    verticalScrollBar: {
      get scrollPosition(): number {
        return written ? landed : before
      },
    },
  }
}

describe('classifyScrollChangeMovement', () => {
  // The same epsilon every other position comparison in this data flow uses
  // (ANCHOR_VERIFY_EPSILON = 0.5 in use-scroll-management).
  const EPSILON = 0.5

  test('a real position movement is moved (keeps genuine-scroll re-arm behavior)', () => {
    // The 'moved' verdict is what drives the handler's existing genuine-user-
    // scroll behavior: cancel animation + anchor-verify chain, re-arm follow
    // = isNearBottom. Both directions of real movement classify as moved.
    expect(classifyScrollChangeMovement(500, 300, EPSILON)).toBe('moved')
    expect(classifyScrollChangeMovement(300, 500, EPSILON)).toBe('moved')
  })

  test('a movement-less change event (transient reflow geometry) is geometry-only', () => {
    // The regression case: during message-append reflow the geometry is
    // transient and a 'change' event can fire without the position moving;
    // re-arming follow on it would snap a scrolled-up user back to the
    // bottom. The guard classifies it as geometry-only so no re-arm happens.
    expect(classifyScrollChangeMovement(500, 500, EPSILON)).toBe(
      'geometry-only',
    )
    // Sub-row float drift from the scrollbar source also counts as un-moved
    // (the same tolerance the other position guards use).
    expect(classifyScrollChangeMovement(500.4, 500, EPSILON)).toBe(
      'geometry-only',
    )
  })

  test('the boundary at exactly epsilon is geometry-only; beyond it is moved', () => {
    // |current - lastObserved| == epsilon is within the <= epsilon tolerance
    // every other position guard in this data flow uses.
    expect(classifyScrollChangeMovement(500.5, 500, EPSILON)).toBe(
      'geometry-only',
    )
    expect(classifyScrollChangeMovement(500.6, 500, EPSILON)).toBe('moved')
  })
})

describe('applyProgrammaticScrollTop', () => {
  const makeFlags = () => ({
    programmatic: { current: false },
    follow: { current: true as boolean },
  })

  test('arms the flag before the write and keeps it when the position moves', () => {
    const box = makeBox(100)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      box,
      150,
      true,
      true,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(true)
    expect(box.scrollTop).toBe(150)
    expect(box.verticalScrollBar.scrollPosition).toBe(150)
    expect(flags.programmatic.current).toBe(true)
    expect(flags.follow.current).toBe(true)
  })

  test('a silently-clamped write (no movement) clears the flag it armed', () => {
    // OpenTUI can clamp an assignment against stale geometry: the write
    // lands, the position does not move, and no 'change' event fires. The
    // flag armed before the write must not survive it, or the next genuine
    // user scroll is misattributed as programmatic (the anchor-verify pass
    // exhaustion leak).
    const clampingBox = makeClampingBox(150)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      clampingBox,
      600,
      false,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(clampingBox.verticalScrollBar.scrollPosition).toBe(150)
    expect(flags.programmatic.current).toBe(false)
  })

  test('a silently-clamped write rolls back the follow intent it armed', () => {
    // The follow-rollback regression: the clamped write arms the follow
    // intent before the write but emits no consuming 'change' event, so the
    // new value must not survive it. A surviving stale intent would be
    // consumed by a later follow-undefined write (the auto-scroll clamp/pin
    // path), silently disabling auto-follow after a content-shrink clamp
    // even though the user is at the bottom.
    const clampingBox = makeClampingBox(150)
    const flags = makeFlags() // follow.current starts true
    const moved = applyProgrammaticScrollTop(
      clampingBox,
      600,
      false,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(flags.programmatic.current).toBe(false)
    // The armed follow=false is rolled back to the pre-write intent.
    expect(flags.follow.current).toBe(true)
  })

  test('a no-op write with an explicit follow intent rolls the intent back', () => {
    // A no-op assignment to an already-at-target position is the same
    // failure shape as a silent clamp: no movement, no 'change' event, so
    // the armed follow value must not survive the write either.
    const box = makeBox(300)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      box,
      300,
      false,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(flags.programmatic.current).toBe(false)
    expect(flags.follow.current).toBe(true)
  })

  test('a moved write still arms the follow intent for its consuming event', () => {
    // The rollback only applies to failed writes: a moved write keeps the
    // new follow intent armed until the consuming 'change' event reads it.
    const box = makeBox(100)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      box,
      150,
      false,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(true)
    expect(flags.programmatic.current).toBe(true)
    expect(flags.follow.current).toBe(false)
  })

  test('a no-op write to an already-at-target position clears the flag', () => {
    const box = makeBox(300)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      box,
      300,
      undefined,
      true,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(flags.programmatic.current).toBe(false)
  })

  test('a follow-undefined write arms the LIVE follow state, not a stale ref value', () => {
    // The stale-intent regression (RF-1-0905023e): a follow-undefined
    // programmatic write (the auto-scroll clamp/pin path) used to leave the
    // ref's leftover intent in place for its consuming 'change' event. A
    // stale false (e.g. left by an earlier scroll-away write) would then
    // silently disable auto-follow after a content-shrink clamp even though
    // the user is at the bottom. The write must arm the caller's LIVE follow
    // state instead.
    const box = makeBox(0)
    const flags = makeFlags()
    flags.follow.current = false // stale intent left by an earlier write
    applyProgrammaticScrollTop(
      box,
      10,
      undefined,
      true, // live follow state: the user is at the bottom
      flags.programmatic,
      flags.follow,
    )
    expect(flags.programmatic.current).toBe(true)
    expect(flags.follow.current).toBe(true)
  })

  test('a follow-undefined write arms live=false when the user has scrolled away', () => {
    // The clamp path can still fire while follow is disabled (a position
    // above maxScroll clamps back into range regardless of follow): its
    // consuming event must see the live disabled intent, not re-enable
    // follow.
    const box = makeBox(0)
    const flags = makeFlags()
    applyProgrammaticScrollTop(
      box,
      10,
      undefined,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(flags.programmatic.current).toBe(true)
    expect(flags.follow.current).toBe(false)
  })

  test('a no-op follow-undefined write rolls the armed intent back', () => {
    // A no-move write emits no consuming 'change' event, so the resolved
    // intent must not survive it: the pre-write ref value is restored.
    const box = makeBox(300)
    const flags = makeFlags()
    flags.follow.current = false
    const moved = applyProgrammaticScrollTop(
      box,
      300,
      undefined,
      true,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(flags.programmatic.current).toBe(false)
    expect(flags.follow.current).toBe(false)
  })

  test('a write that moved is judged landed through the scrollbar source even while scrollTop diverges', () => {
    // The regression case the readback-source fix closes: right after a
    // programmatic write, scrollTop can transiently still report the
    // pre-write value while the canonical scrollbar position already
    // reports the new one. The write DID move the position (the scrollbar
    // confirms it), so the flag must stay armed for its consuming 'change'
    // event — a scrollTop-based readback would misreport the write as
    // unmoved, clear the flag, and leak the misattribution invariant the
    // helper exists to enforce.
    const divergentBox = makeDivergentBox(100, 150)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      divergentBox,
      150,
      false,
      false,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(true)
    expect(divergentBox.verticalScrollBar.scrollPosition).toBe(150)
    expect(flags.programmatic.current).toBe(true)
    expect(flags.follow.current).toBe(false)
  })

  test('a genuinely-unmoved write is still detected through the scrollbar source', () => {
    // Both sources agree the write did not move: the flag must clear.
    const box = makeBox(150, 150)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      box,
      150,
      true,
      true,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(flags.programmatic.current).toBe(false)
  })

  test('a sub-row drift report within the shared epsilon is judged unmoved', () => {
    // The scrollbar source can report a position with sub-row/float drift
    // (e.g. 149.9999 vs 150). Exact equality would misjudge such a drifted
    // report as a real movement and arm the flag with no consuming 'change'
    // event; within ANCHOR_VERIFY_EPSILON (0.5) is the same position, so the
    // no-op write still clears the flag it armed.
    const driftBox = makeBox(150, 149.9999)
    const flags = makeFlags()
    const moved = applyProgrammaticScrollTop(
      driftBox,
      150,
      true,
      true,
      flags.programmatic,
      flags.follow,
    )
    expect(moved).toBe(false)
    expect(driftBox.verticalScrollBar.scrollPosition).toBe(150)
    expect(flags.programmatic.current).toBe(false)
  })

  test('epsilon movement boundaries match the shared anchor-verify epsilon', () => {
    // A landed position exactly ANCHOR_VERIFY_EPSILON (0.5) from the pre-write
    // read is still the same position: the flag clears...
    const halfRowFlags = makeFlags()
    expect(
      applyProgrammaticScrollTop(
        makeQuantizedBox(150, 150.5),
        200,
        true,
        true,
        halfRowFlags.programmatic,
        halfRowFlags.follow,
      ),
    ).toBe(false)
    expect(halfRowFlags.programmatic.current).toBe(false)
    // ...and a landed position beyond epsilon is a real movement: the flag
    // stays armed for its consuming 'change' event.
    const beyondFlags = makeFlags()
    expect(
      applyProgrammaticScrollTop(
        makeQuantizedBox(150, 150.6),
        200,
        true,
        true,
        beyondFlags.programmatic,
        beyondFlags.follow,
      ),
    ).toBe(true)
    expect(beyondFlags.programmatic.current).toBe(true)
  })
})

describe('computeIsNearBottom', () => {
  test('counts the bottom itself and positions within the threshold as at-bottom', () => {
    expect(computeIsNearBottom(600, 600)).toBe(true)
    expect(
      computeIsNearBottom(600 - SCROLL_NEAR_BOTTOM_THRESHOLD, 600),
    ).toBe(true)
  })

  test('counts positions beyond the threshold as not at-bottom', () => {
    expect(
      computeIsNearBottom(600 - SCROLL_NEAR_BOTTOM_THRESHOLD - 1, 600),
    ).toBe(false)
    expect(computeIsNearBottom(0, 600)).toBe(false)
  })

  test('a scrollbox without overflow is always at bottom', () => {
    expect(computeIsNearBottom(0, 0)).toBe(true)
  })
})

describe('isFreshMeasurementNode', () => {
  const nodeA = {}
  const nodeB = {}

  test('a first attach (no node tracked yet) is fresh', () => {
    expect(isFreshMeasurementNode(undefined, nodeA)).toBe(true)
  })

  test('a re-attach of the same node keeps the existing budget (not fresh)', () => {
    expect(isFreshMeasurementNode(nodeA, nodeA)).toBe(false)
  })

  test('a different node instance is fresh', () => {
    expect(isFreshMeasurementNode(nodeA, nodeB)).toBe(true)
  })
})

describe('stepViewportLivenessGuard', () => {
  const makePending = (): ViewportLivenessPendingState => ({
    retryTimers: new Map([['m1', setTimeout(() => {}, 1)]]),
    retryAttempts: new Map([['m1', 3]]),
    detachNodes: new Map([['m1', {} as BoxRenderable]]),
    pendingMeasurements: new Set(['m1']),
  })

  const makeCaptureDeps = (alive: { current: boolean }) => ({
    isAlive: () => alive.current,
    getWidth: () => WIDTH,
    scheduleZeroHeightRetry: () => {},
    clearZeroHeightRetry: () => {},
    getStored: () => undefined,
    store: (width: number, height: number) => {
      calls.push({ width, height })
    },
  })
  let calls: Array<{ width: number; height: number }> = []

  test('an effect run re-arms a disarmed guard', () => {
    const alive = { current: true }
    stepViewportLivenessGuard(alive, makePending(), 'effect-cleanup')
    expect(alive.current).toBe(false)
    stepViewportLivenessGuard(alive, makePending(), 'effect-run')
    expect(alive.current).toBe(true)
  })

  test('an effect cleanup disarms the guard and clears all pending state', () => {
    const alive = { current: true }
    const pending = makePending()
    stepViewportLivenessGuard(alive, pending, 'effect-cleanup')
    expect(alive.current).toBe(false)
    expect(pending.retryTimers.size).toBe(0)
    expect(pending.retryAttempts.size).toBe(0)
    expect(pending.detachNodes.size).toBe(0)
    expect(pending.pendingMeasurements.size).toBe(0)
  })

  test('a StrictMode-style remount (cleanup then run) restores live captures', () => {
    // The regression case: the old []-dep teardown effect set the guard
    // false in its cleanup and never re-armed it, so a dev StrictMode-style
    // remount (mount -> cleanup -> mount of the same component instance)
    // permanently disabled every measurement capture and left the pending
    // retry state discarded while the component stayed mounted. The re-arm
    // on the effect run must make captures run again (they re-capture on
    // ref re-attach, so no measurement is lost).
    calls = []
    const alive = { current: true }
    stepViewportLivenessGuard(alive, makePending(), 'effect-cleanup')
    stepViewportLivenessGuard(alive, makePending(), 'effect-run')
    createMeasurementCapture({ height: 42 }, makeCaptureDeps(alive))()
    expect(calls).toEqual([{ width: WIDTH, height: 42 }])
  })

  test('a guard disarmed by cleanup still no-ops captures (teardown semantics preserved)', () => {
    // The re-arm must not weaken the unmount teardown: a capture running
    // after the cleanup still no-ops entirely through the disarmed guard.
    calls = []
    const alive = { current: true }
    stepViewportLivenessGuard(alive, makePending(), 'effect-cleanup')
    createMeasurementCapture({ height: 42 }, makeCaptureDeps(alive))()
    expect(calls).toEqual([])
  })
})

describe('createMeasurementCapture', () => {
  const makeDeps = () => {
    const calls: Array<{ width: number; height: number }> = []
    let alive = true
    let width = WIDTH
    let retriesScheduled = 0
    let retriesCleared = 0
    const stored = new Map<string, MeasuredHeight>([
      ['m1', { width: WIDTH, height: 10 }],
    ])
    return {
      calls,
      stored,
      deps: {
        isAlive: () => alive,
        getWidth: () => width,
        scheduleZeroHeightRetry: () => {
          retriesScheduled++
        },
        clearZeroHeightRetry: () => {
          retriesCleared++
        },
        getStored: () => stored.get('m1'),
        store: (w: number, h: number) => {
          calls.push({ width: w, height: h })
          stored.set('m1', { width: w, height: h })
        },
      },
      setWidth: (w: number) => {
        width = w
      },
      setAlive: (value: boolean) => {
        alive = value
      },
    }
  }

  test('stores a positive height tagged with the width read at capture time', () => {
    const env = makeDeps()
    const node = { height: 42 }
    const capture = createMeasurementCapture(node, env.deps)
    capture()
    expect(env.calls).toEqual([{ width: WIDTH, height: 42 }])
    expect(env.stored.get('m1')).toEqual({ width: WIDTH, height: 42 })
  })

  test('a re-measure after a width change is tagged with the NEW width', () => {
    // The stale-width regression: the capture closure outlives the attach
    // render (it is installed as the node's onSizeChange handler), so it
    // must read the width at capture time instead of binding the width at
    // attach time — otherwise a terminal width change (zoom) leaves the
    // still-mounted wrapper storing re-measured heights tagged with the old
    // width, which resolveMessageHeight then permanently ignores.
    const env = makeDeps()
    const node = { height: 42 }
    const capture = createMeasurementCapture(node, env.deps)
    capture()
    env.setWidth(WIDTH + 20)
    node.height = 37 // the zoom re-wrapped the message
    capture()
    expect(env.calls).toEqual([
      { width: WIDTH, height: 42 },
      { width: WIDTH + 20, height: 37 },
    ])
  })

  test('a same-width same-height re-measure does not re-store', () => {
    const env = makeDeps()
    const node = { height: 10 }
    const capture = createMeasurementCapture(node, env.deps)
    capture()
    expect(env.calls).toEqual([])
  })

  test('a non-positive height schedules the zero-height retry and does not store', () => {
    const env = makeDeps()
    const node = { height: 0 }
    const capture = createMeasurementCapture(node, env.deps)
    capture()
    expect(env.calls).toEqual([])
  })

  test('a capture running after unmount no-ops entirely', () => {
    const env = makeDeps()
    const node = { height: 42 }
    const capture = createMeasurementCapture(node, env.deps)
    env.setAlive(false)
    capture()
    expect(env.calls).toEqual([])
  })
})

describe('coalesceAnchorVerifyDesired', () => {
  test('a pending first-pass chain stacks the new anchor delta onto its desired', () => {
    // The residual-drop regression: the prior compensating write (desired
    // 610, written 600, preWrite 550) was silently clamped and its chain has
    // not yet run a pass; the next anchor (delta +10 from the current
    // position 550) arrives within ANCHOR_VERIFY_DELAY_MS. The merged chain
    // must verify 620 — the prior residual plus the new delta — instead of
    // discarding the prior desired and jumping the viewport by the residual.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        560,
        550,
        0.5,
      ),
    ).toBe(620)
  })

  test('a chain that already ran a pass is superseded (new desired wins)', () => {
    // The prior chain already re-applied its residual (or its pass ran and
    // the position reflects its write): the new desired, computed from the
    // current position, already reflects reality.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 1, lastWritten: 600, preWrite: 550, desired: 610 },
        560,
        550,
        0.5,
      ),
    ).toBe(560)
  })

  test('no pending chain returns the new desired unchanged', () => {
    expect(coalesceAnchorVerifyDesired(null, 560, 550, 0.5)).toBe(560)
  })

  test('a newer scroll intent between the write and the next anchor drops the prior chain', () => {
    // The position moved away from both the prior written value and its
    // pre-write value (a genuine user scroll owns the position): the prior
    // desired is no longer owed, and the new desired — computed from the
    // current position — is authoritative.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        490,
        480,
        0.5,
      ),
    ).toBe(490)
  })

  test('a landed prior write still coalesces its desired', () => {
    // The prior write landed (position at lastWritten 600) but its chain has
    // not yet re-verified against settled geometry, so the residual between
    // the written value and the prior desired (610 - 600) is still owed. The
    // new anchor (+50 from the current position 600) stacks on top of it:
    // merged desired = 610 + (650 - 600) = 660, i.e. the new destination plus
    // the still-owed prior residual.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        650,
        600,
        0.5,
      ),
    ).toBe(660)
  })

  test('a partially-applied prior write still stacks its owed residual', () => {
    // The partial-clamp regression: the prior compensating write (desired
    // 610, written 600, preWrite 550) was only PARTIALLY applied — the
    // position moved off 550 but stopped short of 600 at 575 (OpenTUI
    // clamped against partway-grown geometry). The prior residual
    // (610 - 575 = 35) is still owed, so the next anchor (+10 from 575)
    // must stack onto it: merged desired = 610 + (585 - 575) = 620, not
    // the bare 585 that silently drops the residual.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        585,
        575,
        0.5,
      ),
    ).toBe(620)
  })

  test('a chain from a dead scrollbox instance is not coalesced with (remount gate)', () => {
    // The remount regression: the pending chain belongs to the OLD scrollbox
    // instance. After a remount the new instance's position can fall within
    // epsilon of the dead chain's lastWritten/preWrite when scroll geometry is
    // similar, and coalescing would stack the dead box's desired destination
    // onto the new chain — the verify passes would then write a wrong
    // compensating position against the fresh scrollbox. When the instances
    // differ, the prior chain is dropped and the new desired is authoritative.
    const deadBox = {}
    const freshBox = {}
    expect(
      coalesceAnchorVerifyDesired(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: 610,
          scrollbox: deadBox,
        },
        560,
        550,
        0.5,
        freshBox,
      ),
    ).toBe(560)
  })

  test('a chain from the SAME scrollbox instance still coalesces', () => {
    // The instance gate only blocks cross-instance coalescing: same-instance
    // chains keep the residual-stacking behavior (same numbers as the
    // stacked case above).
    const box = {}
    expect(
      coalesceAnchorVerifyDesired(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: 610,
          scrollbox: box,
        },
        560,
        550,
        0.5,
        box,
      ),
    ).toBe(620)
  })
})

describe('carryPendingVerifyResidual', () => {
  test('a pending first-pass chain rides the animation as the merged destination', () => {
    // The residual-drop regression the animation paths carried: the prior
    // compensating write (desired 610, written 600, preWrite 550) was
    // silently clamped and its chain has not yet run a pass when an
    // animation takes over, easing toward 590 from the still-owed position
    // 550. The animation must carry the merged destination 610 + (590 -
    // 550) = 650 — folded into its ease target and deferred as the final
    // tick's verification — instead of unconditionally cancelling the chain
    // and jumping the viewport by the residual.
    expect(
      carryPendingVerifyResidual(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        590,
        550,
        0.5,
      ),
    ).toBe(650)
  })

  test('a partially-applied prior write stacks its owed residual onto the animation destination', () => {
    // The partial-clamp shape: the prior write (desired 610, written 600,
    // preWrite 550) was only partially applied — the position stopped at 575
    // between the pre-write value and the target. The residual (610 - 575 =
    // 35) is still owed, so an animation easing toward 585 carries the
    // merged destination 610 + (585 - 575) = 620.
    expect(
      carryPendingVerifyResidual(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        585,
        575,
        0.5,
      ),
    ).toBe(620)
  })

  test('no pending chain carries nothing', () => {
    expect(carryPendingVerifyResidual(null, 590, 550, 0.5)).toBeNull()
  })

  test('a chain that already ran a pass carries nothing', () => {
    // The prior chain already re-applied its residual: the animation's own
    // destination, computed from the current position, already reflects
    // reality.
    expect(
      carryPendingVerifyResidual(
        { passes: 1, lastWritten: 600, preWrite: 550, desired: 610 },
        590,
        550,
        0.5,
      ),
    ).toBeNull()
  })

  test('a newer scroll intent between the write and the animation carries nothing', () => {
    // The position moved away from both the prior written value and its
    // pre-write value (a genuine user scroll owns the position): nothing is
    // owed and the animation eases to its own destination unchanged.
    expect(
      carryPendingVerifyResidual(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        490,
        480,
        0.5,
      ),
    ).toBeNull()
  })

  test('a chain from a dead scrollbox instance carries nothing (remount gate)', () => {
    // The chain belongs to the OLD scrollbox instance: never carry its
    // desired destination into an animation running against the fresh
    // instance (the same instance gate coalesceAnchorVerifyDesired applies).
    const deadBox = {}
    const freshBox = {}
    expect(
      carryPendingVerifyResidual(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: 610,
          scrollbox: deadBox,
        },
        590,
        550,
        0.5,
        freshBox,
      ),
    ).toBeNull()
  })

  test('a prior desired already achieved at the current position carries nothing', () => {
    // prior.desired equals the live position (the clamp already parked the
    // viewport where the anchor wanted): the animation's own delta from that
    // position reproduces the desired destination exactly, so the merged
    // destination equals the animation target and nothing extra is carried.
    expect(
      carryPendingVerifyResidual(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 550 },
        590,
        550,
        0.5,
      ),
    ).toBeNull()
  })

  test('a pending settled-bottom chain is superseded by a numeric animation (carries nothing)', () => {
    // The settled-bottom supersession rule: a numeric animation destination
    // is the newer scroll intent and carries its own deferred verification,
    // so a pending width-change re-pin chain is dropped rather than stacked
    // (mirroring coalesceAnchorVerifyDesired).
    expect(
      carryPendingVerifyResidual(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: VERIFY_SETTLED_BOTTOM,
        },
        590,
        550,
        0.5,
      ),
    ).toBeNull()
  })
})

describe('carrySupersededAnimationResidual', () => {
  test('an unmet prior animation desired rides the superseding animation as the merged destination', () => {
    // The animation-supersession residual-drop regression: animation #1
    // captured a pending chain residual (merged desired 650) and was
    // superseded mid-flight at position 570 by animation #2 easing toward
    // 600. cancelAnimation() nulls animationDesiredRef, so without the
    // carry the stacked residual is destroyed and the viewport jumps by it
    // when animation #2 completes. The superseding animation must carry
    // 650 + (600 - 570) = 680 — the same stacking semantics a
    // chain→animation takeover applies via carryPendingVerifyResidual.
    expect(carrySupersededAnimationResidual(650, 600, 570, 0.5)).toBe(680)
  })

  test('no outgoing desired carries nothing', () => {
    expect(carrySupersededAnimationResidual(null, 600, 570, 0.5)).toBeNull()
  })

  test('a prior desired already achieved at the current position carries nothing', () => {
    // The outgoing animation's frames already parked the position at its
    // desired destination: the superseding animation's own delta from that
    // position reproduces it exactly, so the merged destination equals the
    // animation target and nothing extra is carried.
    expect(carrySupersededAnimationResidual(570, 600, 570, 0.5)).toBeNull()
  })

  test('a settled-bottom prior desired is superseded by a numeric animation', () => {
    // The same supersession rule coalesceAnchorVerifyDesired applies to a
    // numeric anchor write: a numeric animation destination must not be
    // overridden by the outgoing re-pin's settled-bottom desired.
    expect(
      carrySupersededAnimationResidual(VERIFY_SETTLED_BOTTOM, 600, 570, 0.5),
    ).toBeNull()
  })

  test('the carried destination composes with the chain residual, ease target, and completion verification', () => {
    // The full animateScrollTo supersession shape: the outgoing animation's
    // residual (650) is stacked with the superseding animation's delta
    // (680), then a pending chain's residual stacks on top of that
    // destination (610 + (680 - 570) = 720), and the merged value drives
    // both the ease target and the final tick's deferred verification.
    const superseded = carrySupersededAnimationResidual(650, 600, 570, 0.5)
    expect(superseded).toBe(680)
    const carried =
      carryPendingVerifyResidual(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        superseded ?? 600,
        570,
        0.5,
      ) ?? superseded
    expect(carried).toBe(720)
    expect(easeTargetWithCarriedResidual(600, carried)).toBe(720)
    expect(completionVerifyDesired(carried, false)).toBe(720)
  })
})

describe('classifyAnchorVerifyStepGate', () => {
  const chainBox = {}
  const freshBox = {}
  const pendingChain = { scrollbox: chainBox }

  test('a chain that still owns the ref on its own instance owns the pass', () => {
    expect(
      classifyAnchorVerifyStepGate(
        pendingChain,
        pendingChain,
        chainBox,
        chainBox,
      ),
    ).toBe('owns-chain')
  })

  test('a reentrant schedule inside the write dispatch supersedes the pass', () => {
    // The regression case: a reentrant scheduleAnchorVerify ran inside the
    // pass's synchronous write dispatch and installed a newer chain. The
    // superseded chain object must neither write scrollTop nor re-arm its
    // timer — a blind re-arm would let the dead chain self-perpetuate
    // alongside the new chain, interleaving compensating writes that fight
    // each other and corrupting the programmatic-flag attribution invariant.
    const newerChain = { scrollbox: freshBox }
    expect(
      classifyAnchorVerifyStepGate(
        newerChain,
        pendingChain,
        chainBox,
        chainBox,
      ),
    ).toBe('superseded-chain')
  })

  test('a reentrant cancel inside the write dispatch supersedes the pass', () => {
    // cancelAnchorVerify cleared the ref slot before the pass resumed: the
    // pass must stop without re-arming (and without touching the slot).
    expect(
      classifyAnchorVerifyStepGate(null, pendingChain, chainBox, chainBox),
    ).toBe('superseded-chain')
  })

  test('a remount that swapped the scrollbox instance makes the pass stale', () => {
    // The chain still owns the ref slot, but the box it was scheduled against
    // was replaced by a remount: the stale desired value must not be
    // re-applied to the fresh instance's geometry.
    expect(
      classifyAnchorVerifyStepGate(
        pendingChain,
        pendingChain,
        freshBox,
        chainBox,
      ),
    ).toBe('stale-scrollbox')
  })

  test('a chain whose box unmounted (no live instance) is stale', () => {
    expect(
      classifyAnchorVerifyStepGate(pendingChain, pendingChain, null, chainBox),
    ).toBe('stale-scrollbox')
  })
})

describe('classifyAnimationFoldGate', () => {
  test('an in-flight animation targeting the live instance folds the anchor in', () => {
    const box = {}
    expect(classifyAnimationFoldGate(true, box, box)).toBe(
      'fold-into-animation',
    )
  })

  test('no armed frame timer falls through to the direct write', () => {
    expect(classifyAnimationFoldGate(false, null, {})).toBe('direct-write')
  })

  test('an in-flight animation doomed by a remount falls through to the direct write', () => {
    // The fold-into-doomed-animation regression: the frame timer is still
    // armed (up to ANIMATION_FRAME_INTERVAL_MS) but the animation was started
    // against a DIFFERENT — post-remount, now dead — scrollbox instance. Its
    // next tick aborts on the instance guard without writing the fresh box or
    // scheduling deferred verification, so folding a compensating anchor into
    // that target silently drops the delta and the fresh scrollbox's viewport
    // jumps by the unapplied amount. The anchor must fall through to the
    // direct-write path against the live instance instead (which schedules
    // its own deferred verification).
    const staleBox = {}
    const freshBox = {}
    expect(classifyAnimationFoldGate(true, staleBox, freshBox)).toBe(
      'direct-write',
    )
  })

  test('a missing animation instance record falls through to the direct write', () => {
    // Belt-and-suspenders for the fold gate: a null animation instance
    // (e.g. a recording gap after an abort) must never authorize a fold,
    // because the animation's abort path writes nothing and schedules no
    // deferred verification.
    expect(classifyAnimationFoldGate(true, null, {})).toBe('direct-write')
  })

  test('a missing live scrollbox falls through to the direct write', () => {
    expect(classifyAnimationFoldGate(true, {}, null)).toBe('direct-write')
  })
})

describe('classifyAnimationRearmGate', () => {
  test('a frame whose animation still owns the token re-arms', () => {
    const token = {}
    expect(classifyAnimationRearmGate(token, token)).toBe('owns-loop')
  })

  test('a reentrant cancelAnimation inside the write dispatch supersedes the re-arm', () => {
    // The regression case: cancelAnimation ran reentrantly inside the
    // programmatic write's synchronous 'change' dispatch (e.g. a user
    // scroll handled during the dispatch) and cleared the ownership token.
    // The cancelled loop must not re-arm its frame timer — an unconditional
    // re-arm resurrects it and it keeps writing programmatic frames toward
    // a stale target, fighting the newer scroll intent.
    const token = {}
    expect(classifyAnimationRearmGate(null, token)).toBe('superseded-loop')
  })

  test('a superseding animateScrollTo inside the write dispatch supersedes the re-arm', () => {
    // The regression case: a superseding animateScrollTo ran reentrantly
    // inside the write's synchronous 'change' dispatch, recorded its own
    // ownership token and armed its own frame timer in animationFrameRef.
    // The stale loop must neither re-arm (fighting the newer frames) nor
    // overwrite animationFrameRef with its own timer handle (which would
    // orphan the newer loop's timer and let both loops write).
    const staleToken = {}
    const newerToken = {}
    expect(classifyAnimationRearmGate(newerToken, staleToken)).toBe(
      'superseded-loop',
    )
  })
})

describe('resolveAnchorScrollTop', () => {
  test('reads the live canonical scrollbar position, not the render-captured state', () => {
    // The stale-render-scrollTop regression: a further change event can land
    // between the state update that produced the render-captured scrollTop
    // (500) and the anchoring layout effect's commit. The anchor — and
    // therefore the compensation delta — must be computed against the live
    // canonical position (550), or adjustScrollTop shifts the live position
    // by a wrong-direction delta the deferred verify chain cannot correct.
    const divergentBox = makeDivergentBox(500, 550)
    divergentBox.scrollTop = 550
    expect(resolveAnchorScrollTop(divergentBox, 600, 500)).toBe(550)
  })

  test('clamps the live position to the current maxScroll', () => {
    expect(resolveAnchorScrollTop(makeBox(650), 600, 500)).toBe(600)
  })

  test('falls back to the render-captured state when no live scrollbox exists', () => {
    // Unit-test / no-box environments: the render-captured state IS the
    // authoritative scroll position there.
    expect(resolveAnchorScrollTop(null, 600, 500)).toBe(500)
  })
})

describe('computeAutoScrollTarget', () => {
  test('a position above maxScroll clamps back into range', () => {
    expect(computeAutoScrollTarget(makeBox(650), 600, false, false)).toBe(600)
  })

  test('follow-enabled below maxScroll pins to the bottom', () => {
    expect(computeAutoScrollTarget(makeBox(100), 600, true, false)).toBe(600)
  })

  test('at maxScroll (at bottom) no write is needed', () => {
    expect(computeAutoScrollTarget(makeBox(600), 600, true, false)).toBeNull()
  })

  test('follow disabled below maxScroll (user scrolled away) does not write', () => {
    expect(computeAutoScrollTarget(makeBox(100), 600, false, false)).toBeNull()
  })

  test('a user collapsing/expanding toggles suppresses the pin', () => {
    expect(computeAutoScrollTarget(makeBox(100), 600, true, true)).toBeNull()
  })

  test('the clamp comparison reads the canonical scrollbar position while scrollTop diverges', () => {
    // The regression case the canonical-source fix closes: right after a
    // programmatic write scrollTop transiently still reports the pre-write
    // value 550 while the canonical scrollbar position already reports 600.
    // With maxScroll 575 a scrollTop-based clamp comparison would see
    // 550 <= 575 and skip the write, leaving the position parked above the
    // box's valid range; the scrollbar-based comparison clamps to 575.
    const divergentBox = makeDivergentBox(550, 600)
    divergentBox.scrollTop = 600
    expect(
      computeAutoScrollTarget(divergentBox, 575, false, false),
    ).toBe(575)
  })

  test('the pin comparison reads the canonical scrollbar position while scrollTop diverges', () => {
    // Mirror case: the scrollbar reports 480 (below maxScroll 500, follow
    // enabled) so the pin write is needed, while the stale scrollTop read of
    // 500 would make a scrollTop-based comparison believe the box is
    // already at the bottom and skip the write.
    const divergentBox = makeDivergentBox(500, 480)
    divergentBox.scrollTop = 480
    expect(
      computeAutoScrollTarget(divergentBox, 500, true, false),
    ).toBe(500)
  })
})

describe('shouldSkipAutoScrollWrite', () => {
  // The auto-scroll effect's epsilon guard (ANCHOR_VERIFY_EPSILON = 0.5 in
  // use-scroll-management): a non-null computeAutoScrollTarget whose target
  // is already within epsilon of the current position must not be written.
  const EPSILON = 0.5

  test('a pin target within epsilon of the position is skipped (no write, no snap cycle)', () => {
    // The scroll-to-latest snap-back regression: during streaming the last
    // message's measured height grows the TRANSIENT maxScroll a fraction of
    // a row above the integer-rounded position (e.g. 600.4 vs 600), so
    // computeAutoScrollTarget returns a pin target on every messages change
    // even though the viewport already sits at the visual bottom. Writing it
    // pins the position to the transient bottom; when the layout settles at
    // a LOWER maxScroll (estimate-to-real transition, bottom-spacer
    // collapse) the re-clamp snaps the viewport back up. The within-epsilon
    // write is skipped so the position is never clamped to the transient
    // value.
    expect(shouldSkipAutoScrollWrite(600, 600.4, 600.4, EPSILON)).toBe(true)
  })

  test('a pin target beyond epsilon of the position still writes', () => {
    // A genuinely growing bottom (a new message arrived) moves maxScroll
    // well past epsilon: the pin write must still fire so follow keeps the
    // viewport pinned. The sub-row case (599.6 vs 600) is within epsilon and
    // correctly skipped — the viewport is already at the visual bottom.
    expect(shouldSkipAutoScrollWrite(540, 600, 600, EPSILON)).toBe(false)
    expect(shouldSkipAutoScrollWrite(599.6, 600, 600, EPSILON)).toBe(true)
  })

  test('the boundary at exactly epsilon is skipped; beyond it writes', () => {
    expect(shouldSkipAutoScrollWrite(600, 600.5, 600.5, EPSILON)).toBe(true)
    expect(shouldSkipAutoScrollWrite(600, 600.6, 600.6, EPSILON)).toBe(false)
  })

  test('the clamp path is never skipped, even within epsilon', () => {
    // A position above maxScroll is outside the box's valid range: the
    // clamp back into range is a legitimate safety write that must fire
    // even when the clamp distance is within epsilon.
    expect(shouldSkipAutoScrollWrite(600.4, 600, 600, EPSILON)).toBe(false)
  })

  test('composes with computeAutoScrollTarget: a sub-row streaming bump needs no write', () => {
    // End-to-end shape of one auto-scroll effect pass during streaming:
    // follow is on and the scrollbar position (600) sits a fraction of a
    // row below the transient maxScroll (600.4), so the target is the
    // transient bottom — but the position is already within epsilon of it,
    // so the effect writes nothing and the pending anchor-verify chain is
    // left to its own pass.
    const target = computeAutoScrollTarget(makeBox(600), 600.4, true, false)
    expect(target).toBe(600.4)
    expect(shouldSkipAutoScrollWrite(600, target ?? 0, 600.4, EPSILON)).toBe(
      true,
    )
  })

  test('composes with computeAutoScrollTarget: a real pin still writes', () => {
    const target = computeAutoScrollTarget(makeBox(540), 600, true, false)
    expect(target).toBe(600)
    expect(shouldSkipAutoScrollWrite(540, target ?? 0, 600, EPSILON)).toBe(
      false,
    )
  })
})

describe('animation entry points read the canonical scroll position', () => {
  test('the ease start reads the canonical scrollbar position while scrollTop diverges', () => {
    // The regression case the animation-entry fix closes: an animation
    // started inside the documented post-programmatic-write divergence
    // window must ease from the canonical scrollbar position (600 — the
    // write landed), not the stale scrollTop read (550, the pre-write
    // value). A scrollTop-based start captures the wrong start position and
    // the eased frames land off-target, snapping the viewport when the
    // animation completes at the canonical position.
    const divergentBox = makeDivergentBox(550, 600)
    divergentBox.scrollTop = 600
    expect(readCanonicalScrollPosition(divergentBox)).toBe(600)
  })

  test('a page-up target is computed from the canonical position while scrollTop diverges', () => {
    // A scrollTop-based page target inside the divergence window would page
    // up from the stale 550 (470 after one page of 0.8 * 100); the canonical
    // position 600 pages up to 520, matching where the animation will
    // actually start.
    const divergentBox = makeDivergentBox(550, 600)
    divergentBox.scrollTop = 600
    const position = readCanonicalScrollPosition(divergentBox)
    expect(computePageScrollTarget(position, 100, 600, 'up')).toBe(520)
  })

  test('a page-down target clamps to maxScroll', () => {
    expect(computePageScrollTarget(540, 100, 600, 'down')).toBe(600)
  })

  test('a page-down target below maxScroll pages by 0.8 of the viewport', () => {
    expect(computePageScrollTarget(100, 100, 600, 'down')).toBe(180)
  })

  test('a page-up target clamps to 0 near the top', () => {
    expect(computePageScrollTarget(20, 100, 600, 'up')).toBe(0)
  })

  test('a box without overflow pages to 0 in either direction', () => {
    expect(computePageScrollTarget(0, 100, 0, 'down')).toBe(0)
    expect(computePageScrollTarget(0, 100, 0, 'up')).toBe(0)
  })
})

describe('completionVerifyDesired', () => {
  test('a folded anchor compensation wins over the settled-bottom verification', () => {
    // The fold path keeps its existing semantics: the folded desired
    // destination is what the final tick defers verification for, regardless
    // of the re-pin flag.
    expect(completionVerifyDesired(610, true)).toBe(610)
    expect(completionVerifyDesired(610, false)).toBe(610)
  })

  test('a re-pin animation (no fold) defers verification of the settled bottom', () => {
    // The width-change re-pin: scrollToLatest targets "the bottom", not a
    // fixed offset, so the deferred destination must be the settled bottom
    // (clamped by computeAnchorVerifyCorrection to whatever maxScroll the
    // re-wrapped child layout produces) rather than nothing.
    expect(completionVerifyDesired(null, true)).toBe(VERIFY_SETTLED_BOTTOM)
  })

  test('an ordinary animation (no fold, no re-pin) defers nothing', () => {
    expect(completionVerifyDesired(null, false)).toBeNull()
  })
})

describe('VERIFY_SETTLED_BOTTOM composes with the deferred verify pass', () => {
  test('the correction re-pins to the settled maxScroll (extending upward)', () => {
    // The width-change re-pin regression: the re-wrapped child layout lands
    // after the ease started, so the final tick targets the stale bottom
    // 540 while the settled maxScroll is 600. The deferred pass must clamp
    // the settled-bottom desired UP to 600 and re-apply the residual — no
    // finite desired value captured before the layout commit can express
    // that upward extension.
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, 540, 600, 0.5),
    ).toBe(600)
  })

  test('a position already at the settled bottom needs no corrective write', () => {
    // When the layout had not landed by the final tick, the position still
    // matches the then-current maxScroll: no write (and no programmatic-flag
    // arming) — the chain simply finds nothing to correct.
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, 600, 600, 0.5),
    ).toBeNull()
  })

  test('a settled bottom ABOVE the current position needs no corrective write (never pull down)', () => {
    // The scroll-to-latest snap-back regression: the ease pinned the
    // position to a TRANSIENT bottom (610, produced while streaming growth
    // bumped maxScroll), then the layout settled at a LOWER maxScroll (600)
    // — the estimate-to-real transition and bottom-spacer collapse. A
    // direction-blind re-clamp would pull the position down to 600, the
    // visible snap-up glitch; the settled-bottom desired is one-directional
    // and only ever pushes UP toward a bottom below the position.
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, 610, 600, 0.5),
    ).toBeNull()
  })

  test('the width-change re-pin still pushes up when the settled bottom is below the position', () => {
    // The direction guard must not weaken the re-pin path the sentinel
    // exists for: after a zoom the re-wrapped layout grows the settled
    // maxScroll past the position the ease landed at, and the corrective
    // write still pushes the position up to it.
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, 540, 600, 0.5),
    ).toBe(600)
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, 550, 600, 0.5),
    ).toBe(600)
  })

  test('the direction guard applies only to the settled-bottom sentinel', () => {
    // A numeric desired keeps the direction-blind re-clamp: a finite anchor
    // destination above the settled maxScroll still clamps down to it.
    expect(computeAnchorVerifyCorrection(610, 610, 600, 0.5)).toBe(600)
  })

  test('the movement guard proceeds on a landed short final tick', () => {
    // The final tick landed at 540 (the stale bottom): the position is at
    // lastWritten and NOT newer scroll intent, so the pass may re-pin.
    expect(computeAnchorVerifyGuard(540, 540, 520, 0.5)).toBe('proceed')
  })

  test('end-to-end shape of one width-change re-pin verify pass', () => {
    // Guard proceeds on the landed short final tick, then the correction
    // re-pins to the settled bottom: the re-applied write is attributed
    // programmatic with the re-pin's follow intent, so its consuming 'change'
    // event keeps auto-follow enabled instead of silently disabling it.
    const position = 540
    expect(computeAnchorVerifyGuard(position, 540, 520, 0.5)).toBe('proceed')
    expect(
      computeAnchorVerifyCorrection(VERIFY_SETTLED_BOTTOM, position, 600, 0.5),
    ).toBe(600)
  })
})

describe('coalesceAnchorVerifyDesired settled-bottom semantics', () => {
  test('a new settled-bottom chain subsumes an owed numeric residual', () => {
    // The prior compensating write (desired 610, silently clamped at 550)
    // still owes its residual when the width-change re-pin schedules its
    // settled-bottom verification: a finite desired re-clamps to at most the
    // settled maxScroll, which is exactly the bottom the chain re-pins to,
    // so the merged chain verifies the settled bottom rather than stacking.
    expect(
      coalesceAnchorVerifyDesired(
        { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
        VERIFY_SETTLED_BOTTOM,
        550,
        0.5,
      ),
    ).toBe(VERIFY_SETTLED_BOTTOM)
  })

  test('a pending settled-bottom chain is superseded by a newer numeric anchor', () => {
    // A numeric anchor write is the newer scroll intent and carries its own
    // deferred verification: it must not be folded into (and overridden by)
    // a pending width-change re-pin chain.
    expect(
      coalesceAnchorVerifyDesired(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: VERIFY_SETTLED_BOTTOM,
        },
        490,
        480,
        0.5,
      ),
    ).toBe(490)
  })

  test('a numeric anchor supersedes a pending settled-bottom chain even when its write landed', () => {
    // Boundary between the two settled-bottom rules: with a NUMERIC prior the
    // landed-write state (position at lastWritten, guard 'proceed') stacks the
    // anchor onto the owed residual — but with a settled-bottom prior the
    // supersession rule fires first, before the movement guard is consulted,
    // so the newer numeric anchor intent always wins over a pending re-pin.
    expect(
      coalesceAnchorVerifyDesired(
        {
          passes: 0,
          lastWritten: 600,
          preWrite: 550,
          desired: VERIFY_SETTLED_BOTTOM,
        },
        560,
        550,
        0.5,
      ),
    ).toBe(560)
  })
})

describe('easeTargetWithCarriedResidual', () => {
  test('a carried residual redirects the ease target itself, not just the completion verify', () => {
    // The regression the animation-takeover fold closes: animateScrollTo
    // captured the pending anchor-verify residual via
    // carryPendingVerifyResidual but eased toward the RAW target, deferring
    // the residual to a post-completion verify write — a discrete
    // post-animation snap, inconsistent with adjustScrollTop's fold path
    // (which redirects the in-flight target by the merged destination) and
    // with carryPendingVerifyResidual's own contract. The ease target must
    // be the merged destination.
    expect(easeTargetWithCarriedResidual(590, 650)).toBe(650)
  })

  test('no carried residual eases toward the raw target', () => {
    expect(easeTargetWithCarriedResidual(590, null)).toBe(590)
  })

  test("the carried ease target composes with the final tick's deferred verification", () => {
    // animateScrollTo records the same merged destination as both the ease
    // target and the final tick's deferred verification desired — the same
    // desired-equals-folded-target invariant the fold path keeps.
    const carried = carryPendingVerifyResidual(
      { passes: 0, lastWritten: 600, preWrite: 550, desired: 610 },
      590,
      550,
      0.5,
    )
    expect(carried).toBe(650)
    expect(easeTargetWithCarriedResidual(590, carried)).toBe(650)
    expect(completionVerifyDesired(carried, false)).toBe(650)
  })
})

describe('foldAnimationVerifyDesired', () => {
  test('folding into an in-flight re-pin preserves the settled-bottom verification', () => {
    // The regression the fold-into-repin fix closes: folding a compensating
    // anchor into an in-flight scrollToLatest used to overwrite the re-pin's
    // settled-bottom completion verification with the finite folded target.
    // If the re-wrapped layout grows after the fold, the finite desired
    // re-clamps to itself — short of the new bottom — and the consuming
    // 'change' event silently disables auto-follow. The settled-bottom
    // desired must survive the fold.
    expect(foldAnimationVerifyDesired(560, true)).toBe(VERIFY_SETTLED_BOTTOM)
  })

  test('folding into an ordinary animation keeps the finite folded target as the verify desired', () => {
    expect(foldAnimationVerifyDesired(560, false)).toBe(560)
  })

  test('the folded settled-bottom desired survives the completion lookup', () => {
    // The fold path and the completion lookup compose: the stored
    // settled-bottom desired is what the final tick defers verification
    // for, and completionVerifyDesired passes it through (a non-null stored
    // desired wins, and here the stored desired IS the settled bottom).
    expect(
      completionVerifyDesired(foldAnimationVerifyDesired(560, true), true),
    ).toBe(VERIFY_SETTLED_BOTTOM)
  })
})
