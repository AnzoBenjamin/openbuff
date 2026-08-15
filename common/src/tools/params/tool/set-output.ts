import z from 'zod/v4'

import { $getNativeToolCallExampleString } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'set_output'
const endsAgentStep = false
// Reviewer-only scope: these are the array/object fields of the reviewer
// receipt schema (agents/reviewer/code-reviewer.ts). Stringified containers
// under any other field name are intentionally left as strings; a future
// non-reviewer agent with stringified array/object fields must add its own
// field names here (or get its own normalization pass).
const structuredContainerFields = new Set([
  'reviewedFiles',
  'findings',
  'dimensions',
  'requirementCoverage',
])

const GATE_CRITICAL_KEYS = [
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
] as const

const ATTESTATION_CORE_KEYS = [
  'schemaVersion',
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
  'findings',
  'coverage',
] as const

// Reviewer-receipt enum values (mirrors outputSchema in
// agents/reviewer/code-reviewer.ts). The placeholder fill below is gated on
// these values so its coupling to the review receipt shape stays explicit
// instead of firing for any output that happens to reuse the field names.
const REVIEWER_VERDICT_VALUES = new Set([
  'LOOKS_GOOD',
  'NON_BLOCKING',
  'BLOCKING',
])
const REVIEWER_COVERAGE_VALUES = new Set(['covered', 'missing', 'n/a'])

const REQUIRED_DIMENSION_KEYS = [
  'correctness',
  'security',
  'tests',
  'apiCompatibility',
  'performance',
] as const

const TRUNCATION_DIMENSION_PLACEHOLDER = 'recovered-from-truncated-receipt'

// When requirementCoverage is truncated off entirely, do not synthesize
// `[]` under the recovered verdict. The gate finalizes only on LOOKS_GOOD, so
// an empty placeholder would finalize with zero requirement evidence. Inject
// an explicit `uncertain` entry and force verdict BLOCKING so a mid-essay
// truncate cannot pass as a complete review.

const scanJsonStringEnd = (s: string, start: number): number | undefined => {
  if (s[start] !== '"') return undefined
  let i = start + 1
  while (i < s.length) {
    const c = s[i]!
    if (c === '"') return i + 1
    if (c === '\\') {
      if (i + 1 >= s.length) return undefined
      if (s[i + 1] === 'u') {
        if (i + 5 >= s.length) return undefined
        i += 6
      } else {
        i += 2
      }
      continue
    }
    i++
  }
  return undefined
}

const scanComplexEnd = (s: string, start: number): number | undefined => {
  const open = s[start]
  if (open !== '{' && open !== '[') return undefined
  let depth = 0
  let i = start
  while (i < s.length) {
    const c = s[i]!
    if (c === '"') {
      const end = scanJsonStringEnd(s, i)
      if (end === undefined) return undefined
      i = end
      continue
    }
    if (c === '{' || c === '[') {
      depth++
      i++
      continue
    }
    if (c === '}' || c === ']') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  return undefined
}

const scanPrimitiveEnd = (s: string, start: number): number | undefined => {
  if (s.startsWith('true', start)) return start + 4
  if (s.startsWith('false', start)) return start + 5
  if (s.startsWith('null', start)) return start + 4
  const match = s
    .slice(start)
    .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
  return match ? start + match[0].length : undefined
}

const parseCompleteJsonValue = (
  s: string,
  start: number,
): { value: unknown; end: number } | undefined => {
  const c = s[start]
  if (c === undefined) return undefined

  let end: number | undefined
  if (c === '"') end = scanJsonStringEnd(s, start)
  else if (c === '{' || c === '[') end = scanComplexEnd(s, start)
  else end = scanPrimitiveEnd(s, start)

  if (end === undefined) return undefined
  try {
    return { value: JSON.parse(s.slice(start, end)) as unknown, end }
  } catch {
    return undefined
  }
}

/**
 * Recover complete top-level fields from a truncated JSON object string.
 * Only includes keys whose values fully close; never invents incomplete values.
 * When the recovered fields form a reviewer receipt (attestation-core fields
 * plus a recognized verdict/coverage pair) but dimensions/requirementCoverage
 * were cut off mid-essay, fills minimal placeholders so schema validation can
 * still accept a receipt the model already decided. Non-reviewer outputs are
 * returned as recovered, without the reviewer-only keys injected.
 */
export const recoverTruncatedJsonObject = (
  input: string,
): Record<string, unknown> | undefined => {
  const s = input.trim()
  if (!s.startsWith('{')) return undefined

  const result: Record<string, unknown> = {}
  let i = 1
  const n = s.length

  const skipWs = () => {
    while (i < n && /\s/.test(s[i]!)) i++
  }

  while (i < n) {
    skipWs()
    if (i >= n || s[i] === '}') break

    if (s[i] !== '"') break
    const keyParsed = parseCompleteJsonValue(s, i)
    if (!keyParsed || typeof keyParsed.value !== 'string') break
    i = keyParsed.end
    skipWs()
    if (i >= n || s[i] !== ':') break
    i++
    skipWs()
    if (i >= n) break

    const valueParsed = parseCompleteJsonValue(s, i)
    if (!valueParsed) break
    result[keyParsed.value] = valueParsed.value
    i = valueParsed.end
    skipWs()
    if (i >= n) break
    if (s[i] === ',') {
      i++
      continue
    }
    if (s[i] === '}') break
    break
  }

  if (Object.keys(result).length === 0) return undefined

  const hasGateCritical = GATE_CRITICAL_KEYS.some((key) => key in result)
  if (!hasGateCritical) return undefined

  const hasAttestationCore = ATTESTATION_CORE_KEYS.every((key) => key in result)
  // Explicit reviewer-receipt gate: filling dimensions/requirementCoverage is
  // only valid for the review receipt schema. Requiring recognized
  // verdict/coverage values keeps non-reviewer subagents whose dynamic schema
  // omits those keys (but reuses the attestation field names) from getting
  // reviewer-only keys injected into their output.
  const isReviewerReceipt =
    hasAttestationCore &&
    typeof result.verdict === 'string' &&
    REVIEWER_VERDICT_VALUES.has(result.verdict) &&
    typeof result.coverage === 'string' &&
    REVIEWER_COVERAGE_VALUES.has(result.coverage)
  if (isReviewerReceipt) {
    const dims = result.dimensions
    if (!dims || typeof dims !== 'object' || Array.isArray(dims)) {
      result.dimensions = Object.fromEntries(
        REQUIRED_DIMENSION_KEYS.map((key) => [
          key,
          TRUNCATION_DIMENSION_PLACEHOLDER,
        ]),
      )
    } else {
      const dimObj = { ...(dims as Record<string, unknown>) }
      for (const key of REQUIRED_DIMENSION_KEYS) {
        if (typeof dimObj[key] !== 'string') {
          dimObj[key] = TRUNCATION_DIMENSION_PLACEHOLDER
        }
      }
      result.dimensions = dimObj
    }
    if (!Array.isArray(result.requirementCoverage)) {
      result.requirementCoverage = [
        {
          requirement: 'requirementCoverage',
          status: 'uncertain',
          evidence: [TRUNCATION_DIMENSION_PLACEHOLDER],
        },
      ]
      result.verdict = 'BLOCKING'
    }
  }

  return result
}

export const decodeJsonObjectString = (value: unknown): unknown => {
  let decoded = value
  for (let depth = 0; depth < 3 && typeof decoded === 'string'; depth++) {
    let candidate = decoded.trim()
    const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if (fenced) candidate = fenced[1].trim()
    candidate = candidate.replace(/^\/\/\s*json\s*(?:\r?\n|$)/i, '')

    try {
      decoded = JSON.parse(candidate) as unknown
    } catch {
      let recoverCandidate = candidate
      if (!recoverCandidate.startsWith('{')) {
        recoverCandidate = recoverCandidate
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/^\/\/\s*json\s*(?:\r?\n|$)/i, '')
          .trim()
      }
      const recovered = recoverTruncatedJsonObject(recoverCandidate)
      if (recovered) return recovered
      return value
    }
  }

  return decoded !== null &&
    typeof decoded === 'object' &&
    !Array.isArray(decoded)
    ? decoded
    : value
}

export const normalizeStructuredOutputValue = (
  value: unknown,
  fieldName?: string,
  depth = 0,
): unknown => {
  if (depth > 8) return value
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (fieldName === 'schemaVersion' && /^\d+$/.test(candidate)) {
      return Number(candidate)
    }
    const canDecodeContainer =
      fieldName !== undefined && structuredContainerFields.has(fieldName)
    if (
      canDecodeContainer &&
      ((candidate.startsWith('{') && candidate.endsWith('}')) ||
        (candidate.startsWith('[') && candidate.endsWith(']')))
    ) {
      try {
        return normalizeStructuredOutputValue(
          JSON.parse(candidate) as unknown,
          fieldName,
          depth + 1,
        )
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeStructuredOutputValue(item, undefined, depth + 1),
    )
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeStructuredOutputValue(item, key, depth + 1),
    ]),
  )
}

// WHY `data` EXISTS IN THE INPUT SCHEMA:
// Subagents inherit their parent's tool definitions, and because of prompt caching
// we cannot modify or add tools mid-conversation. OpenAI models enforce the tool's
// input schema strictly, so we need a permissive shape that any model can call.
// An empty schema or `z.object({}).passthrough()` would be rejected by OpenAI's
// strict schema enforcement. The `data: z.record(...)` field is a deliberately
// vague shape that satisfies OpenAI while allowing us to inject the real
// outputSchema later in the conversation (in the instructions prompt).
//
// At runtime, the handler (`packages/agent-runtime/src/tools/handlers/tool/set-output.ts`)
// tries parsing against the real outputSchema in two ways:
//   1. Parse the raw output (agent passed fields at top level)
//   2. Fallback: parse `output.data` (agent wrapped fields in `data`)
// This means both `{ results: [...] }` and `{ data: { results: [...] } }` are accepted.
const inputSchema = z
  .looseObject({
    data: z
      .preprocess(decodeJsonObjectString, z.record(z.string(), z.any()))
      .optional(),
  })
  .describe(
    'JSON object to set as the agent output. The shape of the parameters are specified dynamically further down in the conversation. This completely replaces any previous output. If the agent was spawned, this value will be passed back to its parent. If the agent has an outputSchema defined, the output will be validated against it.',
  )
const description = `
Use this tool to publish an explicit structured receipt when your instructions require it (for example reviewers). It is not the only possible channel: if your instructions say the parent harvests plain assistant text, do not call this tool just to publish the answer.

Note that the output schema is provided dynamically in a user prompt further down in the conversation. Be sure to follow what the latest output schema is when using this tool.

Please set the output with all the information and analysis you want to pass on. Pass native object fields; never call JSON.stringify or place serialized JSON text inside data. If you just want to send a simple message, use an object with the key "message" and value of the message you want to send.
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    message: 'I found a bug in the code!',
  },
  endsAgentStep,
})}
`.trim()

export const setOutputParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }),
  ]),
} satisfies $ToolParams
