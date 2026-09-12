import {
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryConsolidationOutcomeSchema,
  MemoryConsolidationRequestSchema,
  MemoryCorrectionOutcomeSchema,
  MemoryCorrectionRequestSchema,
  MemoryEventDraftSchema,
  MemoryEventEnvelopeSchema,
  MemoryExportManifestV2Schema,
  MemoryExportOutcomeSchema,
  MemoryExportRequestSchema,
  MemoryHealthSchema,
  MemoryManifestExportOutcomeSchema,
  MemoryManifestExportRequestSchema,
  MemoryManifestImportOutcomeSchema,
  MemoryManifestImportRequestSchema,
  MemoryProjectionRepairOutcomeSchema,
  MemoryProjectionRepairRequestSchema,
  MemoryRebuildOutcomeSchema,
  MemoryRebuildRequestSchema,
  MemoryRevalidationOutcomeSchema,
  MemoryRevalidationRequestSchema,
  MemoryVerifyOutcomeSchema,
  MemoryVerifyRequestSchema,
  type MemoryConsolidationOutcome,
  type MemoryCorrectionOutcome,
  type MemoryEventDraft,
  type MemoryEventEnvelope,
  type MemoryExportManifestV2,
  type MemoryExportEventV2,
  type MemoryManifestExportOutcome,
  type MemoryManifestImportOutcome,
  type MemoryObservation,
  type MemoryOperationError,
  type MemoryProjectionRepairOutcome,
  type MemoryRevalidationOutcome,
  type MemorySelector,
} from '@codebuff/common/types/memory-v2'

import type { MemoryRepositoryV2 } from './types'

const EXPORT_PAGE_SIZE = 1_000
const MAX_EXPORT_PAGES = 10
const MAX_CANONICAL_EVENTS = EXPORT_PAGE_SIZE * MAX_EXPORT_PAGES
const MAX_GROUP_SOURCES = 19
const MAX_MANIFEST_EVENTS_ENCODED_BYTES = 32 * 1024 * 1024
const MAX_EXPORT_WARNINGS = 100
const SHA256_ZERO = `sha256:${'0'.repeat(64)}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function jsonStringEncodedBytes(value: string, budget: number): number {
  let bytes = 2
  for (let index = 0; index < value.length && bytes <= budget; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2
    } else if (code <= 0x1f) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index++
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

function encodedJsonExceeds(value: unknown, budget: number): boolean {
  type Work = { kind: 'value'; value: unknown } | { kind: 'leave'; value: object }
  const work: Work[] = [{ kind: 'value', value }]
  const active = new WeakSet<object>()
  let bytes = 0
  const add = (amount: number) => {
    bytes += amount
    return bytes > budget
  }
  while (work.length > 0 && bytes <= budget) {
    const item = work.pop()!
    if (item.kind === 'leave') {
      active.delete(item.value)
      continue
    }
    const current = item.value
    if (current === null) {
      add(4)
    } else if (typeof current === 'string') {
      add(jsonStringEncodedBytes(current, budget - bytes))
    } else if (typeof current === 'number') {
      add(Number.isFinite(current) ? String(current).length : 4)
    } else if (typeof current === 'boolean') {
      add(current ? 4 : 5)
    } else if (Array.isArray(current)) {
      if (active.has(current)) return true
      active.add(current)
      if (add(2 + Math.max(0, current.length - 1))) break
      work.push({ kind: 'leave', value: current })
      for (let index = current.length - 1; index >= 0; index--) {
        work.push({ kind: 'value', value: current[index] })
      }
    } else if (isRecord(current)) {
      if (active.has(current)) return true
      active.add(current)
      const entries = Object.entries(current)
      if (add(2 + Math.max(0, entries.length - 1) + entries.length)) break
      work.push({ kind: 'leave', value: current })
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index]!
        work.push({ kind: 'value', value: child })
        work.push({ kind: 'value', value: key })
      }
    } else {
      add(4)
    }
  }
  return bytes > budget
}

function manifestEventsExceedBudget(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.manifest) || !('events' in input.manifest)) return false
  return encodedJsonExceeds(input.manifest.events, MAX_MANIFEST_EVENTS_ENCODED_BYTES)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(null)
}

const rotateRight = (value: number, amount: number): number =>
  (value >>> amount) | (value << (32 - amount))

/** Small synchronous SHA-256 implementation keeps this service free of runtime imports. */
function sha256(input: string): string {
  const constants: number[] = []
  const initial: number[] = []
  let candidate = 2
  while (constants.length < 64) {
    let prime = true
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        prime = false
        break
      }
    }
    if (prime) {
      if (initial.length < 8) initial.push((Math.sqrt(candidate) * 0x1_0000_0000) | 0)
      constants.push((Math.cbrt(candidate) * 0x1_0000_0000) | 0)
    }
    candidate++
  }
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  const hash = initial.slice()
  const words = new Int32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getInt32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!
      const b = words[index - 2]!
      const sigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const sigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) | 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)
      const choice = (e! & f!) ^ (~e! & g!)
      const temp1 = (h! + sum1 + choice + constants[index]! + words[index]!) | 0
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const temp2 = (sum0 + majority) | 0
      h = g
      g = f
      f = e
      e = (d! + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    hash[0] = (hash[0]! + a!) | 0
    hash[1] = (hash[1]! + b!) | 0
    hash[2] = (hash[2]! + c!) | 0
    hash[3] = (hash[3]! + d!) | 0
    hash[4] = (hash[4]! + e!) | 0
    hash[5] = (hash[5]! + f!) | 0
    hash[6] = (hash[6]! + g!) | 0
    hash[7] = (hash[7]! + h!) | 0
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

const digest = (value: unknown): string => `sha256:${sha256(stableJson(value))}`
const derivedId = (kind: 'event' | 'observation', value: unknown): string =>
  `${kind}:${sha256(stableJson(value))}`

const operationalError = (
  code: MemoryOperationError['code'],
  message: string,
  retryable = false,
): MemoryOperationError => ({ code, message: message.slice(0, 4_096), retryable })

class ExpectedOperationFailure extends Error {
  constructor(readonly operationError: MemoryOperationError) {
    super(operationError.message)
  }
}

const failedError = (error: unknown): MemoryOperationError =>
  error instanceof ExpectedOperationFailure
    ? error.operationError
    : operationalError('internal', 'Memory operator failed', true)

const eventOrder = (left: MemoryEventEnvelope, right: MemoryEventEnvelope): number =>
  left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)

function selectorFacet(selector: MemorySelector): string {
  switch (selector.kind) {
    case 'file':
      return `file:${selector.path.replaceAll('\\', '/').toLowerCase()}`
    case 'line-range':
      return `line:${selector.path.replaceAll('\\', '/').toLowerCase()}:${selector.startLine}:${selector.endLine}`
    case 'symbol':
      return `symbol:${selector.path.replaceAll('\\', '/').toLowerCase()}:${selector.symbol}:${selector.occurrence}`
    case 'json-pointer':
      return `json:${selector.path.replaceAll('\\', '/').toLowerCase()}:${selector.pointer}`
    case 'uri-fragment':
      return `uri:${selector.uri.toLowerCase()}#${selector.fragment}`
  }
}

interface ActiveObservation {
  observation: MemoryObservation
  sourceEventId: MemoryEventEnvelope['eventId']
}

function activeObservations(events: MemoryEventEnvelope[]): Map<string, ActiveObservation> {
  const active = new Map<string, ActiveObservation>()
  for (const event of events) {
    switch (event.eventType) {
      case 'observation.recorded':
        active.set(event.payload.observation.observationId, {
          observation: event.payload.observation,
          sourceEventId: event.eventId,
        })
        break
      case 'claim.consolidated':
        for (const id of event.payload.sourceObservationIds) active.delete(id)
        active.set(event.payload.canonicalObservation.observationId, {
          observation: event.payload.canonicalObservation,
          sourceEventId: event.eventId,
        })
        break
      case 'claim.corrected':
        active.delete(event.payload.observationId)
        active.set(event.payload.correction.observationId, {
          observation: event.payload.correction,
          sourceEventId: event.eventId,
        })
        break
      case 'claim.forgotten':
        for (const id of event.payload.observationIds) active.delete(id)
        break
      case 'claim.superseded':
        active.delete(event.payload.observationId)
        break
    }
  }
  return active
}

function observationTaskIds(events: MemoryEventEnvelope[]): Map<string, string> {
  const tasks = new Map<string, string>()
  for (const event of events) {
    if (event.eventType === 'observation.recorded') {
      tasks.set(event.payload.observation.observationId, event.payload.observation.taskId)
    } else if (event.eventType === 'claim.consolidated') {
      tasks.set(
        event.payload.canonicalObservation.observationId,
        event.payload.canonicalObservation.taskId,
      )
    } else if (event.eventType === 'claim.corrected') {
      tasks.set(event.payload.correction.observationId, event.payload.correction.taskId)
    }
  }
  return tasks
}

function staleObservationReasons(
  events: MemoryEventEnvelope[],
): Map<string, Set<'forgotten' | 'superseded' | 'corrected'>> {
  const stale = new Map<string, Set<'forgotten' | 'superseded' | 'corrected'>>()
  const add = (id: string, reason: 'forgotten' | 'superseded' | 'corrected') => {
    const reasons = stale.get(id) ?? new Set()
    reasons.add(reason)
    stale.set(id, reasons)
  }
  for (const event of events) {
    if (event.eventType === 'claim.forgotten') {
      for (const id of event.payload.observationIds) add(id, 'forgotten')
    } else if (event.eventType === 'claim.superseded') {
      add(event.payload.observationId, 'superseded')
    } else if (event.eventType === 'claim.corrected') {
      add(event.payload.observationId, 'corrected')
    } else if (event.eventType === 'claim.consolidated') {
      for (const id of event.payload.sourceObservationIds) add(id, 'superseded')
    }
  }
  return stale
}

const normalizeSensitiveKey = (key: string): string => key.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
const SENSITIVE_KEYS = new Set([
  'excerpt', 'content', 'body', 'stdout', 'stderr', 'log', 'logs', 'secret', 'secrets',
  'token', 'tokens', 'password', 'passwords', 'passwd', 'authorization', 'cookie', 'raw',
  'apikey', 'clientsecret', 'privatekey', 'accesstoken', 'refreshtoken',
])
const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(normalizeSensitiveKey(key))
const PRIVATE_KEY_PEM = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const SECRET_ASSIGNMENT = /(\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|apiKey|clientSecret|privateKey|accessToken|refreshToken|password)\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi
const GITHUB_TOKEN = /\b(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g
const AWS_ACCESS_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g

interface SanitizationStats {
  redactedValues: number
}

function replaceRedacted(
  value: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
  stats: SanitizationStats,
): string {
  return value.replace(pattern, (...args: [string, ...unknown[]]) => {
    stats.redactedValues++
    if (typeof replacement === 'string') return replacement
    const groups = args.slice(1, -2).map(String)
    return replacement(args[0], ...groups)
  })
}

function redactString(value: string, stats: SanitizationStats): string {
  let redacted = replaceRedacted(value, PRIVATE_KEY_PEM, '[REDACTED]', stats)
  redacted = replaceRedacted(
    redacted,
    SECRET_ASSIGNMENT,
    (_match, prefix, secretValue) => {
      const quote = secretValue.startsWith('"') || secretValue.startsWith("'")
        ? secretValue[0]
        : ''
      return `${prefix}${quote}[REDACTED]${quote}`
    },
    stats,
  )
  redacted = replaceRedacted(redacted, BEARER_TOKEN, (_match, prefix) => `${prefix}[REDACTED]`, stats)
  redacted = replaceRedacted(redacted, GITHUB_TOKEN, '[REDACTED]', stats)
  redacted = replaceRedacted(redacted, AWS_ACCESS_ID, '[REDACTED]', stats)
  redacted = replaceRedacted(redacted, /(?:^|\s)\/home\/[^\s/]+/g, ' [redacted-home]', stats)
  redacted = replaceRedacted(
    redacted,
    /(?:^|\s)\/(?:Users|private|etc|var|tmp)\/[^\s]*/g,
    ' [redacted-path]',
    stats,
  )
  return replaceRedacted(
    redacted,
    /[A-Za-z]:\\Users\\[^\s\\]+(?:\\[^\s]*)?/g,
    '[redacted-home]',
    stats,
  ).trim()
}

function sanitizeJson(value: unknown, stats: SanitizationStats): unknown {
  if (typeof value === 'string') return redactString(value, stats)
  if (Array.isArray(value)) return value.map((child) => sanitizeJson(child, stats))
  if (!isRecord(value)) return value
  const sanitized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      stats.redactedValues++
      continue
    }
    sanitized[key] = sanitizeJson(child, stats)
  }
  return sanitized
}

function sanitizeEvent(
  sourceEvent: MemoryEventEnvelope,
): { event?: MemoryEventEnvelope; redactedValues: number } {
  const candidate = structuredClone(sourceEvent)
  const stats: SanitizationStats = { redactedValues: 0 }
  const removeExcerpt = (evidence: { excerpt?: string }) => {
    if (evidence.excerpt !== undefined) {
      delete evidence.excerpt
      stats.redactedValues++
    }
  }
  if (candidate.eventType === 'observation.recorded') {
    for (const evidence of candidate.payload.observation.evidence) removeExcerpt(evidence)
  } else if (candidate.eventType === 'claim.consolidated') {
    for (const evidence of candidate.payload.canonicalObservation.evidence) removeExcerpt(evidence)
  } else if (candidate.eventType === 'claim.corrected') {
    for (const evidence of candidate.payload.correction.evidence) removeExcerpt(evidence)
  } else if (candidate.eventType === 'evidence.attached') {
    for (const evidence of candidate.payload.evidence) removeExcerpt(evidence)
  } else if (candidate.eventType === 'evidence.rebound') {
    removeExcerpt(candidate.payload.evidence)
  }
  const parsed = MemoryEventEnvelopeSchema.safeParse(sanitizeJson(candidate, stats))
  return {
    ...(parsed.success ? { event: parsed.data } : {}),
    redactedValues: stats.redactedValues,
  }
}

const isVerificationLifecycleEvent = (event: MemoryEventEnvelope): boolean =>
  event.eventType === 'evidence.verified' ||
  event.eventType === 'evidence.invalidated' ||
  event.eventType === 'evidence.rebound'

function manifestChecksum(manifest: MemoryExportManifestV2): string {
  const { checksum: _checksum, ...unsigned } = manifest
  return digest(unsigned)
}

function renderMarkdown(manifest: MemoryExportManifestV2): string {
  const lines = [
    '# Memory V2 Export',
    '',
    '> Generated, non-authoritative artifact. Do not treat this file as canonical memory.',
    '',
    `- Project: \`${manifest.projectId}\``,
    `- Generated: ${manifest.generatedAt}`,
    `- Canonical events: ${manifest.canonicalEventCount}`,
    `- Included events: ${manifest.events.length}`,
    `- Checksum: \`${manifest.checksum}\``,
    `- Stale included: ${manifest.stalePolicy.includeStale}`,
    '',
    '## Events',
  ]
  for (const item of manifest.events) {
    lines.push(
      '',
      `- **${item.event.eventType}** \`${item.event.eventId}\` (sequence ${item.event.sequence}, ${item.lifecycle})`,
    )
  }
  return lines.join('\n').slice(0, 1_000_000)
}

export class MemoryV2OperatorService {
  constructor(private readonly repository: MemoryRepositoryV2) {}

  private async allEvents(projectId: MemoryEventEnvelope['projectId']): Promise<MemoryEventEnvelope[]> {
    const events: MemoryEventEnvelope[] = []
    let afterEventId: MemoryEventEnvelope['eventId'] | undefined
    const cursors = new Set<string>()
    for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
      const request = MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId,
        ...(afterEventId ? { afterEventId } : {}),
        limit: EXPORT_PAGE_SIZE,
      })
      const outcome = MemoryExportOutcomeSchema.parse(await this.repository.export(request))
      if (outcome.outcome !== 'page') {
        throw new ExpectedOperationFailure(
          operationalError(
            outcome.error.code,
            'Memory repository export failed',
            outcome.error.retryable,
          ),
        )
      }
      events.push(...outcome.events)
      if (events.length > MAX_CANONICAL_EVENTS) throw new Error('Canonical event limit exceeded')
      if (outcome.nextAfterEventId === null) return events.sort(eventOrder)
      if (cursors.has(outcome.nextAfterEventId)) throw new Error('Repository export cursor repeated')
      cursors.add(outcome.nextAfterEventId)
      afterEventId = outcome.nextAfterEventId
    }
    throw new Error('Canonical export page limit exceeded')
  }

  async consolidate(input: unknown): Promise<MemoryConsolidationOutcome> {
    const parsed = MemoryConsolidationRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryConsolidationOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid consolidation request'),
      })
    }
    const request = parsed.data
    try {
      const events = await this.allEvents(request.projectId)
      const grouped = new Map<string, ActiveObservation[]>()
      for (const active of activeObservations(events).values()) {
        const observation = active.observation
        if (request.taskId && observation.taskId !== request.taskId) continue
        const selector = observation.selectors?.[0] ?? observation.evidence[0]?.selector
        const facet = selector
          ? selectorFacet(selector)
          : observation.evidence[0]?.artifact.location
            ? `artifact:${observation.evidence[0].artifact.location.replaceAll('\\', '/').toLowerCase()}`
            : undefined
        if (!facet) continue
        const key = `${observation.taskId}\u0000${facet}\u0000${observation.kind}`
        const values = grouped.get(key) ?? []
        values.push(active)
        grouped.set(key, values)
      }
      const candidates = [...grouped.entries()]
        .filter(([, values]) => values.length >= 2)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, request.maxGroups)
        .map(([key, values]) => {
          const sources = values
            .sort((left, right) =>
              left.observation.observationId.localeCompare(right.observation.observationId),
            )
            .slice(0, MAX_GROUP_SOURCES)
          const [taskId, facet, observationKind] = key.split('\u0000')
          const sourceObservationIds = sources.map(
            ({ observation }) => observation.observationId,
          )
          const canonicalObservationId = derivedId('observation', {
            projectId: request.projectId,
            policyVersion: request.policyVersion,
            taskId,
            facet,
            observationKind,
            sourceObservationIds,
          })
          return {
            taskId,
            facet,
            observationKind,
            sourceObservationIds,
            canonicalObservationId,
            sources,
          }
        })
      if (candidates.length === 0) {
        return MemoryConsolidationOutcomeSchema.parse({
          outcome: 'no-op',
          reason: 'No active observation groups are eligible for consolidation',
        })
      }
      const plannedEvents: MemoryEventDraft[] = []
      for (const candidate of candidates) {
        const observedAt = candidate.sources
          .map(({ observation }) => observation.observedAt)
          .sort()
          .at(-1)!
        const canonicalObservation = {
          observationId: candidate.canonicalObservationId,
          taskId: candidate.taskId,
          kind: candidate.observationKind,
          summary: `Consolidated ${candidate.sourceObservationIds.length} ${candidate.observationKind} observations`,
          detail: `Derived from observations ${candidate.sourceObservationIds.join(', ')} under policy ${request.policyVersion}.`,
          confidence: Math.min(
            ...candidate.sources.map(({ observation }) => observation.confidence),
          ),
          evidence: [],
          selectors: candidate.sources[0]!.observation.selectors?.slice(0, 1),
          provenance: {
            origin: 'derived' as const,
            recordedBy: 'memory-v2-operator',
            sourceEventIds: candidate.sources.map(({ sourceEventId }) => sourceEventId),
            sourceSessionId: request.sessionId,
            metadata: {
              policyVersion: request.policyVersion,
              sourceObservationIds: candidate.sourceObservationIds,
            },
          },
          tags: ['consolidated', request.policyVersion.slice(0, 64)],
          observedAt,
        }
        const consolidatedPayload = {
          payloadSchemaVersion: 1 as const,
          sourceObservationIds: candidate.sourceObservationIds,
          canonicalObservation,
          reason: `Deterministic append-only consolidation policy ${request.policyVersion}`,
        }
        plannedEvents.push(
          MemoryEventDraftSchema.parse({
            schemaVersion: 2,
            eventSchemaVersion: 1,
            eventType: 'claim.consolidated',
            eventId: derivedId('event', { type: 'claim.consolidated', payload: consolidatedPayload }),
            projectId: request.projectId,
            sessionId: request.sessionId,
            occurredAt: observedAt,
            payload: consolidatedPayload,
          }),
        )
        for (const observationId of candidate.sourceObservationIds) {
          const payload = {
            payloadSchemaVersion: 1 as const,
            observationId,
            supersededByObservationId: candidate.canonicalObservationId,
            reason: `Superseded by deterministic consolidation policy ${request.policyVersion}`,
          }
          plannedEvents.push(
            MemoryEventDraftSchema.parse({
              schemaVersion: 2,
              eventSchemaVersion: 1,
              eventType: 'claim.superseded',
              eventId: derivedId('event', { type: 'claim.superseded', payload }),
              projectId: request.projectId,
              sessionId: request.sessionId,
              occurredAt: observedAt,
              payload,
            }),
          )
        }
      }
      const visibleCandidates = candidates.map(({ sources: _sources, ...candidate }) => candidate)
      if (request.mode === 'preview') {
        return MemoryConsolidationOutcomeSchema.parse({
          outcome: 'preview',
          candidates: visibleCandidates,
          plannedEvents,
        })
      }
      const append = MemoryAppendOutcomeSchema.parse(
        await this.repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: request.projectId,
            events: plannedEvents,
          }),
        ),
      )
      if (append.outcome !== 'appended') {
        return MemoryConsolidationOutcomeSchema.parse(append)
      }
      return MemoryConsolidationOutcomeSchema.parse({
        outcome: 'applied',
        candidates: visibleCandidates,
        plannedEvents,
        entries: append.entries,
      })
    } catch (error) {
      return MemoryConsolidationOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }

  async correct(input: unknown): Promise<MemoryCorrectionOutcome> {
    const parsed = MemoryCorrectionRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryCorrectionOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid correction request'),
      })
    }
    const request = parsed.data
    try {
      const action = request.action
      const targetObservationIds =
        action.kind === 'forget' ? action.observationIds : [action.observationId]
      const tasks = observationTaskIds(await this.allEvents(request.projectId))
      const targetTasks = targetObservationIds.map((observationId) => tasks.get(observationId))
      const targetIsInvalid =
        targetTasks.some((taskId) => taskId === undefined) ||
        targetTasks.some((taskId) => taskId !== request.taskId) ||
        (action.kind === 'correct' && action.correction.taskId !== targetTasks[0])
      if (targetIsInvalid) {
        return MemoryCorrectionOutcomeSchema.parse({
          outcome: 'rejected',
          error: operationalError(
            'invalid-request',
            'Observation target is missing or outside the requested task',
          ),
        })
      }
      const event = (() => {
        if (action.kind === 'correct') {
          return {
            eventType: 'claim.corrected' as const,
            payload: {
              payloadSchemaVersion: 1 as const,
              observationId: action.observationId,
              correction: action.correction,
              reason: action.reason,
            },
          }
        }
        if (action.kind === 'forget') {
          return {
            eventType: 'claim.forgotten' as const,
            payload: { payloadSchemaVersion: 1 as const, ...action, kind: undefined },
          }
        }
        return {
          eventType: 'claim.pinned' as const,
          payload: {
            payloadSchemaVersion: 1 as const,
            observationId: action.observationId,
            reason: action.reason,
            pinnedBy: action.pinnedBy,
            pinnedAt: request.occurredAt,
          },
        }
      })()
      const payload = Object.fromEntries(
        Object.entries(event.payload).filter(([, value]) => value !== undefined),
      )
      const draft = MemoryEventDraftSchema.parse({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        eventType: event.eventType,
        eventId: derivedId('event', { type: event.eventType, payload }),
        projectId: request.projectId,
        sessionId: request.sessionId,
        occurredAt: request.occurredAt,
        payload,
      })
      if (request.mode === 'preview') {
        return MemoryCorrectionOutcomeSchema.parse({
          outcome: 'preview',
          plannedEvents: [draft],
        })
      }
      const append = MemoryAppendOutcomeSchema.parse(
        await this.repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: request.projectId,
            events: [draft],
          }),
        ),
      )
      if (append.outcome !== 'appended') return MemoryCorrectionOutcomeSchema.parse(append)
      return MemoryCorrectionOutcomeSchema.parse({
        outcome: append.entries[0]!.duplicate ? 'no-op' : 'applied',
        ...(append.entries[0]!.duplicate
          ? { reason: 'The deterministic correction event already exists' }
          : { plannedEvents: [draft], entry: append.entries[0] }),
      })
    } catch (error) {
      return MemoryCorrectionOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }

  async revalidate(input: unknown): Promise<MemoryRevalidationOutcome> {
    const parsed = MemoryRevalidationRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryRevalidationOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid revalidation request'),
      })
    }
    const request = parsed.data
    const actions = [...request.actions].sort((left, right) =>
      stableJson(left).localeCompare(stableJson(right)),
    )
    try {
      const tasks = observationTaskIds(await this.allEvents(request.projectId))
      const targetTasks = actions.map((action) => tasks.get(action.observationId))
      if (
        targetTasks.some((taskId) => taskId === undefined) ||
        targetTasks.some((taskId) => taskId !== request.taskId)
      ) {
        return MemoryRevalidationOutcomeSchema.parse({
          outcome: 'rejected',
          error: operationalError(
            'invalid-request',
            'Observation target is missing or outside the requested task',
          ),
        })
      }
      if (request.mode === 'preview') {
        return MemoryRevalidationOutcomeSchema.parse({ outcome: 'preview', actions })
      }
      const results = []
      for (const action of actions) {
        const result = MemoryVerifyOutcomeSchema.parse(
          await this.repository.verify(
            MemoryVerifyRequestSchema.parse({
              schemaVersion: 2,
              projectId: request.projectId,
              sessionId: request.sessionId,
              action,
            }),
          ),
        )
        results.push({ action, result })
      }
      return MemoryRevalidationOutcomeSchema.parse({ outcome: 'applied', results })
    } catch (error) {
      return MemoryRevalidationOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }

  async repair(input: unknown): Promise<MemoryProjectionRepairOutcome> {
    const parsed = MemoryProjectionRepairRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryProjectionRepairOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid projection repair request'),
      })
    }
    const request = parsed.data
    try {
      const beforeEvents = await this.allEvents(request.projectId)
      const before = { eventCount: beforeEvents.length, checksum: digest(beforeEvents) }
      if (request.mode === 'preview') {
        return MemoryProjectionRepairOutcomeSchema.parse({ outcome: 'preview', before })
      }
      const rebuild = MemoryRebuildOutcomeSchema.parse(
        await this.repository.rebuild(
          MemoryRebuildRequestSchema.parse({
            schemaVersion: 2,
            projectId: request.projectId,
            rebuildId: request.rebuildId,
            projectionNames: request.projectionNames,
            ...(request.fromEventId ? { fromEventId: request.fromEventId } : {}),
          }),
        ),
      )
      if (rebuild.outcome !== 'rebuilt') return MemoryProjectionRepairOutcomeSchema.parse(rebuild)
      const afterEvents = await this.allEvents(request.projectId)
      const after = { eventCount: afterEvents.length, checksum: digest(afterEvents) }
      if (before.eventCount !== after.eventCount || before.checksum !== after.checksum) {
        return MemoryProjectionRepairOutcomeSchema.parse({
          outcome: 'integrity-mismatch',
          before,
          after,
        })
      }
      return MemoryProjectionRepairOutcomeSchema.parse({
        outcome: 'repaired',
        before,
        after,
        rebuild,
      })
    } catch (error) {
      return MemoryProjectionRepairOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }

  async exportManifest(input: unknown): Promise<MemoryManifestExportOutcome> {
    const parsed = MemoryManifestExportRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryManifestExportOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid manifest export request'),
      })
    }
    const request = parsed.data
    try {
      const canonical = await this.allEvents(request.projectId)
      const stale = staleObservationReasons(canonical)
      const warnings: string[] = []
      const addWarning = (warning: string) => {
        if (warnings.length < MAX_EXPORT_WARNINGS) warnings.push(warning.slice(0, 512))
      }
      const exported: MemoryExportEventV2[] = []
      let excludedEventCount = 0
      let redactedValueCount = 0
      let verificationLifecycleCount = 0
      for (const sourceEvent of canonical) {
        if (isVerificationLifecycleEvent(sourceEvent)) verificationLifecycleCount++
        const observationId =
          sourceEvent.eventType === 'observation.recorded'
            ? sourceEvent.payload.observation.observationId
            : undefined
        const reasons = observationId ? [...(stale.get(observationId) ?? [])].sort() : []
        if (reasons.length > 0 && !request.includeStale) {
          excludedEventCount++
          continue
        }
        const sanitized = sanitizeEvent(sourceEvent)
        redactedValueCount += sanitized.redactedValues
        if (!sanitized.event) {
          addWarning(`Omitted event ${sourceEvent.eventId}: sanitization could not preserve schema`)
          continue
        }
        exported.push({
          event: sanitized.event,
          lifecycle: reasons.length > 0 ? 'stale' : 'active',
          staleReasons: reasons,
        })
      }
      if (redactedValueCount > 0) {
        addWarning(`Redacted ${redactedValueCount} sensitive value(s) from exported events`)
      }
      if (verificationLifecycleCount > 0) {
        addWarning(
          `verification-state-stripped: ${verificationLifecycleCount} lifecycle event(s) will be stripped on import`,
        )
      }
      const health = MemoryHealthSchema.parse(
        await this.repository.health({ schemaVersion: 2, projectId: request.projectId }),
      )
      const sequenceRange = canonical.length
        ? { first: canonical[0]!.sequence, last: canonical.at(-1)!.sequence }
        : null
      const unsigned = MemoryExportManifestV2Schema.parse({
        schemaVersion: 2,
        manifestVersion: 2,
        format: 'memory-v2-json',
        projectId: request.projectId,
        generatedAt: request.generatedAt,
        canonicalEventCount: canonical.length,
        canonicalSequenceRange: sequenceRange,
        events: exported,
        health,
        checksum: SHA256_ZERO,
        labels: { generated: true, authoritative: false },
        stalePolicy: { includeStale: request.includeStale, excludedEventCount },
        warnings,
      })
      const manifest = MemoryExportManifestV2Schema.parse({
        ...unsigned,
        checksum: manifestChecksum(unsigned),
      })
      return MemoryManifestExportOutcomeSchema.parse({
        outcome: 'exported',
        manifest,
        ...(request.rendering === 'json-and-markdown'
          ? { markdown: renderMarkdown(manifest) }
          : {}),
      })
    } catch (error) {
      return MemoryManifestExportOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }

  async importManifest(input: unknown): Promise<MemoryManifestImportOutcome> {
    if (manifestEventsExceedBudget(input)) {
      return MemoryManifestImportOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError(
          'invalid-request',
          'Manifest events exceed the import size limit',
        ),
      })
    }
    const parsed = MemoryManifestImportRequestSchema.safeParse(input)
    if (!parsed.success) {
      return MemoryManifestImportOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Invalid manifest import request'),
      })
    }
    const request = parsed.data
    const manifest = request.manifest
    if (manifest.projectId !== request.projectId) {
      return MemoryManifestImportOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('conflict', 'Manifest project does not match target project'),
      })
    }
    if (manifestChecksum(manifest) !== manifest.checksum) {
      return MemoryManifestImportOutcomeSchema.parse({
        outcome: 'rejected',
        error: operationalError('invalid-request', 'Manifest checksum is invalid'),
      })
    }
    try {
      const admittedEvents = manifest.events
        .map(({ event }) => event)
        .filter((event) => !isVerificationLifecycleEvent(event))
      const strippedVerificationEvents = manifest.events.length - admittedEvents.length
      const admittedDrafts = admittedEvents.map(({ sequence: _sequence, ...draft }) => draft)
      let target = await this.allEvents(request.projectId)
      let targetDrafts = target.map(({ sequence: _sequence, ...draft }) => draft)
      const isAdmittedPrefix = (drafts: MemoryEventDraft[]): boolean =>
        drafts.length <= admittedDrafts.length &&
        stableJson(drafts) === stableJson(admittedDrafts.slice(0, drafts.length))
      if (!isAdmittedPrefix(targetDrafts)) {
        return MemoryManifestImportOutcomeSchema.parse({
          outcome: 'rejected',
          error: operationalError('conflict', 'Target logical project is not an imported prefix'),
        })
      }

      const initialTargetLength = targetDrafts.length
      let offset = targetDrafts.length
      let expectedTail = target.length === 0
        ? { kind: 'empty' as const }
        : { kind: 'event' as const, eventId: target.at(-1)!.eventId }
      let conflictRecoveries = 0
      while (offset < admittedEvents.length) {
        const events = admittedEvents.slice(offset, offset + request.pageSize).map((event) => {
          const { sequence: _sequence, ...draft } = event
          return MemoryEventDraftSchema.parse(draft)
        })
        const append = MemoryAppendOutcomeSchema.parse(
          await this.repository.append(
            MemoryAppendRequestSchema.parse({
              schemaVersion: 2,
              projectId: request.projectId,
              expectedTail,
              events,
            }),
          ),
        )
        if (append.outcome === 'appended') {
          offset += events.length
          expectedTail = { kind: 'event', eventId: append.lastEventId }
          continue
        }
        if (append.error.code === 'conflict' && append.error.retryable && conflictRecoveries < 2) {
          conflictRecoveries++
          target = await this.allEvents(request.projectId)
          targetDrafts = target.map(({ sequence: _sequence, ...draft }) => draft)
          if (!isAdmittedPrefix(targetDrafts) || targetDrafts.length < offset) {
            return MemoryManifestImportOutcomeSchema.parse({
              outcome: 'rejected',
              error: operationalError('conflict', 'Target logical project is not an imported prefix'),
            })
          }
          offset = targetDrafts.length
          expectedTail = target.length === 0
            ? { kind: 'empty' }
            : { kind: 'event', eventId: target.at(-1)!.eventId }
          continue
        }
        return MemoryManifestImportOutcomeSchema.parse({
          outcome: append.outcome,
          error: operationalError(
            append.error.code,
            'Manifest import append was not committed; canonical events may be partially imported',
            append.error.retryable,
          ),
        })
      }

      const rebuild = MemoryRebuildOutcomeSchema.parse(
        await this.repository.rebuild(
          MemoryRebuildRequestSchema.parse({
            schemaVersion: 2,
            projectId: request.projectId,
            rebuildId: request.rebuildId,
            projectionNames: request.projectionNames,
          }),
        ),
      )
      if (rebuild.outcome !== 'rebuilt') {
        return MemoryManifestImportOutcomeSchema.parse({
          outcome: rebuild.outcome,
          error: operationalError(
            rebuild.error.code,
            'Manifest events are imported but projection rebuild failed; retry the import',
            true,
          ),
        })
      }
      if (initialTargetLength === admittedDrafts.length) {
        const strippedReason = strippedVerificationEvents > 0
          ? `; verification-state-stripped=${strippedVerificationEvents}`
          : ''
        return MemoryManifestImportOutcomeSchema.parse({
          outcome: 'no-op',
          reason: `The admitted manifest is already imported and projections were rebuilt${strippedReason}`,
        })
      }
      return MemoryManifestImportOutcomeSchema.parse({
        outcome: 'imported',
        importedEvents: admittedEvents.length,
        rebuild,
      })
    } catch (error) {
      return MemoryManifestImportOutcomeSchema.parse({ outcome: 'failed', error: failedError(error) })
    }
  }
}
