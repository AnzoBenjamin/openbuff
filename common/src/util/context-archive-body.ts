import { createHash } from 'node:crypto'
import type {
  ContextArchiveBody,
  ContextArchiveBodyPageOutcome,
  ContextArchiveBodyPageRequest,
  ContextArchiveBodyReference,
  ContextArchiveSnapshot,
} from '../types/context-archive'

/** Storage limits, not productive-work limits. The 4 MiB roadmap quota is a fixture input. */
export const DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_CONTEXT_ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_CONTEXT_ARCHIVE_MAX_SNAPSHOTS = 500
export const CONTEXT_ARCHIVE_PAGE_BYTES = 16 * 1024
export const CONTEXT_ARCHIVE_MAX_PAGE_BYTES = 64 * 1024

export function createContextArchiveBody(text: string): ContextArchiveBody {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  return {
    bodyId: `sha256:${sha256}`,
    sha256,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    text,
  }
}

export function isContextArchiveBody(
  value: unknown,
): value is ContextArchiveBody {
  if (!value || typeof value !== 'object') return false
  const body = value as ContextArchiveBody
  return (
    typeof body.text === 'string' &&
    /^[a-f0-9]{64}$/.test(body.sha256) &&
    body.bodyId === `sha256:${body.sha256}` &&
    Number.isSafeInteger(body.utf8Bytes) &&
    body.utf8Bytes >= 0 &&
    Buffer.byteLength(body.text, 'utf8') === body.utf8Bytes &&
    createHash('sha256').update(body.text, 'utf8').digest('hex') ===
      body.sha256 &&
    Buffer.from(body.text, 'utf8').toString('utf8') === body.text
  )
}

export function contextArchiveBodyReference(
  body: ContextArchiveBody,
): ContextArchiveBodyReference {
  return { bodyId: body.bodyId, sha256: body.sha256, utf8Bytes: body.utf8Bytes }
}

/** Explicit reference projection, never a replacement original. */
export function isContextArchiveBodyPointer(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const pointer = value as {
    kind?: string
    version?: number
    bodyId?: string
    sha256?: string
    utf8Bytes?: number
    toolCallId?: string
  }
  return (
    pointer.kind === 'context_archive_body_reference' &&
    pointer.version === 1 &&
    typeof pointer.toolCallId === 'string' &&
    typeof pointer.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(pointer.sha256) &&
    pointer.bodyId === `sha256:${pointer.sha256}` &&
    Number.isSafeInteger(pointer.utf8Bytes) &&
    pointer.utf8Bytes! >= 0
  )
}

/** A page either advances by complete UTF-8 code points or returns an explicit cursor error. */
export function pageContextArchiveBody(
  body: ContextArchiveBody,
  request: Pick<
    ContextArchiveBodyPageRequest,
    'offsetBytes' | 'maxBytes' | 'expectedSha256'
  >,
):
  | Pick<
      Extract<ContextArchiveBodyPageOutcome, { status: 'ok' }>,
      'text' | 'startByte' | 'endByte' | 'nextOffset'
    >
  | Extract<
      ContextArchiveBodyPageOutcome,
      { status: 'corrupt' | 'invalid-cursor' }
    >
  | { status: 'corrupt' | 'invalid-cursor'; reason: string } {
  if (
    !isContextArchiveBody(body) ||
    (request.expectedSha256 !== undefined &&
      request.expectedSha256 !== body.sha256)
  )
    return {
      status: 'corrupt',
      reason:
        'The immutable original does not match its expected UTF-8 hash/length.',
    }
  const offset = request.offsetBytes ?? 0,
    limit = request.maxBytes ?? CONTEXT_ARCHIVE_PAGE_BYTES
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > body.utf8Bytes ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONTEXT_ARCHIVE_MAX_PAGE_BYTES
  )
    return {
      status: 'invalid-cursor',
      reason: 'The byte cursor or page budget is outside the supported range.',
    }
  const bytes = Buffer.from(body.text, 'utf8')
  const continuation = (index: number) =>
    index < bytes.length && (bytes[index] & 0xc0) === 0x80
  if (continuation(offset))
    return {
      status: 'invalid-cursor',
      reason: 'The byte cursor is inside a UTF-8 code point.',
    }
  let end = Math.min(bytes.length, offset + limit)
  while (end > offset && continuation(end)) end--
  if (end === offset && offset < bytes.length)
    return {
      status: 'invalid-cursor',
      reason: 'The page budget cannot hold the next complete UTF-8 code point.',
    }
  return {
    text: bytes.subarray(offset, end).toString('utf8'),
    startByte: offset,
    endByte: end,
    nextOffset: end < bytes.length ? end : null,
  }
}

export function isContextArchiveBodyPageOutcome(
  value: unknown,
): value is ContextArchiveBodyPageOutcome {
  if (!value || typeof value !== 'object') return false
  const page = value as Extract<ContextArchiveBodyPageOutcome, { status: 'ok' }>
  if (page.status !== 'ok') {
    const failure = value as { status?: string; reason?: unknown }
    return (
      [
        'missing',
        'expired',
        'ambiguous',
        'corrupt',
        'unavailable',
        'invalid-cursor',
      ].includes(failure.status ?? '') &&
      typeof failure.reason === 'string' &&
      failure.reason.length > 0 &&
      failure.reason.length <= 4096
    )
  }
  if (
    ![page.runId, page.toolName, page.toolCallId].every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 2048,
    ) ||
    !Number.isSafeInteger(page.step) ||
    page.step < 0 ||
    !/^[a-f0-9]{64}$/.test(page.sha256) ||
    page.bodyId !== `sha256:${page.sha256}` ||
    ![page.utf8Bytes, page.startByte, page.endByte].every(
      (number) => Number.isSafeInteger(number) && number >= 0,
    ) ||
    page.startByte > page.endByte ||
    page.endByte > page.utf8Bytes ||
    typeof page.text !== 'string' ||
    Buffer.byteLength(page.text, 'utf8') !== page.endByte - page.startByte ||
    page.endByte - page.startByte > CONTEXT_ARCHIVE_MAX_PAGE_BYTES ||
    Buffer.from(page.text, 'utf8').toString('utf8') !== page.text ||
    (page.nextOffset !== null
      ? page.nextOffset !== page.endByte || page.endByte >= page.utf8Bytes
      : page.endByte !== page.utf8Bytes)
  )
    return false
  return (
    page.startByte !== 0 ||
    page.endByte !== page.utf8Bytes ||
    createHash('sha256').update(page.text, 'utf8').digest('hex') === page.sha256
  )
}

/** Rebind sanitized original text and its references; never retain a pre-redaction text hash. */
export function rehashContextArchiveBodies(state: {
  compactionArchive?: ContextArchiveSnapshot[]
  contextArchiveBodies?: Record<string, ContextArchiveBody>
}): void {
  if (!state.contextArchiveBodies) return
  const rebound = new Map<string, ContextArchiveBody>(),
    bodies: Record<string, ContextArchiveBody> = {}
  for (const [oldId, value] of Object.entries(state.contextArchiveBodies)) {
    if (!value || typeof value.text !== 'string') continue
    const body = createContextArchiveBody(value.text)
    rebound.set(oldId, body)
    bodies[body.bodyId] = body
  }
  state.compactionArchive = state.compactionArchive?.map((snapshot) => ({
    ...snapshot,
    snapshotId: undefined,
    provenance: snapshot.provenance?.map((provenance) => {
      if (!provenance.body) return provenance
      const body = rebound.get(provenance.body.bodyId)
      if (!body)
        return {
          ...provenance,
          kind: 'unknown' as const,
          body: undefined,
          retainedRange: undefined,
        }
      return {
        ...provenance,
        body: contextArchiveBodyReference(body),
        retainedRange:
          provenance.kind === 'original'
            ? { startByte: 0, endByte: body.utf8Bytes }
            : undefined,
      }
    }),
  }))
  state.contextArchiveBodies = bodies
}
