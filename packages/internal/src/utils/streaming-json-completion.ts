import { isParsableJson } from '@ai-sdk/provider-utils'

/**
 * Avoid reparsing an unfinished object or array after every streamed fragment.
 * This is only a conservative completion gate: JSON.parse remains authoritative
 * whenever a complete value is possible, including malformed and scalar input.
 * Each instance belongs to one append-only argument stream.
 */
export class StreamingJsonCompletion {
  private mode: 'start' | 'container' | 'parse' = 'start'
  private depth = 0
  private inString = false
  private escaped = false
  /**
   * Non-latched `{`/`[` nesting depth that keeps counting independently of
   * `mode` (reliability finding
   * streaming-json-completion-mode-latch-drops-container-tracking-across-fragments):
   * once the up-front mode latch flips (a container closed, or the stream is
   * scalar), the primary `depth` counter stops being authoritative, but a
   * merged argument body can still contain a second serialized value whose
   * close is owed.
   */
  private depthAfterModeSettled = 0

  constructor(private readonly parse = isParsableJson) {}

  /**
   * Unmatched `{`/`[`-container depth of the appended argument stream so far
   * (strings and escape sequences are transparent). `> 0` means the stream is
   * still syntactically incomplete — closing tokens are still owed; `0` for a
   * not-yet-started or already-canonicalized stream. Callers that must steer
   * an orphaned argument suffix into one of several unfinished tool calls use
   * this to pick the call the suffix can syntactically belong to instead of
   * guessing by recency (reliability finding
   * openai-compat-continuation-mis-merge).
   */
  get unmatchedContainerDepth(): number {
    return this.depth
  }

  /**
   * Unmatched `{`/`[`-container depth computed by the NEVER-LATCHED tracking.
   * Equals {@link unmatchedContainerDepth}-equivalent behavior while the
   * stream is still inside its first serialized value; after the mode latch
   * canonicalizes a completed value (or a scalar), this keeps counting any
   * SECOND serialized value appended to the same stream (e.g. a merged
   * argument body `{...} {...}`), so a caller routing a stray continuation
   * fragment can still detect an unclosed container the standard
   * {@link unmatchedContainerDepth} would report as 0.
   */
  get unmatchedDepthAfterClose(): number {
    return this.depthAfterModeSettled
  }

  isParsable(input: string, fragment: string): boolean {
    for (let i = 0; i < fragment.length; i++) {
      const char = fragment[i]
      if (this.mode === 'start') {
        if (char === ' ' || char === '\t' || char === '\r' || char === '\n')
          continue
        if (char !== '{' && char !== '[') {
          this.mode = 'parse'
          break
        }
        this.mode = 'container'
        this.depth = 1
        this.depthAfterModeSettled = 1
        continue
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (char === '\\') this.escaped = true
        else if (char === '"') this.inString = false
      } else if (char === '"') {
        this.inString = true
      } else if (char === '{' || char === '[') {
        this.depthAfterModeSettled++
        if (this.mode !== 'parse') this.depth++
      } else if (char === '}' || char === ']') {
        this.depthAfterModeSettled = Math.max(
          0,
          this.depthAfterModeSettled - 1,
        )
        if (this.mode !== 'parse') {
          this.depth--
          if (this.depth === 0) this.mode = 'parse'
        }
      }
    }
    return this.mode === 'parse' && this.parse(input)
  }
}
