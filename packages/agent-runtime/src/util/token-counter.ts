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
 */
const MAX_CACHEABLE_INPUT_CHARS = 8 * 1024

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
    const cached = TOKEN_COUNT_CACHE.get(serialized)
    if (cached !== undefined) {
      return cached
    }
    const count = Math.floor(
      encode(serialized, { allowedSpecial: 'all' }).length *
        fudgeFactorForModel(model),
    )
    if (
      serialized.length > 100 &&
      serialized.length <= MAX_CACHEABLE_INPUT_CHARS
    ) {
      // Cache only smaller strings: bounded size keeps the entry-count LRU
      // from becoming a whole-transcript memory sink (M3-T2).
      TOKEN_COUNT_CACHE.set(serialized, count)
    }
    return count
  } catch (e) {
    console.error('Error counting tokens', e)
    return Math.ceil(serialized.length / 3)
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
export function countTokensJson(text: string | object, model?: string): number {
  return countTokens(
    typeof text === 'string'
      ? text
      : JSON.stringify(text, omitMediaPayloadsForTokenCount),
    model,
  )
}

export function countTokensForFiles(
  files: Record<string, string | null>,
): Record<string, number> {
  const tokenCounts: Record<string, number> = {}
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
