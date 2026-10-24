import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  __getMeasureLinesCountForTest,
  computeMultilineInputHeight,
  createPlaceholderLineMemo,
  MULTILINE_INPUT_HORIZONTAL_PADDING,
  multilineInputMeasurementKey,
} from '../../utils/text-layout'
import {
  expandTabsForRendering,
  multilineInputPlaceholderArg,
  multilineInputWrapColumns,
} from '../multiline-input'

// MultilineInput measures at the width it was given minus its own wrapper
// padding, so this reservation leaves 10 columns of text: a 25-character
// unbroken token needs three visual rows there.
const NARROW_WRAP_WIDTH = MULTILINE_INPUT_HORIZONTAL_PADDING + 10

const UNBROKEN_TOKEN = 'x'.repeat(25)

/**
 * The identity a real caller forwards alongside its row count: the exact value
 * and wrap columns the count was measured from. Production derives this with
 * `multilineInputMeasurementKey` on both sides, so the fixtures use the same
 * helper rather than hand-rolling the string.
 */
const measuredKey = (value: string, wrapWidth: number): string =>
  multilineInputMeasurementKey(value, measuredKeyColumns(wrapWidth))

/**
 * Wrap columns MultilineInput derives from a reserved width. Named so a
 * production-derived identity and a hand-built one cannot drift apart.
 */
const measuredKeyColumns = (
  wrapWidth: number = NARROW_WRAP_WIDTH,
): number => wrapWidth - MULTILINE_INPUT_HORIZONTAL_PADDING

describe('computeMultilineInputHeight', () => {
  test('empty value measures one row', () => {
    const metrics = computeMultilineInputHeight({
      value: '',
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(1)
    expect(metrics.heightLines).toBe(1)
    expect(metrics.isScrollable).toBe(false)
  })

  test('long line wrapping to three visual rows measures three', () => {
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(3)
    expect(metrics.isScrollable).toBe(false)
  })

  test('accounts for the wrapper padding when wrapping', () => {
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: MULTILINE_INPUT_HORIZONTAL_PADDING + UNBROKEN_TOKEN.length,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(1)
    expect(metrics.heightLines).toBe(1)
  })

  test('multiline value is clamped by maxHeight', () => {
    const metrics = computeMultilineInputHeight({
      value: 'one\ntwo\nthree\nfour\nfive\nsix',
      wrapWidth: 40,
      maxHeight: 4,
    })

    expect(metrics.totalLines).toBe(6)
    expect(metrics.heightLines).toBe(4)
  })

  test('value that wraps to more rows than maxHeight is scrollable', () => {
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 2,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(2)
    expect(metrics.isScrollable).toBe(true)
  })

  test('falls back to the rendered line count without a wrap width', () => {
    const metrics = computeMultilineInputHeight({
      value: 'a\nb',
      lineInfoLines: 3,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(3)
  })

  test('never collapses below one row before any measurement exists', () => {
    const metrics = computeMultilineInputHeight({
      value: '',
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(1)
    expect(metrics.heightLines).toBe(1)
  })

  test('takes a caller-supplied row count instead of wrapping the value again', () => {
    // The chat screen already measured this exact value at these exact columns
    // and passes the count down. The box must trust it: UNBROKEN_TOKEN wraps to
    // three rows at NARROW_WRAP_WIDTH, so a re-measurement would ignore the 2.
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 2,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(2)
    expect(metrics.heightLines).toBe(2)
  })

  test('takes the caller-supplied gutter decision instead of the cursor row', () => {
    // chat.tsx measured this value and decided the gutter is drawn. The box has
    // no reliable cursorRow before the first commit (lineInfo is null), so it
    // must use the forwarded decision: UNBROKEN_TOKEN wraps to three rows here,
    // but two-row content is the case that rendered at height 2 and then grew
    // to 3 once lineInfo arrived.
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 2,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      measuredGutterEnabled: true,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(true)
    expect(metrics.heightLines).toBe(3)
  })

  test('a supplied gutter decision of false is not overridden by the cursor row', () => {
    // The mirror case: the caller measured no gutter, so a cursor row that
    // happens to sit on the second line must not add a row the CLI height does
    // not account for.
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 2,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      measuredGutterEnabled: false,
      cursorRow: 1,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
    expect(metrics.heightLines).toBe(2)
  })

  test('a supplied row count still participates in scrollability', () => {
    const metrics = computeMultilineInputHeight({
      value: '',
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 4,
      measurementKey: measuredKey('', NARROW_WRAP_WIDTH),
      maxHeight: 2,
    })

    expect(metrics.totalLines).toBe(4)
    expect(metrics.heightLines).toBe(2)
    expect(metrics.isScrollable).toBe(true)
  })

  test('a placeholder wrapping to N rows still gets an N-row box', () => {
    // The box renders the placeholder through the SAME wrapped text renderable
    // when the value is empty, and the caller only measured the value (chat.tsx
    // substitutes a single space for an empty input). Trusting that measurement
    // alone put a three-row placeholder inside a one-row box, and with
    // stickyScroll disabled the extra rows painted outside the scrollbox.
    const metrics = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 1,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBeGreaterThanOrEqual(3)
  })

  test('a multi-line placeholder is covered row for row', () => {
    const metrics = computeMultilineInputHeight({
      value: '',
      placeholder: 'one\ntwo\nthree',
      wrapWidth: 40,
      // The caller measured an empty input as a single space, i.e. one row.
      measuredTotalLines: 1,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBeGreaterThanOrEqual(3)
  })

  test('the placeholder is irrelevant once a value is being edited', () => {
    // Only the rendered text decides the height: with a value present the
    // placeholder is not drawn, so it must not inflate the box and must not
    // cost a wrap pass on the per-keystroke path.
    const before = __getMeasureLinesCountForTest()
    const metrics = computeMultilineInputHeight({
      value: 'x',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(1)
    expect(metrics.heightLines).toBe(1)
    expect(__getMeasureLinesCountForTest() - before).toBe(1)
  })

  test('a tall placeholder still respects maxHeight', () => {
    const metrics = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 2,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(2)
    expect(metrics.isScrollable).toBe(true)
  })

  test('a supplied row count costs the box no wrap pass of its own', () => {
    // The reuse contract at the box boundary: with the caller's row count and
    // gutter decision supplied, the box performs NO wrap pass. This is the half
    // of "one wrap per keystroke" that lives here; the wiring assertions below
    // pin the other half, that production actually supplies these props.
    const before = __getMeasureLinesCountForTest()
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 3,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      measuredGutterEnabled: false,
      maxHeight: 5,
    })

    expect(__getMeasureLinesCountForTest() - before).toBe(0)
    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(3)
  })

  test('a row count measured for other content is not trusted', () => {
    // The stale-read case: the caller's value prop has already moved on (or it
    // forwarded a count for different content), so the forwarded 2 does not
    // describe what is being drawn. The box must re-measure rather than size
    // itself for text it is not rendering.
    const before = __getMeasureLinesCountForTest()
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 2,
      measurementKey: measuredKey('something else', NARROW_WRAP_WIDTH),
      maxHeight: 5,
    })

    expect(__getMeasureLinesCountForTest() - before).toBe(1)
    expect(metrics.totalLines).toBe(3)
  })

  test('a row count measured at other columns is not trusted', () => {
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 1,
      measurementKey: measuredKey(
        UNBROKEN_TOKEN,
        MULTILINE_INPUT_HORIZONTAL_PADDING + UNBROKEN_TOKEN.length,
      ),
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
  })

  test('the empty-input frame reuses the caller measurement for the measured space', () => {
    // chat.tsx measures a single space for an empty input, so the identity it
    // forwards names that space, not ''. Keying the box on '' for this frame
    // never matched, so the reuse path was permanently off while the input
    // idled — the state it sits in between submits — and it re-wrapped the value
    // on every render. The placeholder is memoized separately, so a repeated
    // render of this frame must cost NO wrap pass at all.
    const placeholder = UNBROKEN_TOKEN
    const memo = createPlaceholderLineMemo()

    // First render of the frame warms the placeholder memo exactly once.
    const first = computeMultilineInputHeight({
      value: '',
      placeholder,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: memo,
      measuredTotalLines: 1,
      measurementKey: multilineInputMeasurementKey(' ', measuredKeyColumns()),
      maxHeight: 5,
    })
    expect(first.totalLines).toBe(3)

    const before = __getMeasureLinesCountForTest()
    const second = computeMultilineInputHeight({
      value: '',
      placeholder,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: memo,
      measuredTotalLines: 1,
      measurementKey: multilineInputMeasurementKey(' ', measuredKeyColumns()),
      maxHeight: 5,
    })

    // Flat: the value comes from the caller's count and the placeholder from the
    // memo, so an idle input costs nothing per render.
    expect(__getMeasureLinesCountForTest() - before).toBe(0)
    expect(second.totalLines).toBe(3)
    expect(second.heightLines).toBe(3)
  })

  test('one forwarded measurement serves both maxHeight branches without re-wrapping', () => {
    // chat-input-bar forwards the same inputTotalLines/inputGutterEnabled to its
    // compact branch (maxHeight = terminalHeight / 2) and its full branch
    // (maxHeight = terminalHeight / 2 as well, but the two branches are distinct
    // mounts). The forwarded count is a PRE-CLAMP row fact, so each mount applies
    // its own cap locally: no frame may re-wrap, and neither branch may inherit
    // the other's height.
    const value = UNBROKEN_TOKEN
    const key = measuredKey(value, NARROW_WRAP_WIDTH)
    const columnCount = measuredKeyColumns()

    const before = __getMeasureLinesCountForTest()
    const compact = computeMultilineInputHeight({
      value,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 3,
      measurementKey: key,
      measuredGutterEnabled: false,
      maxHeight: 2,
    })
    const full = computeMultilineInputHeight({
      value,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 3,
      measurementKey: key,
      measuredGutterEnabled: false,
      maxHeight: 10,
    })

    expect(__getMeasureLinesCountForTest() - before).toBe(0)
    // Same row fact, two caps: the compact box is capped, the full one is not.
    expect(compact.totalLines).toBe(3)
    expect(compact.heightLines).toBe(2)
    expect(compact.isScrollable).toBe(true)
    expect(full.totalLines).toBe(3)
    expect(full.heightLines).toBe(3)
    expect(full.isScrollable).toBe(false)
    expect(columnCount).toBe(NARROW_WRAP_WIDTH - MULTILINE_INPUT_HORIZONTAL_PADDING)
  })

  test('a row count with no identity is measured locally instead', () => {
    // A count with no binding to any value/width cannot be reconciled with what
    // is on screen, so presence alone must not earn trust.
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 2,
      maxHeight: 5,
    })

    expect(metrics.totalLines).toBe(3)
  })

  test('a forwarded row count is scrollable when the caller cap is the tighter one', () => {
    // The shipped split: chat.tsx measures PRE-CLAMP rows and forwards them, and
    // its own layout clamps to half the terminal height. A box whose own
    // maxHeight happens to be taller must still report the content as
    // scrollable, because the caller's layout already decided it scrolls.
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 3,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      callerHeightCap: 2,
      maxHeight: 10,
    })

    expect(metrics.totalLines).toBe(3)
    expect(metrics.heightLines).toBe(3)
    expect(metrics.isScrollable).toBe(true)
  })

  test('without a caller cap the box own maxHeight decides scrollability', () => {
    const metrics = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      measuredTotalLines: 3,
      measurementKey: measuredKey(UNBROKEN_TOKEN, NARROW_WRAP_WIDTH),
      maxHeight: 10,
    })

    expect(metrics.isScrollable).toBe(false)
  })

  test('two boxes at different wrap widths in one frame each keep their own placeholder rows', () => {
    // The shipped frame: chat-input-bar mounts MultilineInput in its compact and
    // its full-height branch, and both call computeMultilineInputHeight with an
    // empty value, so both go through the placeholder path. The memo is
    // per-instance (the component holds one in a useRef), so the second box must
    // NOT warm-read the first box's rows: a count measured at the compact box's
    // columns would mis-size a box drawn at the wide one.
    const wideWrapWidth = MULTILINE_INPUT_HORIZONTAL_PADDING + 40
    const placeholder = UNBROKEN_TOKEN
    const compactMemo = createPlaceholderLineMemo()
    const wideMemo = createPlaceholderLineMemo()

    const compact = computeMultilineInputHeight({
      value: '',
      placeholder,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: compactMemo,
      maxHeight: 5,
    })
    const wide = computeMultilineInputHeight({
      value: '',
      placeholder,
      wrapWidth: wideWrapWidth,
      placeholderMemo: wideMemo,
      maxHeight: 5,
    })

    // Independent local measurements of the same placeholder at each width: the
    // compact box wraps to three rows, the wide one to one.
    const compactLocal = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      maxHeight: 5,
    })
    const wideLocal = computeMultilineInputHeight({
      value: UNBROKEN_TOKEN,
      wrapWidth: wideWrapWidth,
      maxHeight: 5,
    })

    expect(compact.totalLines).toBe(3)
    expect(compact.heightLines).toBe(3)
    expect(wide.totalLines).toBe(1)
    expect(wide.heightLines).toBe(1)
    expect(compact.totalLines).toBe(compactLocal.totalLines)
    expect(compact.heightLines).toBe(compactLocal.heightLines)
    expect(wide.totalLines).toBe(wideLocal.totalLines)
    expect(wide.heightLines).toBe(wideLocal.heightLines)
  })

  test('one memo warm at one width does not answer for another width', () => {
    // The collision the module-level slot allowed: the same memo object reused
    // across widths must re-measure, because the memo key includes the columns.
    const wideWrapWidth = MULTILINE_INPUT_HORIZONTAL_PADDING + 40
    const memo = createPlaceholderLineMemo()

    const narrow = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: memo,
      maxHeight: 5,
    })
    const wide = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: wideWrapWidth,
      placeholderMemo: memo,
      maxHeight: 5,
    })

    expect(narrow.totalLines).toBe(3)
    expect(wide.totalLines).toBe(1)
  })

  test('an idle frame with no placeholder drawn costs no wrap pass and keys no memo entry', () => {
    // Exactly what MultilineInput hands over when it is NOT in placeholder
    // state: `multilineInputPlaceholderArg(false, ...)` is `undefined`, never
    // ''. With the caller's space measurement matching, the whole idle frame is
    // free — and the placeholder memo keeps its initial, unkeyed entry instead
    // of being keyed on a string the box never draws.
    const memo = createPlaceholderLineMemo()

    const render = () =>
      computeMultilineInputHeight({
        value: '',
        placeholder: undefined,
        wrapWidth: NARROW_WRAP_WIDTH,
        placeholderMemo: memo,
        measuredTotalLines: 1,
        measurementKey: multilineInputMeasurementKey(' ', measuredKeyColumns()),
        maxHeight: 5,
      })

    const before = __getMeasureLinesCountForTest()
    for (let renderIndex = 0; renderIndex < 3; renderIndex += 1) {
      expect(render().totalLines).toBe(1)
    }

    expect(__getMeasureLinesCountForTest() - before).toBe(0)
    expect(memo.key).toBe('')
  })

  test('a second box with its own memo starts cold for the same placeholder and width', () => {
    // The per-instance contract, priced: the memo belongs to the mounted box, so
    // two boxes drawing the same placeholder at the same width each pay their
    // own first measurement. A process-wide slot would answer the second box
    // without measuring — which is exactly how one instance reads another's
    // entry.
    const firstMemo = createPlaceholderLineMemo()
    const secondMemo = createPlaceholderLineMemo()

    const first = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: firstMemo,
      maxHeight: 5,
    })
    expect(first.totalLines).toBe(3)

    const before = __getMeasureLinesCountForTest()
    const second = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: secondMemo,
      maxHeight: 5,
    })

    expect(__getMeasureLinesCountForTest() - before).toBe(1)
    expect(second.totalLines).toBe(first.totalLines)

    // And the second box now holds its OWN entry, so its repeat render is free.
    const warmBefore = __getMeasureLinesCountForTest()
    const repeat = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: secondMemo,
      maxHeight: 5,
    })

    expect(__getMeasureLinesCountForTest() - warmBefore).toBe(0)
    expect(repeat.totalLines).toBe(first.totalLines)
  })

  test('a second box at another wrap width measures its own rows with its own memo', () => {
    // Two boxes in one frame, each with the memo its own instance owns: the
    // wide box must measure at its own columns rather than reuse the compact
    // box's three-row answer.
    const wideWrapWidth = MULTILINE_INPUT_HORIZONTAL_PADDING + 40
    const compactMemo = createPlaceholderLineMemo()
    const wideMemo = createPlaceholderLineMemo()

    const compact = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: compactMemo,
      maxHeight: 5,
    })
    expect(compact.totalLines).toBe(3)

    const before = __getMeasureLinesCountForTest()
    const wide = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: wideWrapWidth,
      placeholderMemo: wideMemo,
      maxHeight: 5,
    })

    // One cold pass at the wide width, and the answer is the wide box's own row
    // count — not the compact box's three.
    expect(__getMeasureLinesCountForTest() - before).toBe(1)
    expect(wide.totalLines).toBe(1)

    // Both memos then answer for their own width without measuring again.
    const warmBefore = __getMeasureLinesCountForTest()
    const compactRepeat = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: NARROW_WRAP_WIDTH,
      placeholderMemo: compactMemo,
      maxHeight: 5,
    })
    const wideRepeat = computeMultilineInputHeight({
      value: '',
      placeholder: UNBROKEN_TOKEN,
      wrapWidth: wideWrapWidth,
      placeholderMemo: wideMemo,
      maxHeight: 5,
    })

    expect(__getMeasureLinesCountForTest() - warmBefore).toBe(0)
    expect(compactRepeat.totalLines).toBe(3)
    expect(wideRepeat.totalLines).toBe(1)
  })

  test('the narrowest wrap widths keep a stable memo key so the idle frame stays free', () => {
    // The padding floor is where the memo key is most likely to drift: wrapWidth
    // at the padding leaves one column of text, and one column above it leaves
    // none of the padding slack. Either way the derived columns — and therefore
    // the key — are stable across renders, so the idle frame costs no wrap pass.
    for (const wrapWidth of [
      MULTILINE_INPUT_HORIZONTAL_PADDING,
      MULTILINE_INPUT_HORIZONTAL_PADDING + 1,
    ]) {
      const memo = createPlaceholderLineMemo()
      const wrapColumns = Math.max(
        1,
        wrapWidth - MULTILINE_INPUT_HORIZONTAL_PADDING,
      )

      const render = () =>
        computeMultilineInputHeight({
          value: '',
          placeholder: UNBROKEN_TOKEN,
          wrapWidth,
          placeholderMemo: memo,
          measuredTotalLines: 1,
          measurementKey: multilineInputMeasurementKey(' ', wrapColumns),
          maxHeight: 5,
        })

      const warmed = render()
      // A 25-column token in one column of text is many rows; the assertion is
      // that the count is stable, not that it has any particular value.
      expect(warmed.totalLines).toBeGreaterThan(1)

      const before = __getMeasureLinesCountForTest()
      for (let renderIndex = 0; renderIndex < 5; renderIndex += 1) {
        const metrics = render()
        expect(metrics.totalLines).toBe(warmed.totalLines)
        expect(metrics.heightLines).toBe(warmed.heightLines)
      }

      expect(__getMeasureLinesCountForTest() - before).toBe(0)
    }
  })
})

/**
 * The one wrap pass per keystroke is only real if the SHIPPED components forward
 * the caller's measurement: chat.tsx measures the value once and hands the row
 * count and gutter decision to ChatInputBar, which forwards both (plus the wrap
 * width) into MultilineInput, which hands them to computeMultilineInputHeight.
 *
 * The helper-driven baseline in utils/__tests__/text-layout.test.ts supplies
 * those values itself, so deleting either forwarding hop would leave
 * `expect(passes).toBe(1)` green while restoring a second full O(n) wrap of the
 * same value on every keystroke. MultilineInput cannot be rendered under bun's
 * tsx runner without the OpenTUI app context (`useRenderer`/`useAppContext`), so
 * this pins the wiring at the call sites themselves: each hop's props must be
 * present and must carry the measured values.
 */
describe('input layout measurement wiring', () => {
  const componentsDir = path.join(import.meta.dir, '..')
  const srcDir = path.join(componentsDir, '..')

  const readSource = (relativePath: string): string =>
    fs.readFileSync(path.join(srcDir, relativePath), 'utf8')

  /**
   * Each JSX element starting at `marker`, up to its closing `/>`.
   *
   * A plain `indexOf(marker)` also matches marker text that is not a JSX tag: a
   * generic type argument such as `MutableRefObject<MultilineInputHandle>`
   * contains the substring `<MultilineInput`. When the marker ends in a tag
   * name, skip any occurrence that continues into an identifier so type
   * positions cannot be counted as call sites.
   */
  const jsxBlocks = (source: string, marker: string): string[] => {
    const endsWithTagName = /[A-Za-z0-9_$]$/.test(marker)
    const blocks: string[] = []
    for (
      let index = source.indexOf(marker);
      index !== -1;
      index = source.indexOf(marker, index + marker.length)
    ) {
      if (endsWithTagName) {
        const next = source[index + marker.length]
        if (next !== undefined && /[A-Za-z0-9_$]/.test(next)) continue
      }
      const end = source.indexOf('/>', index)
      blocks.push(source.slice(index, end === -1 ? source.length : end))
    }
    return blocks
  }

  test('chat.tsx forwards the metrics it measured into ChatInputBar', () => {
    const blocks = jsxBlocks(readSource('chat.tsx'), '<ChatInputBar')

    expect(blocks).toHaveLength(1)
    // The forwarded numbers must be the ones from the memoized measurement, not
    // a freshly computed or re-derived value.
    expect(blocks[0]).toContain(
      'inputTotalLines={inputLayoutMetrics.totalLines}',
    )
    expect(blocks[0]).toContain(
      'inputGutterEnabled={inputLayoutMetrics.gutterEnabled}',
    )
    // The reserved width is the other half of the agreement: without it the box
    // falls back to lineInfoLines and the row-count agreement is an equation
    // the production path never exercises.
    expect(blocks[0]).toContain('inputWidth={inputWidth}')
  })

  test('ChatInputBar forwards the measurement into every MultilineInput', () => {
    const blocks = jsxBlocks(readSource('components/chat-input-bar.tsx'), '<MultilineInput')

    // Both call sites (compact and normal height) must forward it: one skipped
    // hop is enough to restore the second wrap on that rendering path.
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      expect(block).toContain('measuredTotalLines={inputTotalLines}')
      expect(block).toContain('measuredGutterEnabled={inputGutterEnabled}')
      expect(block).toContain('wrapWidth={inputWidth}')
    }
  })

  test('the producer measures pre-clamp and the box is told its cap', () => {
    // The scrollability invariant is only restorable if these three hold: the
    // caller's row count is NOT pre-clamped to its own cap, the caller forwards
    // its effective cap alongside the count, and the box forwards that cap into
    // the one height computation.
    const chat = jsxBlocks(readSource('chat.tsx'), '<ChatInputBar')
    expect(chat).toHaveLength(1)
    expect(chat[0]).toContain('inputInputCap={inputHeightLines}')

    const source = readSource('chat.tsx')
    expect(source).toContain('maxHeight: Number.MAX_SAFE_INTEGER,')

    const barBlocks = jsxBlocks(readSource('components/chat-input-bar.tsx'), '<MultilineInput')
    expect(barBlocks).toHaveLength(2)
    for (const block of barBlocks) {
      expect(block).toContain('callerHeightCap={inputInputCap}')
    }

    const inputSource = readSource('components/multiline-input.tsx')
    const call = jsxBlocks(inputSource, 'computeMultilineInputHeight({')
    expect(call).toHaveLength(1)
    expect(call[0]).toContain('callerHeightCap,')
  })

  test('the scroll offset is re-clamped even while the box is unfocused', () => {
    // stickyScroll is gone, so a focus-gated effect left an unfocused box whose
    // content shrank holding an offset above the new maxTop until the next focus.
    const source = readSource('components/multiline-input.tsx')
    expect(source).toContain('if (!focused) {')
    expect(source).toContain('const clampedTop = clamp(currentTop, 0, maxTop)')
  })

  test('MultilineInput owns the placeholder memo per instance', () => {
    const source = readSource('components/multiline-input.tsx')
    // The memo must be component state, not module state: a module-level slot is
    // shared by every mounted box and lets one read another's placeholder rows.
    expect(source).toContain('useRef(createPlaceholderLineMemo())')
    expect(source).toContain('placeholderMemo: placeholderMemoRef.current,')
  })

  test('MultilineInput hands the forwarded props to the height computation', () => {
    const source = readSource('components/multiline-input.tsx')
    const call = jsxBlocks(source, 'computeMultilineInputHeight({')

    expect(call).toHaveLength(1)
    // Shorthand properties: the forwarded props must reach the one height
    // computation, otherwise it silently re-wraps the value itself.
    expect(call[0]).toContain('wrapWidth,')
    expect(call[0]).toContain('measuredTotalLines,')
    expect(call[0]).toContain('measuredGutterEnabled,')
    // The identity binding is part of the contract: without it a forwarded count
    // would be trusted for whatever happens to be rendering.
    expect(call[0]).toContain('measurementKey:')
  })

  test('the placeholder argument is undefined, never an empty string, when nothing is drawn', () => {
    const source = readSource('components/multiline-input.tsx')
    const call = jsxBlocks(source, 'computeMultilineInputHeight({')

    expect(call).toHaveLength(1)
    // The one height computation takes its placeholder from the shipped
    // expression, not from a second inline ternary that can drift away from it.
    expect(call[0]).toContain('placeholder: multilineInputPlaceholderArg(')
    expect(call[0]).toContain('isPlaceholder,')
    expect(call[0]).toContain('displayValueForRendering,')
    // And that expression answers `undefined` — not '' — when no placeholder is
    // drawn, so the idle memo namespace is keyed on the real drawn string.
    expect(multilineInputPlaceholderArg(false, 'drawn')).toBeUndefined()
    expect(multilineInputPlaceholderArg(true, 'drawn')).toBe('drawn')
  })

  test('the drawn text expansion allocates nothing when there is no tab', () => {
    // The idle frame's cost gate: the memo made the placeholder's WRAP free, but
    // `displayValue.replace(/\t/g, ...)` still copied the whole drawn string on
    // every render — and that fresh identity also re-ran the scroll effect. The
    // fast path must hand back the SAME reference when no tab is present, which
    // is what makes both costs zero. `toBe` is identity, not equality: `toEqual`
    // would pass on a fresh copy with the same characters.
    const drawn = 'Send a message — @ to mention a file, / for commands'
    expect(expandTabsForRendering(drawn)).toBe(drawn)
    // An empty drawn string is still the same reference, so the idle frame with
    // no placeholder allocates only nothing at all.
    const empty = ''
    expect(expandTabsForRendering(empty)).toBe(empty)

    // Tabs ARE expanded, at the component's four-column tab width.
    expect(expandTabsForRendering('a\tb')).toBe('a    b')
    expect(expandTabsForRendering('\t')).toBe('    ')
    expect(expandTabsForRendering('a\tb\tc')).toBe('a    b    c')
  })

  test('the wrap columns the box derives from a reserved width stay one helper', () => {
    // The height computation, the memo key and the forwarded-measurement
    // identity all name the same columns, so the derivation lives in one place.
    expect(multilineInputWrapColumns(undefined)).toBeUndefined()
    expect(multilineInputWrapColumns(NARROW_WRAP_WIDTH)).toBe(
      measuredKeyColumns(),
    )
    // The padding floor never yields zero columns, which is what keeps the memo
    // key stable at the narrowest widths.
    expect(multilineInputWrapColumns(MULTILINE_INPUT_HORIZONTAL_PADDING)).toBe(1)
  })

  test('the scroll effect keys on the wrapped rows, not on the text identities', () => {
    // Re-clamping is only legal when the wrapped row count, the wrap width or
    // the box height can have moved the reachable scroll range. Keying the
    // effect on `value`/`displayValueForRendering` compared two full-length
    // strings per render and re-read the viewport on keystrokes that changed no
    // row. The dependency list itself is the observable here, since rendering
    // the box needs the OpenTUI app context.
    const source = readSource('components/multiline-input.tsx')
    // Anchor on the auto-scroll effect itself, not the file's first useEffect:
    // slicing from the first `useEffect(() => {` and stopping at the first
    // `}, [...])` picked up an unrelated earlier effect (deps `value`,
    // `cursorPosition`) and read its dependency list instead of this one's.
    const effectStart = source.indexOf('// Auto-scroll to cursor when content changes')
    expect(effectStart).toBeGreaterThan(-1)

    const effectDeps = /\n  \}, \[([\s\S]*?)\n  \]\)/.exec(
      source.slice(effectStart),
    )

    expect(effectDeps).not.toBeNull()
    const deps = (effectDeps?.[1] ?? '')
      .split(',')
      .map((dep) => dep.trim())
      .filter(Boolean)

    expect(deps).toContain('layoutMetrics.totalLines')
    expect(deps).toContain('layoutMetrics.heightLines')
    expect(deps).toContain('wrapWidth')
    expect(deps).toContain('focused')
    expect(deps).toContain('cursorRow')
    // The text identities are exactly what must NOT be in it.
    expect(deps).not.toContain('value')
    expect(deps).not.toContain('displayValueForRendering')
  })
})
