/**
 * Recognises provider "request exceeds the context window" errors across the
 * BYOK providers (N08 / memory-context-07). The SDK's own adaptive retry only
 * fires when it can read a numeric limit from the OpenAI/Anthropic wordings;
 * anything else reaches the agent loop, which compacts harder and retries
 * once when this classifier matches.
 */

export type ContextOverflowClassification = {
  /** Which wording or code matched, for logs and the compaction reason. */
  matched: string
  /** Context limit the provider reported, when the message carries one. */
  providerLimitTokens?: number
}

const OVERFLOW_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['context_length_exceeded', /context_length_exceeded/i],
  // OpenAI and vLLM (OpenAI-compatible): "This model's maximum context length is 4096 tokens"
  ['maximum context length', /maximum context length/i],
  // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum"
  ['prompt is too long', /prompt is too long/i],
  // Gemini: "The input token count (1050000) exceeds the maximum number of tokens allowed (1048576)"
  ['gemini input token count', /exceeds the maximum number of tokens/i],
  // vLLM: "The decoder prompt (length 5000) is longer than the maximum model length of 4096"
  ['vllm maximum model length', /longer than the maximum model length/i],
  // vLLM: "Input prompt (5000 tokens) is too long and exceeds limit of 4096"
  ['vllm exceeds limit', /too long and exceeds (?:the )?limit/i],
  // Ollama: "the input length exceeds the context length"
  // llama.cpp: "the request exceeds the available context size"
  [
    'exceeds context length',
    /exceed(?:s|ed)?\s+(?:the\s+)?(?:available\s+|maximum\s+|max\s+)?context\s+(?:length|size|window)/i,
  ],
  // LM Studio: "Trying to keep the first 5000 tokens when context the overflows.
  // However, the model is loaded with context length of only 4096 tokens"
  ['lm studio context overflow', /context (?:the )?overflows/i],
  [
    'lm studio context length of only',
    /loaded with context length of only/i,
  ],
  [
    'lm studio tokens to keep',
    /tokens to keep from the initial prompt is greater than the context length/i,
  ],
  ['context window exceeded', /context (?:window|length|size) (?:exceeded|overflow)/i],
  // Bedrock: "Input is too long for requested model."
  ['input is too long', /input is too long/i],
]

const LIMIT_PATTERNS: readonly RegExp[] = [
  /tokens?\s*>\s*([\d,]+)\s+maximum/i,
  /maximum context length(?:\s+is|:)\s*([\d,]+)\s*tokens?/i,
  /maximum number of tokens allowed\s*\(([\d,]+)\)/i,
  /maximum model length of\s*([\d,]+)/i,
  /exceeds (?:the )?limit of\s*([\d,]+)/i,
  /context length of only\s*([\d,]+)/i,
  /context(?:_|\s)length(?:\s+is|:)\s*([\d,]+)\s*tokens?/i,
  /n_ctx(?:_slot)?\s*[=:]\s*([\d,]+)/i,
]

// Rate-limit and quota errors also talk about tokens; they are not overflow.
const NOT_OVERFLOW = /rate.?limit|per.?minute|tokens per min|quota|too many requests/i

function collectErrorTexts(error: unknown): { texts: string[]; status?: number } {
  const texts: string[] = []
  let status: number | undefined
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value == null || seen.has(value)) return
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (typeof value !== 'object') return
    seen.add(value)
    if (value instanceof Error) texts.push(value.message)
    const record = value as Record<string, unknown>
    for (const key of ['statusCode', 'status']) {
      const candidate = record[key]
      if (status === undefined && typeof candidate === 'number') status = candidate
    }
    for (const key of [
      'message',
      'code',
      'type',
      'responseBody',
      'body',
      'data',
      'error',
      'cause',
      'lastError',
      'errors',
    ]) {
      if (!(key in record)) continue
      const nested = record[key]
      if (Array.isArray(nested)) {
        for (const item of nested.slice(0, 8)) visit(item, depth + 1)
      } else {
        visit(nested, depth + 1)
      }
    }
  }
  visit(error, 0)
  return { texts, status }
}

export function classifyContextOverflowError(
  error: unknown,
): ContextOverflowClassification | undefined {
  const { texts, status } = collectErrorTexts(error)
  const text = texts.join('\n')
  if (status === 429 || NOT_OVERFLOW.test(text)) return undefined
  let matched = OVERFLOW_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0]
  if (!matched && status === 413) matched = 'http 413'
  if (!matched) return undefined
  for (const pattern of LIMIT_PATTERNS) {
    const value = text.match(pattern)?.[1]
    const parsed = value ? Number.parseInt(value.replace(/,/g, ''), 10) : NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      return { matched, providerLimitTokens: parsed }
    }
  }
  return { matched }
}
