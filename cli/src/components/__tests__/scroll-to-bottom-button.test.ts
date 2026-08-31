import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'

import {
  SCROLL_BUTTON_COMPACT_RESERVATION,
  SCROLL_BUTTON_RESERVATION,
} from '../../utils/status-bar-chips'
import {
  SCROLL_BUTTON_COMPACT_WIDTH,
  SCROLL_BUTTON_WIDTH,
  SCROLL_GLYPH,
  SCROLL_HINT_LABEL,
} from '../scroll-to-bottom-button'

/**
 * The button reserves a fixed width so hovering it cannot reflow the status
 * bar. Asserted on the exported constants rather than through the reconciler:
 * `@opentui/react/test-utils` is unavailable in this package's production-mode
 * test run, so hover cannot be simulated here.
 */
describe('ScrollToBottomButton reserved width', () => {
  test('the expanded width fits the hint label plus one column per side', () => {
    expect(SCROLL_BUTTON_WIDTH).toBe(stringWidth(SCROLL_HINT_LABEL) + 2)
    // Pinned: status-bar-chips.ts duplicates this as a literal reservation, so
    // a change to the label must be a deliberate change to both.
    expect(SCROLL_BUTTON_WIDTH).toBe(10)
  })

  test('the resting glyph occupies the same reserved width as the hover label', () => {
    // Both expanded-mode states render inside the same fixed width, so the
    // rendered button width is identical hovered and unhovered.
    const restingWidth = stringWidth(SCROLL_GLYPH) + 2
    expect(restingWidth).toBeLessThanOrEqual(SCROLL_BUTTON_WIDTH)
    expect(SCROLL_BUTTON_COMPACT_WIDTH).toBe(restingWidth)
    // Same pinning as the expanded width, against the duplicated reservation.
    expect(SCROLL_BUTTON_COMPACT_WIDTH).toBe(3)
  })

  test('the hint label and the compact form share the resting glyph', () => {
    // The compact width is derived from SCROLL_GLYPH, so the glyph the button
    // renders when resting is the one the width was measured from.
    expect(SCROLL_HINT_LABEL.startsWith(SCROLL_GLYPH)).toBe(true)
    // Non-ASCII, so rendered width rather than `.length` is what matters.
    expect(stringWidth(SCROLL_GLYPH)).toBe(1)
  })

  test('the hint stays short enough to leave the chips room', () => {
    // The old '↓ Scroll to bottom ↓' label was 20 columns; permanently
    // reserving that much would crowd the chip cluster.
    expect(SCROLL_BUTTON_WIDTH).toBeLessThan(20)
  })

  test('the chip budget reservation matches the button width', () => {
    // status-bar-chips.ts duplicates the value rather than importing this
    // component module, so the two must be asserted to agree.
    expect(SCROLL_BUTTON_RESERVATION).toBe(SCROLL_BUTTON_WIDTH)
  })

  test('the compact chip budget reservation matches the compact button width', () => {
    // Same duplication as above, for the narrow 'xs'/'sm' form.
    expect(SCROLL_BUTTON_COMPACT_RESERVATION).toBe(SCROLL_BUTTON_COMPACT_WIDTH)
    // Strictly cheaper than the expanded form, so reserving the expanded width
    // at 'xs'/'sm' would cost the chips columns for nothing.
    expect(SCROLL_BUTTON_COMPACT_RESERVATION).toBeLessThan(
      SCROLL_BUTTON_RESERVATION,
    )
  })
})
