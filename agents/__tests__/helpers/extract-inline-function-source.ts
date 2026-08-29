/**
 * Extract a named top-level function declaration (balanced braces) from
 * transpiled source. Shared test utility so the three mirror sites
 * (gate-repair-parity, base2-writer-spawn-rules, and the
 * reviewer-spawn-conditions e2e) stay in sync instead of re-declaring
 * identical copies.
 *
 * Known limitations (acceptable for the transpiled inputs this serves):
 * - Line (double-slash) and block (slash-star ... star-slash) comments are
 *   skipped during the balance walks, so parens/braces inside them never
 *   corrupt slicing.
 * - Quoted strings, escapes, and comments are also skipped during the final
 *   body-slice walk (see findMatchingDelimiterEnd), so literal braces inside
 *   a string or template literal in a prompt-building function body can't
 *   terminate the slice early and silently truncate the sink.
 * - Plain backtick-quoted default template literals are inert during every
 *   parameter-list/annotation walk (all backtick-quoted content is skipped), so
 *   ordinary `${...}` interpolation parens/braces inside a default cannot break
 *   the balance walk. The one real edge is a NESTED backtick inside an
 *   interpolation (e.g. `` fn = `${`raw`}` `` or a raw backtick inside ${}):
 *   the inner backtick closes the quoted region early and trailing `${}` braces
 *   could then be miscounted. Fine for current transpiled output; revisit if
 *   the helper is shared more broadly.
 * - Regex literals ARE skipped by every balance walk (the param-list,
 *   return-type-annotation, and body-start scans as well as the final
 *   findMatchingDelimiterEnd body slice), via isRegexStart, so a regex default
 *   param or a return-type annotation containing a brace/paren (e.g.
 *   `a = /}/`) can't corrupt those walks' balance.
 * - isRegexStart is narrowed so a `//` directly after an operator or opening
 *   delimiter (e.g. `a = // comment`) is always treated as a line comment, not
 *   a regex. Without that narrowing, isRegexStart would read the `//` after `=`
 *   as a regex and a `}` inside the comment could terminate the walk early —
 *   pinned by the base2-writer-spawn-rules '// comment directly after =' test.
 *   All three call sites (gate-repair-parity, base2-writer-spawn-rules, and the
 *   reviewer-spawn-conditions e2e) share this same pinned limit via this helper.
 * - isRegexStart is keyword-aware: when the previous significant character is
 *   an identifier tail, the full token is scanned back and matched against the
 *   expression-preceding keyword set (REGEX_PRECEDING_KEYWORDS), so a regex
 *   directly after a keyword (`return /{…}/`, `typeof /…/`) is skipped as a
 *   literal instead of being misread as division — pinned by the
 *   base2-writer-spawn-rules keyword-aware tests.
 */
export function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  // Locate the parameter-list '(' immediately after `function NAME`.
  const openParen = source.indexOf('(', declarationStart)
  if (openParen < 0) {
    throw new Error(`Unable to find inline ${functionName} parameter list`)
  }

  // Walk the parameter list to its matching close paren, tracking nesting so
  // destructured object/array params and string literals don't confuse depth.
  let parenDepth = 1
  let index = openParen + 1
  let quote: string | null = null
  while (index < source.length && parenDepth > 0) {
    const character = source[index]
    if (quote) {
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === quote) quote = null
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (
      character === '/' &&
      source[index + 1] === '/' &&
      !isRegexStart(source, index)
    ) {
      // Skip a `//` line comment so parens/braces inside it can't corrupt the
      // balance walk (e.g. `function f(a /* ) */)`).
      const newline = source.indexOf('\n', index)
      if (newline < 0) break
      index = newline + 1
      continue
    } else if (character === '/' && source[index + 1] === '*') {
      // Skip a `/* ... */` block comment so tokens inside it stay inert.
      const close = source.indexOf('*/', index + 2)
      if (close < 0) break
      index = close + 2
      continue
    } else if (character === '/' && isRegexStart(source, index)) {
      // Regex literal (e.g. a default param `a = /}/`): skip past the closing
      // unescaped '/' so its braces/parens can't unbalance this walk.
      const regexEnd = skipRegexLiteral(source, index)
      if (regexEnd < 0) break
      index = regexEnd
      continue
    } else if (character === '(' || character === '[' || character === '{') {
      parenDepth += 1
    } else if (character === ')' || character === ']' || character === '}') {
      parenDepth -= 1
    }
    index += 1
  }
  if (parenDepth !== 0) {
    throw new Error(
      `Unable to find end of inline ${functionName} parameter list`,
    )
  }

  // After the params there may be a return-type annotation whose own braces
  // (e.g. a multi-line object-literal type `): { groups: Array<{ ... }> }`)
  // must be skipped so the REAL function-body '{' is chosen as bodyStart. Walk
  // the annotation with the same quote/brace-aware logic until its brackets
  // balance back to depth 0 (a brace-less type such as `: string` simply ends
  // at the next whitespace). The body scan below then starts from the
  // annotation's end and finds the actual body opener at braceDepth 0.
  let bodyStart = -1
  let braceDepth = 0
  quote = null

  // Advance past any whitespace so the token immediately after the close paren
  // is what gets inspected for a return-type ':'.
  while (index < source.length && /\s/.test(source[index])) index += 1
  if (source[index] === ':') {
    // Consume the ':' — the following token is the return-type annotation.
    index += 1
    // Skip whitespace between ':' and the annotation start so the FIRST token
    // inspected is the annotation's own opening bracket (for an object-literal
    // type like `: { groups: ... }`) rather than a leading space. Without this,
    // `!sawOpeningBracket && /\s/` breaks immediately on that space, the
    // annotation is never consumed, and the real function-body '{' is never
    // reached — the body-start scan then mistakes the annotation's '{' for the
    // body and slices the function off inside its return-type annotation.
    while (index < source.length && /\s/.test(source[index])) index += 1
    let annotationDepth = 0
    let sawOpeningBracket = false
    while (index < source.length) {
      const character = source[index]
      if (quote) {
        if (character === '\\') {
          index += 2
          continue
        }
        if (character === quote) quote = null
      } else if (character === '"' || character === "'" || character === '`') {
        quote = character
      } else if (
        character === '/' &&
        source[index + 1] === '/' &&
        !isRegexStart(source, index)
      ) {
        // Skip a `//` line comment in the return-type annotation.
        const newline = source.indexOf('\n', index)
        if (newline < 0) break
        index = newline + 1
        continue
      } else if (character === '/' && source[index + 1] === '*') {
        // Skip a `/* ... */` block comment in the return-type annotation.
        const close = source.indexOf('*/', index + 2)
        if (close < 0) break
        index = close + 2
        continue
      } else if (character === '/' && isRegexStart(source, index)) {
        // Regex literal inside the return-type annotation (e.g. a tagged type
        // or a regex pattern): skip past its closing '/' so its braces/parens
        // can't unbalance the annotation walk.
        const regexEnd = skipRegexLiteral(source, index)
        if (regexEnd < 0) break
        index = regexEnd
        continue
      } else if (character === '{' || character === '(' || character === '[') {
        annotationDepth += 1
        sawOpeningBracket = true
      } else if (character === '}' || character === ')' || character === ']') {
        annotationDepth -= 1
        if (sawOpeningBracket && annotationDepth <= 0) {
          // Balanced back to 0: the annotation ends at this closing bracket.
          index += 1
          break
        }
      } else if (!sawOpeningBracket && /\s/.test(character)) {
        // A simple annotation without any brackets ends at the next whitespace.
        break
      }
      index += 1
    }
  }

  while (index < source.length && bodyStart < 0) {
    const character = source[index]
    if (quote) {
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === quote) quote = null
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (
      character === '/' &&
      source[index + 1] === '/' &&
      !isRegexStart(source, index)
    ) {
      // Skip a `//` line comment in the body-start scan.
      const newline = source.indexOf('\n', index)
      if (newline < 0) break
      index = newline + 1
      continue
    } else if (character === '/' && source[index + 1] === '*') {
      // Skip a `/* ... */` block comment in the body-start scan.
      const close = source.indexOf('*/', index + 2)
      if (close < 0) break
      index = close + 2
      continue
    } else if (character === '/' && isRegexStart(source, index)) {
      // Regex literal in the body before the opener (rare, but keep parity with
      // the other walks): skip past its closing '/' so a regex brace can't be
      // mistaken for the function body opener.
      const regexEnd = skipRegexLiteral(source, index)
      if (regexEnd < 0) break
      index = regexEnd
      continue
    } else if (character === '{') {
      if (braceDepth === 0) bodyStart = index
      else braceDepth += 1
    } else if (character === '}') {
      braceDepth -= 1
    }
    index += 1
  }
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  // Slice from `function NAME(` through the body's matching closing brace,
  // preserving the full signature (params + return-type annotation). Uses the
  // same quote/escape/comment-aware balance walk as the earlier passes so
  // literal braces inside a string or template literal in the body can't cut
  // the slice short.
  const bodyEnd = findMatchingDelimiterEnd(source, bodyStart, '{', '}')
  if (bodyEnd < 0) {
    throw new Error(`Unable to find end of inline ${functionName} declaration`)
  }
  return source.slice(declarationStart, bodyEnd + 1)
}

/**
 * Keywords that leave the following token in expression position, so a `/`
 * directly after one of them opens a regex literal rather than being a
 * division operator (`return /re/`, `typeof /re/`, `x in /re/`, ...).
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

/**
 * Returns true when the '/' at `index` opens a regex literal rather than being
 * a division operator or part of a comment. Heuristic: the previous
 * significant (non-whitespace) character is an operator, an opening delimiter,
 * a comma, or nothing (expression start). A division is preceded by a number,
 * a closing delimiter `)`, `]`, or `}`, or an identifier that is NOT an
 * expression-preceding keyword: when the previous token ends in an identifier
 * character, the full token is scanned back and matched against
 * REGEX_PRECEDING_KEYWORDS so `return /{…}/` or `typeof /…/` is read as a
 * regex, not a division.
 */
function isRegexStart(source: string, index: number): boolean {
  // A '/' at `index` that isn't already part of a comment opens a regex literal
  // when it is NOT a division operator, i.e. when the previous significant char
  // is an operator, opening delimiter, comma, or nothing (expression start).
  // Division looks like `a / b`, `) / b`, `] / b`, `} / b`, or an identifier/'/'
  // immediately before the slash. This heuristic matches the transpiled inputs.
  //
  // Narrowing (cross-referenced from the header doc comment): a `//` is ALWAYS
  // a line comment, never the start of a regex literal (a regex whose first
  // char is '/' would need to be written escaped, so source[index + 1] would be
  // '\', not '/'). Returning false here lets the `//` comment branch handle it
  // instead of isRegexStart misreading e.g. `a = // comment\n }` after the '='
  // as a regex — which would let a '}' inside that comment terminate the
  // balance walk early. Pinned by the base2-writer-spawn-rules '// comment
  // directly after =' test.
  if (source[index + 1] === '/') return false
  let prev = index - 1
  while (prev >= 0 && /\s/.test(source[prev])) prev -= 1
  if (prev < 0) return true
  const c = source[prev]
  // Numbers and closing delimiters always end a division operand.
  if (/[0-9\)\]\}]/.test(c)) return false
  // Identifier tail: a char-only check would misread a regex following an
  // expression-preceding keyword (e.g. `return /{…}/`, `typeof /…/`) as a
  // division. Scan back the full token and admit those keywords instead.
  if (/[A-Za-z_$]/.test(c)) {
    let tokenStart = prev
    while (tokenStart > 0 && /[A-Za-z0-9_$]/.test(source[tokenStart - 1])) {
      tokenStart -= 1
    }
    return REGEX_PRECEDING_KEYWORDS.has(source.slice(tokenStart, prev + 1))
  }
  return true
}

/**
 * Advance past a regex literal whose '/' is at `cursor` (the caller has already
 * confirmed isRegexStart). Skips escapes and character classes so quantifier
 * braces like `{m,n}` and literal openers/closers inside the pattern can't
 * corrupt the caller's balance walk. Returns the index just past the closing
 * unescaped '/', or -1 if the literal runs off the end of the source without
 * closing.
 */
function skipRegexLiteral(source: string, cursor: number): number {
  let idx = cursor + 1
  let inClass = false
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === '\\') idx += 2
    else if (ch === '[') {
      inClass = true
      idx += 1
    } else if (ch === ']') {
      inClass = false
      idx += 1
    } else if (ch === '/' && !inClass) {
      return idx + 1
    } else idx += 1
  }
  return -1
}

/**
 * Walk forward from `start` (which must point at an `opener`) to the matching
 * `closer`, tracking nesting so nested delimiters stay balanced. Quoted
 * strings, escapes, line comments (slash-slash), block comments, and regex
 * literals are skipped so literal openers/closers inside them can't corrupt the
 * balance. Returns the index of the matching `closer`, or -1 if the source ends
 * before the delimiters balance back to depth 0.
 */
export function findMatchingDelimiterEnd(
  source: string,
  start: number,
  opener: '{' | '[' | '(',
  closer: '}' | ']' | ')',
): number {
  let depth = 0
  let cursor = start
  let quote: string | null = null
  while (cursor < source.length) {
    const character = source[cursor]
    if (quote) {
      if (character === '\\') {
        cursor += 2
        continue
      }
      if (character === quote) quote = null
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (
      character === '/' &&
      source[cursor + 1] === '/' &&
      !isRegexStart(source, cursor)
    ) {
      const newline = source.indexOf('\n', cursor)
      if (newline < 0) break
      cursor = newline + 1
      continue
    } else if (character === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2)
      if (close < 0) break
      cursor = close + 2
      continue
    } else if (character === '/' && isRegexStart(source, cursor)) {
      // Regex literal: skip to the closing unescaped '/', ignoring quantifier
      // braces like `{m,n}` so they can't unbalance the delimiter walk.
      const regexEnd = skipRegexLiteral(source, cursor)
      if (regexEnd < 0) break
      cursor = regexEnd
      continue
    } else if (character === opener) {
      depth += 1
    } else if (character === closer) {
      depth -= 1
      if (depth === 0) return cursor
    }
    cursor += 1
  }
  return -1
}
