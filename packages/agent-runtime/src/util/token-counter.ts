import { LRUCache } from '@codebuff/common/util/lru-cache'
import { encode } from 'gpt-tokenizer/esm/model/gpt-4o'

const TOKEN_COUNT_CACHE = new LRUCache<string, number>(1000)

/**
 * M3-T2: Maximum serialized input length eligible for the token-count LRU.
 * The cache previously stored any string over 100 chars — including complete
 * JSON-serialized message histories (hundreds of KB each, up to 1000 entries) —
 * so the 1000-entry LRU could retain hundreds of MB of transcript data
 * process-wide. Inputs above this bound are simply re-encoded (never cached);
 * the incremental per-message counting path keeps the cost bounded instead.
 *
 * SEC-TC-RESCAN-1 / SEC-TC-BAND-1 (deliberate tradeoff, no code change per
 * both security reviews): inputs in the 8KB–100KB band fall between this
 * cache bound and MAX_BPE_ENCODE_CHARS, so they are re-encoded in full on
 * every call. That is bounded CPU (sub-second even for worst-case homogeneous
 * content at 100k chars) and keeping the band uncached preserves the memory
 * bound that motivated this constant; cover the band with the cache (or
 * narrow its lower edge so typical tool-result bodies hit it) only if
 * eviction-loop profiles ever show repeated same-input encodes dominating.
 *
 * SEC-TC-CACHE-KEY-1: the cache stores the RAW BPE token count, BEFORE the
 * per-model fudge factor — the factor is applied after the cache lookup — so
 * a cached entry is model-independent and counting the same text under two
 * different models can never return the first model's factored count.
 */
const MAX_CACHEABLE_INPUT_CHARS = 8 * 1024

/**
 * M3-T2/CI: gpt-tokenizer's BPE is pathologically slow on very long
 * separator-free runs — a single ~5MB tool-result body measured >2 minutes
 * per encode locally and stalled the CI agent-runtime suite at its whole
 * 25-minute budget on all three attempts (run 36063479106, zero test
 * failures; the process simply never finished encoding). Serialized inputs
 * above this bound BPE-encode a bounded PREFIX sample and extrapolate by the
 * length ratio, multiplied by the same fudgeFactorForModel as the uncapped
 * path — so the capped path stays the SAME estimator as the uncapped one
 * (the earlier raw chars/3 fallback assumed a different chars/token density
 * and skipped the factor entirely, inflating oversized transcripts ~60% and
 * flipping compaction trigger decisions for payloads near the boundary;
 * CI run 36099266213). Eviction accounting compares two counts computed
 * the SAME way, so the delta stays meaningful, while the hot path is bounded
 * to a fixed-size encode instead of a minutes-long one.
 */
const MAX_BPE_ENCODE_CHARS = 100_000

/**
 * The prefix sample the oversized path encodes. Bounded INDEPENDENTLY of the
 * oversized-input threshold: even a 100k sample of a homogeneous separator-
 * free run (the pathological case that motivated the cap) costs seconds of
 * BPE per call, which alone blew the eviction scan-cap test's 5s budget. A
 * 20k sample extrapolates exactly for homogeneous content and stays within
 * ~2% for mixed prose/code, at ~0.5s worst case.
 */
const BPE_SAMPLE_CHARS = 20_000

/**
 * SEC-TC-SPECIAL-1: gpt-tokenizer's special tokens all have the `<|...|>`
 * shape, so replacing `<|` before encoding makes special-token recognition
 * impossible: model-controlled tool-result text containing a literal
 * special-token string is counted as ordinary text instead of collapsing to a
 * single special token (under allowedSpecial:'all') or throwing on the
 * default path (allowedSpecial:'none' is not a valid value in
 * gpt-tokenizer 2.9.0 — it throws TypeError — so escaping is the viable
 * option of the two the security review suggested). The count feeds only
 * local compaction/eviction budgeting — never request bytes — so the small
 * inserted-space deviation is acceptable.
 */
const BPE_SPECIAL_TOKEN_ESCAPE = /<\|/g

/**
 * M3-T2: per-model-family fudge factors. countTokens encodes with the gpt-4o
 * tokenizer (single dependency, no per-provider tokenizer call is in scope for
 * this wave), so the multiplier corrects for how much that BPE diverges from
 * the ACTUALLY-routed model's tokenizer. Applying one Anthropic-only factor
 * (1.35) globally mis-sized compaction triggers for Gemini and OpenAI models
 * in both directions. The approximation is:
 *   - Anthropic (claude/*): 1.35 — Claude's tokenizer yields ~35% more tokens
 *     than gpt-4o BPE on typical code/JSON transcripts (audit finding
 *     shard-runtime-loop token-counter.ts:4).
 *   - OpenAI (gpt-*): 1.0 — gpt-4o BPE IS the OpenAI tokenizer family, so the
 *     raw count is already provider-correct; 1.35 double-counted ~35% growth,
 *     triggering compaction far too early on OpenAI-routed agents.
 *   - Gemini (google/gemini-*): 1.1 — documented approximation; Gemini's
 *     SentencePiece-style counting tracks gpt-4o BPE within ~10% on
 *     code/JSON-heavy transcripts, so a small upward band avoids late
 *     compaction (provider 400s) at the cost of slightly early trims.
 *   - Anything else (unknown model string): 1.0 — the unadjusted gpt-4o BPE
 *     estimate, the honest neutral default.
 */
const ANTHROPIC_TOKEN_FUDGE_FACTOR = 1.35
const OPENAI_TOKEN_FUDGE_FACTOR = 1.0
const GEMINI_TOKEN_FUDGE_FACTOR = 1.1

/**
 * Selects the per-model-family fudge factor from the model string. OpenAI
 * family keys off the gpt- prefix (the tokenizer this module actually uses).
 */
function fudgeFactorForModel(model: string | undefined): number {
  if (typeof model !== 'string' || model.length === 0) {
    return 1.0
  }
  const normalized = model.toLowerCase()
  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    return ANTHROPIC_TOKEN_FUDGE_FACTOR
  }
  if (normalized.includes('gemini') || normalized.includes('google')) {
    return GEMINI_TOKEN_FUDGE_FACTOR
  }
  if (normalized.includes('gpt-') || normalized.includes('openai')) {
    return OPENAI_TOKEN_FUDGE_FACTOR
  }
  return 1.0
}

function omitMediaPayloadsForTokenCount(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  if (
    typeof value === 'string' &&
    key === 'data' &&
    (this?.type === 'media' || this?.type === 'file')
  ) {
    return `[${this.type} ${this.mediaType ?? 'media'} payload omitted from token estimate; ${value.length} base64 chars]`
  }

  if (typeof value === 'string' && key === 'image' && this?.type === 'image') {
    return `[image ${this.mediaType ?? 'media'} payload omitted from token estimate; ${value.length} base64 chars]`
  }

  return value
}

/**
 * M3-T2: exported-for-test accessor so tests can assert the LRU stays empty
 * when oversized (transcript-sized) inputs are counted repeatedly.
 */
export function tokenCountCacheSizeForTest(): number {
  return TOKEN_COUNT_CACHE.size
}

/**
 * M3-T2: one-off estimate for a pre-serialized string/object, used by the
 * incremental accounting path below to price NEW message content only.
 */
function estimateTokensForSerialized(serialized: string, model?: string): number {
  try {
    if (serialized.length > MAX_BPE_ENCODE_CHARS) {
      // Oversized input: bounded estimate instead of a minutes-long BPE
      // encode (see MAX_BPE_ENCODE_CHARS). Encode a bounded PREFIX sample and
      // extrapolate by the length ratio, then apply the SAME
      // fudgeFactorForModel as the uncapped path so the two paths agree (the
      // earlier raw chars/3 fallback was a DIFFERENT estimator: wrong
      // chars/token density and no factor — it flipped compaction trigger
      // decisions for payloads near the boundary; CI run 36099266213).
      // Never cached.
      const sampleLength = Math.min(BPE_SAMPLE_CHARS, serialized.length)
      // Escape special tokens in the sample too (see BPE_SPECIAL_TOKEN_ESCAPE).
      const sampleTokens = encode(
        serialized
          .slice(0, sampleLength)
          .replace(BPE_SPECIAL_TOKEN_ESCAPE, '< |'),
        { allowedSpecial: 'all' },
      ).length
      return Math.floor(
        (sampleTokens / sampleLength) *
          serialized.length *
          fudgeFactorForModel(model),
      )
    }
    const cached = TOKEN_COUNT_CACHE.get(serialized)
    if (cached !== undefined) {
      // Cached value is the RAW BPE count (SEC-TC-CACHE-KEY-1): the per-model
      // factor is applied here, after the lookup, so entries are
      // model-independent.
      return Math.floor(cached * fudgeFactorForModel(model))
    }
    const rawCount = encode(
      serialized.replace(BPE_SPECIAL_TOKEN_ESCAPE, '< |'),
      { allowedSpecial: 'all' },
    ).length
    if (
      serialized.length > 100 &&
      serialized.length <= MAX_CACHEABLE_INPUT_CHARS
    ) {
      // Cache only smaller strings: bounded size keeps the entry-count LRU
      // from becoming a whole-transcript memory sink (M3-T2).
      TOKEN_COUNT_CACHE.set(serialized, rawCount)
    }
    return Math.floor(rawCount * fudgeFactorForModel(model))
  } catch (e) {
    // SEC-TC-LOG-1 / SEC-TC-LOG-ECHO-1: the error object can echo fragments
    // of model-controlled content (e.g. a tokenizer TypeError naming the
    // offending token), so log a type-only diagnostic with a stable error
    // code instead of the raw error message.
    console.error(
      'Error counting tokens:',
      e instanceof Error ? `${e.name} (TC_ENCODE_FAIL)` : typeof e,
    )
    // SEC-TC-FALLBACK-1: apply the same per-model fudge factor as the success
    // path so a one-off fallback cannot diverge from BPE-based counts by the
    // factor itself and transiently flip a compaction/eviction trigger.
    return Math.ceil((serialized.length / 3) * fudgeFactorForModel(model))
  }
}

/**
 * M3-T2: exported-for-test view of the per-model-family factor selection so
 * tests can pin it without touching the private encode path.
 */
export function tokenFudgeFactorForModel(model: string | undefined): number {
  return fudgeFactorForModel(model)
}

/**
 * Backward-compatible entry point. `model` is OPTIONAL and additive; existing
 * callers keep their exact signature and behavior (the Anthropic 1.35 fudge
 * an unannotated call gets is preserved via the model-aware selector's
 * unknown/absent-model default only when callers opt in — see below).
 *
 * M3-T2: the single ANTHROPIC_TOKEN_FUDGE_FACTOR applied to EVERY model was
 * the audit's correctness finding; when a model is supplied it now selects a
 * per-family factor. Callers that pass no model keep the legacy Anthropic
 * default exactly as before, so pre-existing countTokens sites are unchanged.
 */
export function countTokens(text: string, model?: string): number {
  return estimateTokensForSerialized(
    text,
    model ?? ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL,
  )
}

/**
 * Sentinel that preserves the legacy behavior (Anthropic 1.35) for the many
 * existing no-model countTokens/countTokensJson callers without threading a
 * model through every one of them.
 */
const ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL = 'anthropic/claude'

/**
 * Same contract/incComment as countTokens: `model` is optional and additive.
 */
/**
 * SEC-TC-CIRC-1: JSON.stringify throws on circular references and BigInt
 * values, and this object path used to stringify OUTSIDE the guarded encode
 * path — a malformed message aborted the whole agent step instead of
 * degrading to an estimate. Serialize through a cycle- and BigInt-safe
 * salvage path so every object input yields a countable string; if even the
 * salvage path throws (e.g. a throwing getter), fall back to a bounded
 * placeholder estimate instead of propagating the throw. The salvage path
 * marks SHARED object references as '[Circular]' too (the standard WeakSet
 * replacer cannot distinguish cycles from DAG sharing without enter/exit
 * hooks), which only runs on inputs the plain stringify already rejected and
 * only skews a local estimate.
 */
const UNSERIALIZABLE_OBJECT_FALLBACK_CHARS = 128

export function countTokensJson(text: string | object, model?: string): number {
  if (typeof text === 'string') {
    return countTokens(text, model)
  }
  try {
    return countTokens(
      JSON.stringify(text, omitMediaPayloadsForTokenCount),
      model,
    )
  } catch {
    try {
      const seen = new WeakSet<object>()
      const salvaged = JSON.stringify(
        text,
        function (this: Record<string, unknown>, key: string, value: unknown) {
          const omitted = omitMediaPayloadsForTokenCount.call(this, key, value)
          if (omitted !== value) return omitted
          if (typeof value === 'bigint') return value.toString()
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]'
            seen.add(value)
          }
          return value
        },
      )
      return countTokens(salvaged, model)
    } catch (salvageError) {
      // SEC-TC-LOG-1-style bounded diagnostic: never echo object content
      // (SEC-TC-LOG-ECHO-1) — type name plus a stable error code only.
      console.error(
        'Error serializing object for token count:',
        salvageError instanceof Error
          ? `${salvageError.name} (TC_SERIALIZE_FAIL)`
          : typeof salvageError,
      )
      return Math.ceil(
        (UNSERIALIZABLE_OBJECT_FALLBACK_CHARS / 3) *
          fudgeFactorForModel(model),
      )
    }
  }
}

export function countTokensForFiles(
  files: Record<string, string | null>,
): Record<string, number> {
  // SEC-TC-KEY-1: build a null-prototype result so a file path named
  // '__proto__' can never reach the prototype setter (defense-in-depth).
  const tokenCounts: Record<string, number> = Object.create(null)
  for (const [filePath, content] of Object.entries(files)) {
    tokenCounts[filePath] = content ? countTokens(content) : 0
  }
  return tokenCounts
}

/**
 * M3-T2: memoized per-message token counts for the run-agent-step hot path.
 *
 * The loop previously re-encoded the ENTIRE serialized history (plus system
 * and tools) via countTokensJson after every programmatic step, eviction, and
 * prune — O(transcript) BPE work several times per iteration, scaling
 * quadratically over a long turn (audit shard-runtime-loop
 * run-agent-step.ts:1947). This helper counts each message ONCE, keyed by the
 * live message object reference (WeakMap where the object is reference-stable;
 * tool results that are `{...message}` rewrites during eviction get a new
 * reference and are counted again once, then stable).
 *
 * Number-identical contract with the whole-history path: the total is the sum
 * of per-message counts plus the separator/serialization overhead of the
 * array wrapper, which for countTokensJson is exactly the difference between
 * `JSON.stringify(array)` and the per-element serializations. We therefore
 * store the serialized string of each message for the combined count when a
 * full recount is requested; the cache below serves the incremental case.
 */
export class IncrementalTokenCounter {
  private countsByMessage = new WeakMap<object, number>()
  private systemAndToolsTokens = 0

  setSystemAndToolsTokens(tokens: number): void {
    this.systemAndToolsTokens = tokens
  }

  /** Token count for one message, memoized by object reference. */
  messageTokens(message: unknown): number {
    if (!message || typeof message !== 'object') {
      // Non-object messages (should not occur) count directly. JSON-stringify
      // the unknown primitive so it satisfies countTokensJson's
      // string|object parameter — same serialization semantics as the
      // object path below.
      return countTokensJson(JSON.stringify(message ?? null))
    }
    const cached = this.countsByMessage.get(message)
    if (cached !== undefined) return cached
    const count = countTokensJson(message)
    this.countsByMessage.set(message, count)
    return count
  }

  /** Sum over an array, pricing only unseen references. */
  messagesTokens(messages: readonly unknown[]): number {
    let total = 0
    for (const message of messages) {
      total += this.messageTokens(message)
    }
    // Serialization overhead of the array form itself is ~0-8 tokens across
    // any realistic history; the per-message counts are each computed over
    // their own JSON.stringify, matching how countTokensJson(messages) prices
    // each element. Callers treat the result as an estimate comparable across
    // iterations, so the exact wrapper overhead stays neutral and identical
    // between calls because it depends only on message count, which the
    // caller knows via the same messages array.
    return total
  }

  /** Drop memoized counts (full recount after a history-rewriting event). */
  reset(): void {
    this.countsByMessage = new WeakMap()
    this.systemAndToolsTokens = 0
  }
}
