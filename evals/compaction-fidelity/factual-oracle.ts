/**
 * Deterministic B13 fixture oracle, not a prose/NLP judge.
 *
 * FACT[id][path]=<flat JSON object> is an explicit evidence record. IDs and
 * paths locate a claim; only complete, correctly typed values earn factual
 * credit. Every observed copy must agree: a correct duplicate never masks a
 * wrong, incomplete, malformed, or contradictory copy. Decision and rationale
 * (and blocker ID/status and push rule/negation) are indivisible claims.
 */
type FactValue = string | number | boolean | null

export interface FixtureFact {
  id: string
  path: string
  values: Readonly<Record<string, FactValue>>
}

/** Five next-decision facts plus one explicit decision/rationale from SPEC. */
export const MEMORY_FIXTURE_FACTS = [
  {
    id: 'timeout',
    path: 'src/services/keystone-config.ts',
    values: { timeoutMs: 1500 },
  },
  {
    id: 'force-push',
    path: 'src/services/session-store.ts',
    values: {
      forcePushMainRequiresExplicitRequest: true,
      instruction: 'do not force-push main without an explicit request',
    },
  },
  {
    id: 'blocker',
    path: 'src/services/token-refresh.ts',
    values: { blockerId: 'contract-consumer-v2', status: 'open' },
  },
  {
    id: 'source-revision',
    path: 'src/services/retry-policy.ts',
    values: { sourceRevision: 'order-schema@2' },
  },
  {
    id: 'next-action',
    path: 'src/services/retry-policy.ts',
    values: { nextAction: 'verify-order-contract-before-task-acceptance' },
  },
  {
    id: 'amounts-decision',
    path: 'src/services/keystone-config.ts',
    values: {
      decision: 'represent amounts in integer minor units',
      rationale: 'avoid binary floating-point drift at the shared contract',
    },
  },
] as const satisfies readonly FixtureFact[]

export const MEMORY_FIXTURE_PATHS = [
  ...new Set(MEMORY_FIXTURE_FACTS.map((fact) => fact.path)),
]

/** Adverse copies deliberately preserve the claim IDs and paths. */
export const FACTUAL_CORRUPTIONS: ReadonlyArray<{
  name: string
  id: (typeof MEMORY_FIXTURE_FACTS)[number]['id']
  values: Readonly<Record<string, FactValue>>
}> = [
  { name: 'zero timeout', id: 'timeout', values: { timeoutMs: 0 } },
  {
    name: 'dropped push negation',
    id: 'force-push',
    values: { forcePushMainRequiresExplicitRequest: true },
  },
  {
    name: 'contradicted push negation',
    id: 'force-push',
    values: {
      forcePushMainRequiresExplicitRequest: true,
      instruction: 'force-push main without an explicit request',
    },
  },
  {
    name: 'contradicted explicit-request flag',
    id: 'force-push',
    values: {
      forcePushMainRequiresExplicitRequest: false,
      instruction: 'do not force-push main without an explicit request',
    },
  },
  {
    name: 'closed blocker',
    id: 'blocker',
    values: { blockerId: 'contract-consumer-v2', status: 'closed' },
  },
  {
    name: 'stale source revision',
    id: 'source-revision',
    values: { sourceRevision: 'order-schema@1' },
  },
  {
    name: 'wrong next action',
    id: 'next-action',
    values: { nextAction: 'accept-order-task-without-contract-verification' },
  },
  {
    name: 'changed rationale',
    id: 'amounts-decision',
    values: {
      decision: 'represent amounts in integer minor units',
      rationale: 'prefer convenient binary floating-point arithmetic',
    },
  },
  {
    name: 'changed decision',
    id: 'amounts-decision',
    values: {
      decision: 'represent amounts in binary floating point',
      rationale: 'avoid binary floating-point drift at the shared contract',
    },
  },
]

export const renderFixtureFact = (
  fact: FixtureFact,
  values: Readonly<Record<string, FactValue>> = fact.values,
): string => `FACT[${fact.id}][${fact.path}]=${JSON.stringify(values)}`

export interface FactAssessment {
  id: string
  path: string
  identifierPresent: boolean
  covered: boolean
  claimCount: number
  missingFields: string[]
  incorrectFields: string[]
  malformedClaims: number
}

export interface FactualCoverage {
  identifierScore: number
  factualScore: number
  facts: FactAssessment[]
}

/**
 * Flat scalar JSON only. JSON.parse validates syntax/types; a token walk also
 * rejects duplicate property names (including escaped aliases). JSON's usual
 * last-key-wins behavior would hide a contradictory earlier assertion.
 */
const parseClaim = (payload: string): Record<string, FactValue> | undefined => {
  const text = payload.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined
  const values = parsed as Record<string, FactValue>
  if (
    !Object.values(values).every(
      (value) =>
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)),
    )
  )
    return undefined

  const property =
    /\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*/y
  const keys = new Set<string>()
  let offset = 1 // The opening brace; JSON.parse already validated the object.
  while (offset < text.length - 1) {
    property.lastIndex = offset
    const match = property.exec(text)
    if (!match) return Object.keys(values).length === 0 ? values : undefined
    const key: string = JSON.parse(match[1])
    if (keys.has(key)) return undefined
    keys.add(key)
    offset = property.lastIndex
    if (text[offset] === '}') break
    offset += 1 // Comma; syntax was checked above.
  }
  return values
}

/**
 * Read actual strings from message bodies, recall results, or summaries.
 * Archive writes serialize object-valued JSON parts; the index may serialize
 * that string once more. Decode only valid JSON wrappers, never fabricate
 * missing/truncated bytes or turn path-only tool-call inputs into values.
 */
export function collectFactualEvidence(source: unknown): string[] {
  const evidence: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 16) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (/^["{\[]/.test(trimmed)) {
        try {
          const decoded: unknown = JSON.parse(trimmed)
          if (decoded !== value) {
            visit(decoded, depth + 1)
            return
          }
        } catch {
          // An incomplete wrapper is not proof of the values it once held.
        }
      }
      evidence.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1)
    }
  }
  visit(source, 0)
  return evidence
}

/** Score logical requirements, not paths, retrieval hits, or duplicate count. */
export function evaluateFactualCoverage(
  evidence: readonly string[],
  expected: readonly FixtureFact[] = MEMORY_FIXTURE_FACTS,
): FactualCoverage {
  const claims = new Map<string, Array<Record<string, FactValue> | undefined>>()
  for (const text of evidence) {
    for (const line of text.split(/\r?\n/)) {
      const markers = [
        ...line.matchAll(/FACT\[([^\]\r\n]+)\]\[([^\]\r\n]+)\]/g),
      ]
      for (let index = 0; index < markers.length; index += 1) {
        const marker = markers[index]
        const key = JSON.stringify([marker[1], marker[2]])
        const suffix = line
          .slice(
            marker.index! + marker[0].length,
            markers[index + 1]?.index ?? line.length,
          )
          .trim()
        const claim = suffix.startsWith('=')
          ? parseClaim(suffix.slice(1))
          : undefined
        const copies = claims.get(key) ?? []
        copies.push(claim)
        claims.set(key, copies)
      }
    }
  }

  const facts = expected.map((fact): FactAssessment => {
    const copies = claims.get(JSON.stringify([fact.id, fact.path])) ?? []
    const missingFields = new Set<string>()
    const incorrectFields = new Set<string>()
    let malformedClaims = 0
    for (const copy of copies) {
      if (!copy) {
        malformedClaims += 1
        for (const key of Object.keys(fact.values)) missingFields.add(key)
        continue
      }
      for (const [key, value] of Object.entries(fact.values)) {
        if (!Object.hasOwn(copy, key)) missingFields.add(key)
        else if (copy[key] !== value) incorrectFields.add(key)
      }
      for (const key of Object.keys(copy)) {
        if (!Object.hasOwn(fact.values, key)) incorrectFields.add(key)
      }
    }
    const identifierPresent = copies.length > 0
    return {
      id: fact.id,
      path: fact.path,
      identifierPresent,
      covered:
        identifierPresent &&
        malformedClaims === 0 &&
        missingFields.size === 0 &&
        incorrectFields.size === 0,
      claimCount: copies.length,
      missingFields: [...missingFields],
      incorrectFields: [...incorrectFields],
      malformedClaims,
    }
  })
  return {
    identifierScore:
      expected.length === 0
        ? 0
        : facts.filter((fact) => fact.identifierPresent).length /
          expected.length,
    factualScore:
      expected.length === 0
        ? 0
        : facts.filter((fact) => fact.covered).length / expected.length,
    facts,
  }
}
