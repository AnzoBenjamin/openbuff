import stringWidth from 'string-width'

// Printable ASCII is exactly one column per code unit, so measuring it never
// needs string-width's grapheme segmentation.
const ASCII_PRINTABLE_REGEX = /^[\x20-\x7e]*$/

/**
 * Width of a run of text. The ASCII fast path is what keeps BOTH measurement
 * sites here off the grapheme-segmentation path for ordinary text: the
 * per-keystroke input measurement and the per-render message wrap; anything
 * else (wide CJK, combining marks, control characters) still goes through
 * string-width so wrapping stays correct.
 *
 * Exported so every wrap implementation in this module measures the way this
 * one does. Two width sources that disagree is exactly how a measured row
 * count stops equalling the rows the box actually renders.
 */
let measureWidthCalls = 0
let stringWidthCalls = 0

/**
 * The non-ASCII measurement path, counted separately.
 *
 * This is where the real per-grapheme cost of `string-width` lives, and it is
 * deliberately NOT the same seam as `measureWidthCalls`: that counter increments
 * once per CALL, so a per-token scan and a per-code-unit scan report wildly
 * different counts while the segmentation work inside one call stays invisible.
 * Counting the `string-width` invocations themselves makes the segmentation
 * observable — an oversize non-ASCII token is measured once as a span and then
 * once per grapheme, so this counter moves with the grapheme count rather than
 * with the token count.
 */
function measureNonAsciiWidth(segment: string): number {
  stringWidthCalls += 1
  return stringWidth(segment)
}

/**
 * Side channel for the wrap fast path: set by the most recent `measureWidth`
 * call. Single-threaded synchronous usage only — the reader consumes it
 * immediately after its own `measureWidth` call, before any other measurement
 * can interleave (the same non-reentrancy contract the sticky matchers above
 * carry).
 */
let lastMeasureWidthWasAscii = false

export function measureWidth(segment: string): number {
  measureWidthCalls += 1
  if (ASCII_PRINTABLE_REGEX.test(segment)) {
    lastMeasureWidthWasAscii = true
    return segment.length
  }
  lastMeasureWidthWasAscii = false
  return measureNonAsciiWidth(segment)
}

/**
 * Whether a segment is entirely printable ASCII — the one class that is
 * exactly one column per code unit, and therefore the only class the wrap
 * fast path may hard-wrap by code-unit subtraction. Exported so the test
 * file's reference oracle shares this exact gate instead of restating it
 * (restating it as `length === width` is precisely the astral-segment bug).
 */
export function isPrintableAscii(segment: string): boolean {
  return ASCII_PRINTABLE_REGEX.test(segment)
}

/**
 * Rendered columns of the code point starting at `index`. Callers walking a
 * string pass the code point they already decoded, so this stays a charCode
 * range test for ASCII (one column, no string-width call) and only pays for
 * string-width on the non-ASCII code points that actually need measuring.
 */
function measureCodePointWidth(
  text: string,
  index: number,
  codePoint: number,
): number {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return 1
  const charSize = codePoint > 0xffff ? 2 : 1
  return measureNonAsciiWidth(text.slice(index, index + charSize))
}

let measureLinesCount = 0

/**
 * Test seam: how many wrap passes `measureLines` has run. The render path is
 * meant to measure a keystroke's value exactly once and hand that row count to
 * every consumer, so pinning the pass count makes "one wrap pass instead of one
 * per consumer" a structural, regression-checked invariant: a change that
 * reintroduces a wrap per consumer would keep every row count right while
 * restoring the extra passes.
 *
 * This is a structure guard, not cost evidence: it counts passes and never
 * their price, so it stays green under any constant-factor regression inside a
 * pass. The wall-clock baseline in `cli/utils/__tests__/text-layout.test.ts`
 * records per-keystroke cost and gates a deliberately loose order-of-magnitude
 * ratio, so it catches a gross regression but is not a tight parity bound.
 */
export function __getMeasureLinesCountForTest(): number {
  return measureLinesCount
}

/**
 * Test seam: how many times `measureWidth` was called.
 *
 * This is a SPAN-COUNT EQUIVALENCE guard, not cost evidence, and it must not be
 * read as one. It counts calls into the width measurer — one per token span the
 * scan cuts — so it pins that the index scan cuts the same spans as the
 * `split(/(\s+)/)` tokenizer it replaced: a per-code-unit scan, or a span
 * boundary off by one, moves this count before it moves any row count. It says
 * NOTHING about the price of a call: `measureWidth` delegates non-ASCII runs to
 * `string-width`, whose per-grapheme segmentation this counter cannot see, and
 * the equality against the reference holds by construction for any per-token
 * implementation. `__getStringWidthCallsForTest` is the seam that observes that
 * segmentation work.
 */
export function __getMeasureWidthCallsForTest(): number {
  return measureWidthCalls
}

/**
 * Test seam: how many `string-width` calls the module has made, i.e. how much
 * grapheme segmentation it has actually paid for.
 *
 * This is the COST side of the non-ASCII path, and it is the one the width-call
 * counter above cannot report: an oversize non-ASCII token is measured once as
 * a span and then once per grapheme (the `Array.from` loop in `appendSegment`),
 * and the code-point walk in `wrapTextToVisualLines` measures once per non-ASCII
 * code point. A constant-factor regression inside that path — dropping the
 * per-grapheme loop, or measuring a run once and trusting the total — changes
 * this count while leaving every width-call count, row count and pass count
 * identical. It prices calls, not their inner work, so it is a bound rather
 * than an exact figure: the wall-clock baseline in
 * `cli/utils/__tests__/text-layout.test.ts` is what catches a slower call.
 */
export function __getStringWidthCallsForTest(): number {
  return stringWidthCalls
}

let measureLinesTokenSlices = 0
let measureLinesTokenChars = 0

/**
 * Test seam: how many per-token strings `measureLines` has sliced out.
 *
 * This is a SELF-CONSISTENCY INVARIANT, not an allocation gate. The scan slices
 * exactly one string per emitted token — the span the width measurer needs — so
 * this counter must equal the number of tokens the scan visits, and the
 * assertion in `cli/utils/__tests__/text-layout.test.ts` is that one slice per
 * token identity. It observes that the scan emits the spans it says it does; it
 * does NOT observe allocation, because a second per-token string materialised
 * for any other purpose (a lower-cased probe, a trimmed copy) leaves this count
 * untouched. `__getMeasureLinesTokenCharsForTest` below is the allocation-volume
 * seam that does see those.
 */
export function __getMeasureLinesTokenSlicesForTest(): number {
  return measureLinesTokenSlices
}

/**
 * Test seam: how many characters `measureLines` has copied into per-token
 * slices.
 *
 * The allocation VOLUME, and the reason it is a separate seam from the slice
 * count: each character of the value except newlines — a newline is a row
 * break, never part of a token — is sliced out exactly once as the scan walks
 * the value token by token, so the characters copied equal the value's length
 * minus its newline count. That budget comes from the WORKLOAD rather than from
 * the reference tokenizer's token list, so it is not circular: a second
 * per-token copy of any size (a prefix, a lower-cased probe, a trimmed string)
 * doubles this total while leaving the slice count — and every row count —
 * unchanged.
 */
export function __getMeasureLinesTokenCharsForTest(): number {
  return measureLinesTokenChars
}

/**
 * Whether a single code unit is whitespace in the sense the tokenizer uses.
 *
 * `\s` is the exact class `split(/(\s+)/)` broke tokens on - `\v`, `\f`, `\r`
 * and the unicode space separators included - so the index scan below has to
 * ask the same question, or a whitespace run would be cut where it used to stay
 * whole and the row count would drift. The class is spelled out as code-unit
 * range tests rather than a per-character regex: `charAt` plus a regex test per
 * code unit allocated one throwaway string per character on the keystroke path,
 * which is a cost the native `split` never paid. Surrogate code units are never
 * whitespace under `\s`, so testing the code unit alone stays correct for
 * astral characters too.
 *
 * EXACTLY the ECMAScript `\s` set — NEL (`0x0085`) NOT included: `/\s/` skips
 * the whole C1 range. The classifier only picks which of the two complementary
 * sticky matchers to read, so any code unit it calls whitespace that `\S` also
 * matches (or vice versa) makes the matcher's run longer than the classifier
 * expects and the scan falls into its one-character fallback: a per-character
 * slice and width measurement on the keystroke path, reachable from pasted
 * content. The test suite pins the two sets against each other for every code
 * unit, so a future divergence fails at this seam rather than degrading the
 * keystroke path.
 */
export function isWhitespaceCodeUnit(code: number): boolean {
  if (code <= 0x20) {
    return code === 0x20 || (code >= 0x09 && code <= 0x0d)
  }
  // 0x21-0x7e (printable ASCII) and the whole C1 range 0x7f-0x9f — NEL
  // (0x85) included — are not whitespace under `\s`.
  if (code < 0xa0) return false
  switch (code) {
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
      return true
    default:
      return code >= 0x2000 && code <= 0x200a
  }
}

/**
 * Whether the code unit at `index` is whitespace in the sense the tokenizer
 * uses. An out-of-range index reads as `NaN`, which every branch above rejects,
 * so callers can probe the boundary without a separate bounds branch here.
 */
function isWhitespaceAt(text: string, index: number): boolean {
  return isWhitespaceCodeUnit(text.charCodeAt(index))
}

/**
 * Sticky run matchers used to walk the value one token at a time.
 *
 * `\s` / `\S` are the exact class `split(/(\s+)/)` broke tokens on and the same
 * one `isWhitespaceCodeUnit` spells out, so the spans are identical by
 * construction; the difference is who scans them. A sticky match advances
 * through the run inside the engine, whereas classifying each code unit in JS
 * paid one call per character. The render-path wall-clock baseline caught that
 * difference: on a long unbroken token (a pasted path, the fixed ASCII
 * workload) the per-code-unit loop measured slower than the `split` tokenizer
 * this scan replaced, which is a regression the operation-count seams could not
 * see.
 *
 * NON-REENTRANCY INVARIANT, and the reason these two module-level matchers carry
 * mutable `lastIndex` state at all: `lastIndex` is assigned immediately before
 * the one `exec` that reads it, with NO `await`, callback, or user code allowed
 * between the two statements. That is what makes a shared sticky matcher safe —
 * nothing can interleave, because there is nothing to interleave with. These are
 * deliberately NOT made per-call: allocating a fresh `RegExp` per token would
 * pay regex compilation on the per-keystroke path, which is the cost the scan
 * exists to avoid. Both matchers are used only by `measureLines`, which is
 * wholly synchronous, so the invariant holds today. Any change that introduces
 * an interleaving point — an `await`, a yield, or a call into code that measures
 * recursively — between the `lastIndex` assignment and its `exec` must instead
 * move the matchers to per-call scope (unlike the filesystem fan-out elsewhere,
 * which routes shared work through an explicit gate rather than relying on this
 * invariant).
 */
const WHITESPACE_RUN_PATTERN = /\s+/y
const NON_WHITESPACE_RUN_PATTERN = /\S+/y

/**
 * Cursor row accounting filled in by the wrap pass: `offset` is the cursor's
 * code-unit index and `breaksBefore` counts the hard wraps that place it on a
 * later visual row.
 *
 * The only consumer is the two-row gutter case, which needs one number. A
 * recorded position per row made every keystroke grow an array the multi-row
 * shapes (a pasted value is ~100 rows at a narrow width) then discarded, so the
 * pass now counts instead of collecting.
 */
type CursorRowState = { offset: number; breaksBefore: number }

// Keep measurement logic centralised so components can share consistent wrap behavior.
function measureLines(
  text: string,
  cols: number,
  cursor?: CursorRowState,
): number {
  measureLinesCount += 1
  if (text.length === 0) return 1

  let lines = 1
  let current = 0

  // `breakAt` is the code-unit index of the character whose INCLUSION in a
  // prefix puts the cursor on the next visual row: the `\n` that ends a row, or
  // the first character of a hard-wrapped row. Comparing it against the caller's
  // cursor offset here lets the caller derive the cursor's row from this one
  // pass instead of re-wrapping the value prefix.
  const emitHardWrap = (breakAt: number) => {
    lines += 1
    current = 0
    if (cursor && breakAt < cursor.offset) cursor.breaksBefore += 1
  }

  const appendSegment = (
    segment: string,
    segmentStart: number,
    { flushBeforeOversize = true }: { flushBeforeOversize?: boolean } = {},
  ) => {
    if (!segment) return

    // Width + ASCII-ness in ONE regex pass (the same pass measureWidth's own
    // fast path runs): the oversize hard-wrap gate below needs the ASCII
    // verdict anyway, and running the regex twice per segment (once in
    // measureWidth, once in the gate) measurably tightened the wall-clock
    // baseline's headroom. A printable-ASCII segment is exactly one column
    // per code unit, so it hard-wraps by subtraction; the ASCII CLASS is the
    // gate, NOT `segment.length === segmentWidth` — that equality also holds
    // for an all-astral segment (2 code units per 2-column grapheme), which
    // would then break surrogate pairs mid-character.
    const segmentWidth = measureWidth(segment)
    const isAsciiSegment = lastMeasureWidthWasAscii
    if (segmentWidth > cols) {
      if (flushBeforeOversize && current > 0) emitHardWrap(segmentStart)
      if (isAsciiSegment) {
        let remaining = segment.length
        let offset = 0
        while (remaining > cols && cols > 0) {
          offset += cols
          emitHardWrap(segmentStart + offset)
          remaining -= cols
        }
        current = remaining
        return
      }
      let acc = 0
      let offset = 0
      for (const ch of Array.from(segment)) {
        const w = measureWidth(ch)
        if (acc + w > cols) {
          emitHardWrap(segmentStart + offset)
          acc = 0
        }
        acc += w
        offset += ch.length
      }
      current = acc
      return
    }

    if (current + segmentWidth > cols) emitHardWrap(segmentStart)
    current += segmentWidth
  }

  // Every keystroke measures the whole value, so splitting the string up front
  // allocated a token array proportional to the value before the first width
  // was known. Scanning by index emits the same spans one at a time, so only
  // the token about to be measured is ever held. Each span carries its offset in
  // `text` so the row breaks it produces are real indices, not token numbers.
  //
  // One string per token is still sliced out, and only where the width measurer
  // needs the span. The token's newline presence now comes out of the run match
  // rather than a second `includes('\n')` scan of the token, so a single-line
  // token never enters the multi-line branch and a multi-line run walks its
  // lines by index instead of allocating `split('\n')`'s array. Both test-suite
  // seams around this scan are correctness guards, not cost evidence: the
  // width-call count pins span-for-span equivalence with the `split(/(\s+)/)`
  // scan, and the pass count pins one wrap per keystroke. The cost of this
  // shape — what the rewrite removes (the up-front token array, the
  // per-character `charAt` + regex whitespace test, the per-token newline probe
  // and the per-line split array) — is measured in wall-clock terms by the
  // render-path baseline in the same suite, which times this scan directly
  // against the pre-change `legacyMeasureLines` and gates the ratio. If this
  // scan's constant factor is ever revisited, that gate is what fails, and the
  // printed medians are the numbers to re-record.
  let tokenStart = 0
  while (tokenStart < text.length) {
    const whitespaceRun = isWhitespaceAt(text, tokenStart)
    // The run is located by the engine rather than by classifying every code
    // unit in it. The single classification above only decides which of the two
    // complementary runs to read, so `exec` always matches at `tokenStart` here;
    // the clamp is unreachable defensive width, not a semantic branch.
    const runPattern = whitespaceRun
      ? WHITESPACE_RUN_PATTERN
      : NON_WHITESPACE_RUN_PATTERN
    runPattern.lastIndex = tokenStart
    const runMatch = runPattern.exec(text)
    const tokenEnd = runMatch
      ? tokenStart + runMatch[0].length
      : Math.min(tokenStart + 1, text.length)

    // Newline presence comes out of the run classification instead of a second
    // scan of the token: `\n` (0x0a) is whitespace under the class above, so it
    // can only ever appear inside a whitespace run. Reading it off the matched
    // run here replaces the per-token `token.includes('\n')` probe — one full
    // re-scan of every token on the per-keystroke path.
    const runHasNewline =
      whitespaceRun && runMatch !== null && runMatch[0].includes('\n')
    const tokenOffset = tokenStart
    tokenStart = tokenEnd

    if (runHasNewline) {
      // Multi-line run: the lines are walked by index over `text` and a line
      // substring is materialised only for the widths `appendSegment` actually
      // measures, so a paste of N lines no longer allocates an array plus N
      // substrings per keystroke. The whole token is still sliced exactly once
      // when it needs measuring as a span (the single-line case), which is what
      // keeps the one-slice-per-token invariant below.
      let lineStart = tokenOffset
      while (lineStart < tokenEnd) {
        const newlineAt = text.indexOf('\n', lineStart)
        const lineEnd =
          newlineAt === -1 || newlineAt >= tokenEnd ? tokenEnd : newlineAt
        if (lineEnd > lineStart) {
          appendSegment(
            text.slice(lineStart, lineEnd),
            lineStart,
            { flushBeforeOversize: false },
          )
          measureLinesTokenSlices += 1
          measureLinesTokenChars += lineEnd - lineStart
        }
        if (lineEnd >= tokenEnd) break
        // The `\n` itself sits at lineEnd; including it is what moves a prefix
        // onto the next row, so that index is the row break.
        emitHardWrap(lineEnd)
        lineStart = lineEnd + 1
      }
      continue
    }

    // Only a token the width measurer is about to be called on is sliced, and
    // exactly one slice per emitted token: the two self-consistency invariants
    // the test suite pins (`slices` against the token count, `tokenChars`
    // against the value's length). Taking it here rather than before the branch
    // means a multi-line run pays only for the lines it measures.
    const token = text.slice(tokenOffset, tokenEnd)
    measureLinesTokenSlices += 1
    measureLinesTokenChars += token.length

    appendSegment(token, tokenOffset)
  }

  return lines
}

export function wrapTextToVisualLines(text: string, cols: number): string[] {
  const safeCols = Math.max(1, Math.floor(cols))
  const lines: string[] = []

  const appendWrappedLine = (line: string) => {
    if (line.length === 0) {
      lines.push('')
      return
    }

    const tokens = line.split(/(\s+)/)
    let current = ''
    let currentWidth = 0

    const pushLine = () => {
      lines.push(current)
      current = ''
      currentWidth = 0
    }

    const appendSegment = (segment: string) => {
      if (!segment) return
      const segWidth = measureWidth(segment)

      if (segWidth > safeCols) {
        // Oversize token: walk code points and cut each visual row with one
        // slice() instead of concatenating a grapheme at a time. ASCII code
        // points are one column each and skip string-width entirely, so a long
        // pasted path costs one pass over the characters plus one slice per
        // row instead of one string-width call and one string per character.
        let lineStart = 0
        for (let index = 0; index < segment.length; ) {
          const codePoint = segment.codePointAt(index) ?? 0
          const charWidth = measureCodePointWidth(segment, index, codePoint)
          if (currentWidth + charWidth > safeCols) {
            const filled = current + segment.slice(lineStart, index)
            if (filled.length > 0) {
              lines.push(filled)
              current = ''
              currentWidth = 0
              lineStart = index
            }
          }
          index += codePoint > 0xffff ? 2 : 1
          currentWidth += charWidth
        }
        current += segment.slice(lineStart)
        return
      }

      if (currentWidth + segWidth > safeCols && current.length > 0) pushLine()
      current += segment
      currentWidth += segWidth
    }

    for (const token of tokens) {
      appendSegment(token)
    }

    if (current.length > 0 || lines.length === 0) pushLine()
  }

  text.split('\n').forEach(appendWrappedLine)
  return lines
}

export function wrapTextPreservingNewlines(text: string, cols: number): string {
  return wrapTextToVisualLines(text, cols).join('\n')
}

export function getLastNVisualLines(
  text: string,
  cols: number,
  n: number,
): { lines: string[]; hasMore: boolean } {
  if (n <= 0 || cols <= 0) return { lines: [], hasMore: false }
  if (!text) return { lines: [], hasMore: false }

  const lines = wrapTextToVisualLines(text, cols)
  const hasMore = lines.length > n
  const lastLines = lines.slice(-n)
  return { lines: lastLines, hasMore }
}

export function computeInputLayoutMetrics({
  layoutContent,
  cursorOffset,
  cols,
  maxHeight,
  minHeight = 1,
}: {
  layoutContent: string
  /**
   * Code-unit offset of the cursor: the length of the value prefix ending at
   * it. Taken as a number rather than the prefix string because the only thing
   * this function ever reads is that length — callers used to slice the whole
   * prefix per keystroke purely to hand over its `.length`.
   */
  cursorOffset: number
  cols: number
  maxHeight: number
  minHeight?: number
}): { heightLines: number; totalLines: number; gutterEnabled: boolean } {
  const safeMaxHeight = Math.max(1, maxHeight)
  const effectiveMinHeight = Math.max(
    1,
    Math.min(minHeight ?? 1, safeMaxHeight),
  )
  // ONE wrap pass answers both questions: the row count and, through the cursor
  // accounting below, which row the cursor sits on. Deriving the cursor row
  // from that same pass is what keeps a cursor move inside a two-row value from
  // re-tokenizing an O(n) prefix on the render loop — chat.tsx recomputes these
  // metrics on `cursorPosition` as well as `inputValue`, and two-row content is
  // precisely the gutter case the cursor row exists for. The accounting is an
  // offset plus a counter, so the multi-row shapes this optimizes for allocate
  // nothing per row.
  const cursorRow: CursorRowState = { offset: cursorOffset, breaksBefore: 0 }
  const totalLines = measureLines(layoutContent, cols, cursorRow)
  // The cursor row only changes the result when the content wraps to exactly
  // two rows (the gutter is drawn only there), so every other content shape
  // short-circuits. A row break strictly before the cursor offset means the
  // cursor sits on a row below that break.
  const cursorLines =
    totalLines !== 2 ? totalLines : 1 + cursorRow.breaksBefore

  // Add bottom gutter when cursor is on line 2 of exactly 2 lines
  const gutterEnabled =
    totalLines === 2 && cursorLines === 2 && totalLines + 1 <= safeMaxHeight

  const rawHeight = Math.min(
    totalLines + (gutterEnabled ? 1 : 0),
    safeMaxHeight,
  )

  const heightLines = Math.max(effectiveMinHeight, rawHeight)

  return {
    totalLines,
    heightLines,
    gutterEnabled,
  }
}

/**
 * Columns MultilineInput's scrollbox wrapper spends on its own paddingLeft /
 * paddingRight. Callers reserve an outer width for the component, so the width
 * the text actually wraps at is that width minus this padding — measuring at
 * the outer width overestimates the available columns and undercounts rows.
 */
export const MULTILINE_INPUT_HORIZONTAL_PADDING = 2

/**
 * Columns text wraps at inside a call site that reserved `wrapWidth` for the
 * input, wrapper padding removed.
 *
 * The ONE place that subtraction lives. Three call sites need the same number —
 * the chat screen reserves the outer width, `computeMultilineInputHeight`
 * derives the box's wrap columns from its `wrapWidth` prop, and
 * `multilineInputWrapColumns` derives the columns the box keys its forwarded
 * measurement on — and the box reuses the caller's row count only when those
 * columns agree. A one-column drift in any of them turns the reuse path off for
 * that frame and silently restores a wrap pass on every render, so the
 * subtraction is defined once and every site delegates here.
 */
export function inputWrapColumns(wrapWidth: number): number {
  return Math.max(1, Math.floor(wrapWidth) - MULTILINE_INPUT_HORIZONTAL_PADDING)
}

/**
 * Identity of the exact content and wrap columns a caller's row measurement was
 * taken from.
 *
 * A forwarded row count is a cached value, and a cache entry without an identity
 * is a stale-read bug: between the caller's `value` prop arriving and its
 * re-measurement landing (or at a call site that forwards a count for different
 * content), a count trusted merely because it is present sizes the box for text
 * it is not drawing. Comparing this key on the consumer side turns that frame
 * into one extra local wrap pass instead of a mis-sized box. The NUL separator
 * keeps the encoding unambiguous for any content.
 *
 * Shared by the producer (the chat screen's layout metrics) and the consumer
 * (computeMultilineInputHeight) so the two cannot drift apart.
 */
export function multilineInputMeasurementKey(
  value: string,
  wrapColumns: number | undefined,
): string {
  return `${wrapColumns ?? 'unwrapped'}\u0000${value}`
}

/**
 * Single-entry memo of the wrapped row count for a placeholder at fixed
 * columns.
 *
 * The placeholder is only DRAWN while the input is empty, and an idle input
 * sits empty between submits: every render of that state re-wrapped the
 * placeholder through a fresh local pass, so the idle cost was one wrap of
 * the placeholder per render on top of whatever the value cost. Memoizing on
 * (placeholder, wrapColumns) makes that cost one pass per distinct
 * placeholder/width pair per INSTANCE instead.
 *
 * PER INSTANCE, never process-wide. The memo is owned by the component that
 * renders it (`MultilineInput` holds one in a `useRef` and passes it in as
 * `placeholderMemo`), because the box is rendered by more than one call site in
 * a single frame — `chat-input-bar.tsx` mounts it in both its compact and its
 * full-height branch, and a dialog or a nested prompt can mount a third at a
 * different width. A module-level slot keyed only on (placeholder, columns)
 * would let the second box read the first box's row count, which is exactly the
 * stale-measurement class `multilineInputMeasurementKey` above exists to
 * prevent; `computeMultilineInputHeight` staying a pure function of its
 * arguments is what structurally rules that out.
 *
 * Bounded to one entry per instance: the memo exists to stop the *repeated*
 * re-measure of the same idle frame, not to hold every placeholder the app ever
 * shows. A placeholder change (input mode switch) or a resize simply re-measures
 * once.
 */
export type PlaceholderLineMemo = {
  key: string
  lines: number
}

export function createPlaceholderLineMemo(): PlaceholderLineMemo {
  return { key: '', lines: 1 }
}

function measurePlaceholderLines(
  memo: PlaceholderLineMemo | undefined,
  placeholder: string,
  wrapColumns: number,
): number {
  const key = multilineInputMeasurementKey(placeholder, wrapColumns)
  if (memo === undefined) return measureLines(placeholder, wrapColumns)
  if (key !== memo.key) {
    memo.lines = measureLines(placeholder, wrapColumns)
    memo.key = key
  }
  return memo.lines
}

export interface MultilineInputHeightMetrics {
  /** Wrapped row count of the rendered value (never below 1). */
  totalLines: number
  /** Rows the box should occupy: minHeight floor, maxHeight cap. */
  heightLines: number
  /** Whether the trailing gutter row is rendered (cursor on line 2 of 2). */
  gutterEnabled: boolean
  /** True when the wrapped content is taller than the box, so it must scroll. */
  isScrollable: boolean
}

/**
 * Single source of truth for MultilineInput's height.
 *
 * The box height must come from the value being rendered at the width the
 * parent reserved, not from the text renderable's lineInfo: lineInfo is
 * unavailable on the first render and is not re-sampled afterwards, so a
 * stale/zero count sized the box shorter than its wrapped content and the
 * overflowing rows were painted above the component. Deriving both this height
 * and the caller's layout metrics from the same wrap width keeps the two from
 * disagreeing.
 */
export function computeMultilineInputHeight({
  value,
  placeholder,
  wrapWidth,
  lineInfoLines,
  maxHeight,
  minHeight = 1,
  cursorRow = 0,
  measuredTotalLines,
  measurementKey,
  measuredGutterEnabled,
  callerHeightCap,
  placeholderMemo,
}: {
  value: string
  /**
   * Text the box renders through the SAME wrapped text renderable when `value`
   * is empty. It is therefore part of the wrapped content that decides the
   * height: a caller measurement covers only the value it was given (chat.tsx
   * measures a single space for an empty input), so a placeholder that wraps to
   * several rows would otherwise be drawn inside a one-row box and paint its
   * overflowing rows outside the scrollbox.
   */
  placeholder?: string
  /** Columns the caller reserved for the input, wrapper padding included. */
  wrapWidth?: number
  /**
   * Rendered row count from the text renderable. Only consulted when no
   * wrapWidth is known: call sites that don't reserve a width have nothing
   * better, and a single-row floor keeps the box from collapsing to zero rows
   * before that measurement exists.
   */
  lineInfoLines?: number
  /**
   * Wrapped row count the caller already measured for this exact value at this
   * exact wrap width (the chat screen's input layout metrics). Supplying it
   * makes the render path measure each keystroke once instead of once per
   * consumer of the same value.
   *
   * This is a PRE-CLAMP row fact, not a height: the caller's own `maxHeight`
   * need not be this call's (chat-input-bar forwards one measurement to both a
   * compact and a full-height box), so the min/max clamps below are applied
   * here, to the rows, rather than taken from the caller's clamp. That is what
   * makes one forwarded measurement serve call sites that disagree on
   * `maxHeight` without either of them inheriting the other's height.
   *
   * It is only honoured together with `measurementKey` matching the content and
   * columns this call is about; see that field for why.
   */
  measuredTotalLines?: number
  /**
   * Identity of the content and columns `measuredTotalLines` was measured from
   * (see `multilineInputMeasurementKey`). A caller-supplied count is a cached
   * value, and a cache without an identity is a stale-read bug: between the
   * caller's `value` prop arriving and its re-measurement landing, or at a call
   * site that forwards a count for a different value, the forwarded count would
   * size the box for content it is not drawing. The count is therefore used
   * only when it provably belongs to the text and width being rendered here;
   * otherwise this falls back to measuring locally, which is always correct and
   * only costs the extra pass on that one inconsistent frame.
   *
   * The key names the RAW value and columns the count was produced FOR, on the
   * producer side (the shipped caller derives it with
   * `multilineInputMeasurementKey` over the same value it forwards — including
   * the empty-input frame, where the measured content is a substituted space
   * but the identity stays the raw value). A consumer that fabricates the key
   * from its own props makes the comparison vacuous, so a caller able to
   * measure should always supply the key; when it does, a count measured for
   * other content or another width fails the comparison, which turns the reuse
   * path off for that frame and charges it exactly one wrap pass.
   */
  measurementKey?: string
  /**
   * Whether that same caller measurement decided to render the trailing gutter
   * row. The gutter term has to come from the forwarded measurement too:
   * deriving it from `cursorRow` makes it depend on the text renderable's
   * lineInfo, which does not exist before the first commit, so content that
   * wraps to exactly two rows rendered at height 2 and then jumped to height 3
   * once lineInfo arrived. Omitted means the box falls back to the cursor row
   * it can see, which is all a caller without layout metrics has.
   */
  measuredGutterEnabled?: boolean
  /**
   * The caller's own effective cap on the row count it forwarded. The forwarded
   * count is a PRE-CLAMP row fact shared by every mount that reuses it, so
   * scrollability has to be decided on the same basis the caller drew with: once
   * the caller's layout clamps, the forwarded count no longer tracks the real
   * wrapped rows, and comparing it against this box's `maxHeight` alone can
   * report the content as fitting while the box must scroll. The tighter of the
   * two caps is therefore the basis, and omitting it makes this box's own
   * `maxHeight` the only authority.
   */
  callerHeightCap?: number
  /**
   * Scope of the placeholder memo (see `PlaceholderLineMemo`). Owned by the
   * CALL SITE - one memo per rendered box - so two boxes at different wrap
   * widths can never read each other's placeholder row count. Omitted means no
   * memo: the placeholder is wrapped locally, which is always correct and only
   * costs the repeated pass this memo exists to remove.
   */
  placeholderMemo?: PlaceholderLineMemo
  maxHeight: number
  minHeight?: number
  cursorRow?: number
}): MultilineInputHeightMetrics {
  const safeMaxHeight = Math.max(1, maxHeight)
  const effectiveMinHeight = Math.max(1, Math.min(minHeight, safeMaxHeight))

  const wrapColumns =
    wrapWidth === undefined ? undefined : inputWrapColumns(wrapWidth)

  // A caller-supplied count is honoured only when its identity matches the text
  // and columns being rendered right now. An unidentifiable count is treated as
  // absent rather than trusted, so a stale measurement degrades to one extra
  // wrap pass instead of a box sized for content it is not drawing.
  const callerLinesAreCurrent =
    measuredTotalLines !== undefined &&
    measurementKey !== undefined &&
    measurementKey === multilineInputMeasurementKey(value, wrapColumns)

  // The placeholder is what the box actually renders when the value is empty,
  // and the caller's measurement never covers it, so it is measured here —
  // through a (placeholder, columns) memo. An empty input is exactly the state
  // the box sits in between submits, so an unmemoized pass here re-wrapped the
  // placeholder on every render of the idle input. Memoized, the idle state
  // costs one pass per distinct placeholder/width pair.
  //
  // Resolved BEFORE the value: on the empty frame the value is '' (or the
  // caller's single-space substitute) whose row count is a constant 1, so
  // wrapping it would be a pure waste charged to every idle render. Taking the
  // placeholder first lets that frame skip the value pass entirely and makes the
  // whole frame free once its memo is warm.
  //
  // The memo is the CALLER's per-instance one, so a warm entry always belongs to
  // this box at this width; a memo shared process-wide would have to key on
  // instance identity to be safe, and this function stays pure instead.
  const placeholderLines =
    value.length === 0 && placeholder !== undefined && wrapColumns !== undefined
      ? measurePlaceholderLines(placeholderMemo, placeholder, wrapColumns)
      : 0

  // Without a reserved width the rendered row count is all there is, and the
  // one-row floor keeps the box from collapsing before it has been measured.
  // A verified caller-supplied count wins over both: it was measured for this
  // value at these columns, so re-wrapping here would just repeat the same O(n)
  // pass. An empty value is a single row by construction, so it never needs a
  // pass either — the placeholder above already covers what the frame draws.
  const valueLines = callerLinesAreCurrent
    ? (measuredTotalLines as number)
    : wrapColumns === undefined
      ? (lineInfoLines ?? 1)
      : value.length === 0
        ? 1
        : measureLines(value, wrapColumns)

  const totalLines = Math.max(1, valueLines, placeholderLines)

  // Add bottom gutter when cursor is on line 2 of exactly 2 lines. A supplied
  // measurement owns that decision, so the height stays a pure function of one
  // fixed measurement instead of also mixing in a later-available cursor row.
  // The gutter flag comes from the same measurement, so it is trusted on exactly
  // the same condition as the count above: a flag derived from a measurement for
  // other content is as wrong as a count derived from one.
  const cursorOnSecondRow =
    callerLinesAreCurrent && measuredGutterEnabled !== undefined
      ? measuredGutterEnabled
      : cursorRow === 1
  const gutterEnabled =
    totalLines === 2 && cursorOnSecondRow && totalLines + 1 <= safeMaxHeight

  const rawHeight = Math.min(
    totalLines + (gutterEnabled ? 1 : 0),
    safeMaxHeight,
  )
  const heightLines = Math.max(effectiveMinHeight, rawHeight)

  // Content is scrollable when total lines exceed max height. The caller's
  // effective cap participates so `isScrollable` answers the same question the
  // caller's layout answered: "is the content taller than the box being drawn".
  const scrollCap =
    callerHeightCap === undefined
      ? safeMaxHeight
      : Math.max(1, Math.min(safeMaxHeight, callerHeightCap))
  const isScrollable = totalLines > scrollCap

  return {
    totalLines,
    heightLines,
    gutterEnabled,
    isScrollable,
  }
}
