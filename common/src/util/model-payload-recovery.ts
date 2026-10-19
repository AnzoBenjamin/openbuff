/**
 * Hard ceiling on the serialized JSON text accepted in the set_output `data`
 * field. Oversized payloads historically slipped through decoding and vanished
 * downstream as transport-truncated garbage, so oversize is rejected before any
 * decode attempt — with explicit recovery guidance instead of failing silently
 * (M0-T3 sub-agent output durability).
 */
export const MODEL_PAYLOAD_JSON_CHAR_LIMIT = 1_000_000

// WHY THIS MODULE EXISTS (C1 of the json-overhaul): the reviewer-receipt shape
// constants below used to live in common/src/tools/params/tool/set-output.ts,
// but the runtime-side envelope unwrapping (below) needs the same
// receipt-shape concept. Consolidating them here gives both consumers one
// canonical definition; the params file re-imports them verbatim, so their
// values (and the `===`-identity-insensitive use via Set.has/every there)
// are unchanged.

// Reviewer-receipt enum values (mirrors outputSchema in
// agents/reviewer/code-reviewer.ts). The placeholder fill below is gated on
// these values so its coupling to the review receipt shape stays explicit
// instead of firing for any output that happens to reuse the field names.
export const REVIEWER_VERDICT_VALUES = new Set([
  'LOOKS_GOOD',
  'NON_BLOCKING',
  'BLOCKING',
])
export const REVIEWER_COVERAGE_VALUES = new Set(['covered', 'missing', 'n/a'])

export const GATE_CRITICAL_KEYS = [
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
] as const

export const ATTESTATION_CORE_KEYS = [
  'schemaVersion',
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
  'findings',
  'coverage',
] as const

export const REQUIRED_DIMENSION_KEYS = [
  'correctness',
  'security',
  'tests',
  'apiCompatibility',
  'performance',
] as const

export const TRUNCATION_DIMENSION_PLACEHOLDER =
  'recovered-from-truncated-receipt'

/** A receipt shape: object (non-null, non-array) with string verdict AND string snapshotFingerprint. */
export function isReceiptShape(candidate: unknown): boolean {
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof (candidate as Record<string, unknown>).verdict === 'string' &&
    typeof (candidate as Record<string, unknown>).snapshotFingerprint ===
      'string'
  )
}

/**
 * Content-addressed envelope recovery.
 *
 * WHY (user-corrected 2026-10-19): the previous jsonKey-only unwrap was a
 * narrow patch — models keep inventing envelope key names (jsonKey,
 * jsonValue, output, result, ...), so keying on the FIELD NAME chases the
 * bug forever. The principled rule is CONTENT-based: any object whose value
 * yields a receipt shape (string verdict + snapshotFingerprint) is the
 * receipt, regardless of the field name it traveled under.
 *
 * Applies ONLY when the rawOutput itself carries no verdict/fingerprint
 * keys (i.e. it is an envelope, not a receipt). All decode paths are
 * bounded, try/catch, and fall through to the ORIGINAL output unchanged so
 * the existing malformed-JSON + transport-truncation diagnostics keep
 * applying.
 */
export function unwrapArbitraryEnvelope(
  rawOutput: Record<string, unknown> | undefined,
  opts?: { maxJsonChars?: number },
): Record<string, unknown> | undefined {
  const maxJsonChars = opts?.maxJsonChars ?? MODEL_PAYLOAD_JSON_CHAR_LIMIT
  if (!rawOutput) return rawOutput

  // Fast path: the rawOutput is already a receipt at top level.
  if (isReceiptShape(rawOutput)) return rawOutput
  if ('verdict' in rawOutput || 'snapshotFingerprint' in rawOutput) {
    // Semi-receipt shape (has fingerprint but not verdict, or vice versa) —
    // NOT an envelope, so leave it for schema validation to diagnose.
    return rawOutput
  }

  // 1. Native-object receipt candidate: any value field whose native object
  //    is already receipt-shaped. Returns the receipt itself.
  for (const candidate of Object.values(rawOutput)) {
    if (isReceiptShape(candidate)) {
      return candidate as Record<string, unknown>
    }
  }

  // 2. Stringified receipt candidate: any string-valued field that decodes
  //    (bounded, try/catch) to a receipt-shaped object. Reuses the existing
  //    decoder so fenced-json + truncated-receipt recovery keep applying —
  //    and the field NAME is irrelevant (jsonKey, jsonValue, output,
  //    result, ... are all covered by the same content rule).
  for (const candidate of Object.values(rawOutput)) {
    if (typeof candidate !== 'string' || candidate.length > maxJsonChars) {
      continue
    }
    const decoded = decodeJsonObjectString(candidate)
    if (isReceiptShape(decoded)) {
      return decoded as Record<string, unknown>
    }
  }

  return rawOutput
}

/**
 * Recover complete top-level fields from a truncated JSON object string.
 * Only includes keys whose values fully close; never invents incomplete values.
 * When the recovered fields form a reviewer receipt (attestation-core fields
 * plus a recognized verdict/coverage pair) but dimensions/requirementCoverage
 * were cut off mid-essay, fills minimal placeholders so schema validation can
 * still accept a receipt the model already decided. Non-reviewer outputs are
 * returned as recovered, without the reviewer-only keys injected.
 *
 * Moved verbatim to this module in C2 of the json-overhaul; reviewer-receipt
 * gating uses the constants defined above in this same module.
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

/**
 * Decode a possibly-encoded JSON object string: strips code fences and
 * `// json` prologues on each of up to three stringification layers, falls
 * back to truncated-object recovery on parse failure, and returns non-object
 * results (primitives, arrays) as the ORIGINAL untouched input. Moved verbatim
 * to this module in C2 of the json-overhaul.
 */
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


// C2 of the json-overhaul: the entire JSON decode layer (the internal scan
// helpers below plus recoverTruncatedJsonObject and decodeJsonObjectString)
// moved verbatim from common/src/tools/params/tool/set-output.ts so all
// recovery logic has one canonical home. The params file re-imports and
// re-exports the two public entry points so importer paths stay untouched.

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
