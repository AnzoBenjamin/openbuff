import { createHash } from 'node:crypto'

import type { JSONValue } from '@codebuff/common/types/json'

/** Data-only observations. Nothing in this module admits or executes live replay. */
export type ReplayBasis = {
  runId: string
  bundleSha256: string
  runtimeSha256: string
  contractSha256: string
  configurationSha256: string
  inputSha256: string
}

const requestKinds = ['STEP', 'STEP_ALL', 'GENERATE_N', 'tool', 'host'] as const
export type ReplayRequest = {
  kind: (typeof requestKinds)[number]
  input: JSONValue
}
export type ReplayEntry = {
  ordinal: number
  occurrence: number
  request: ReplayRequest
  completion?:
    | { kind: 'recorded'; requestSha256: string; result: JSONValue }
    | { kind: 'uncertain'; requestSha256: string }
}
export type ReplayCapture = {
  version: 1
  basis: ReplayBasis
  entries: ReplayEntry[]
  terminal?: { output: JSONValue }
}

/** Must come from the selected checkpoint, not be recalculated from an offered trace. */
export type ReplayCaptureSeal = { entryCount: number; captureSha256: string }
export type ReplayWitness = {
  requests: ReplayRequest[]
  terminal?: { output: JSONValue }
}

type InvalidReason = 'invalid_trace' | 'basis_mismatch' | 'seal_mismatch'
type ObservationStop =
  | 'terminal'
  | 'missing_result'
  | 'uncertain_effect'
  | 'terminal_missing'
type ReplayObservation = {
  ordinal: number
  occurrence: number
  request: ReplayRequest
  requestSha256: string
  result: JSONValue
}
export type ReplayInspection =
  | { status: 'invalid'; reason: InvalidReason }
  | {
      status: 'eligible_observations'
      pairs: ReplayObservation[]
      stop: ObservationStop
      terminal?: { output: JSONValue }
    }

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const MAX_JSON_NODES = 65_536
const MAX_STEPS = 4_096
const HEX = /^[0-9a-f]{64}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Encode only bounded plain JSON data: no getters, sparse arrays or conversions. */
function canonicalJson(value: unknown, byteLimit = MAX_CAPTURE_BYTES): string {
  const chunks: string[] = []
  let bytes = 0
  let nodes = 0
  const add = (text: string) => {
    bytes += Buffer.byteLength(text)
    if (bytes > byteLimit)
      throw new TypeError('Replay data exceeds the byte limit')
    chunks.push(text)
  }
  const addString = (text: string) => {
    if (text.length > byteLimit)
      throw new TypeError('Replay data exceeds the byte limit')
    add(JSON.stringify(text))
  }
  const readOwn = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('Replay data needs enumerable, own JSON values')
    }
    return descriptor.value
  }
  const walk = (item: unknown, depth: number) => {
    if (++nodes > MAX_JSON_NODES || depth > 32)
      throw new TypeError('Replay data exceeds its structural limit')
    if (typeof item === 'string') return addString(item)
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      return add(JSON.stringify(item))
    }
    if (typeof item !== 'object' || item === null)
      throw new TypeError('Replay data must be finite JSON')
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > MAX_JSON_NODES ||
        Reflect.ownKeys(item).length !== item.length + 1
      ) {
        throw new TypeError('Replay data must use dense JSON arrays')
      }
      add('[')
      for (let index = 0; index < item.length; index++) {
        if (index > 0) add(',')
        walk(readOwn(item, String(index)), depth + 1)
      }
      add(']')
      return
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Replay data must use plain JSON objects')
    const keys = Reflect.ownKeys(item)
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.length > MAX_JSON_NODES
    )
      throw new TypeError('Invalid replay object keys')
    add('{')
    ;(keys as string[]).sort().forEach((key, index) => {
      if (index > 0) add(',')
      addString(key)
      add(':')
      walk(readOwn(item, key), depth + 1)
    })
    add('}')
  }
  walk(value, 0)
  return chunks.join('')
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export function captureValueSha256(value: unknown): string {
  return sha256(canonicalJson(value))
}

/** Copy a bounded data snapshot without consulting user toJSON methods. */
export function snapshotReplayValue(
  value: unknown,
  byteLimit: number,
): {
  value: JSONValue
  sha256: string
} {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1)
    throw new TypeError('Invalid replay snapshot byte limit')
  const encoded = canonicalJson(value, Math.min(byteLimit, MAX_CAPTURE_BYTES))
  return { value: JSON.parse(encoded) as JSONValue, sha256: sha256(encoded) }
}

export function sealReplayCapture(capture: ReplayCapture): ReplayCaptureSeal {
  const encoded = canonicalJson(capture)
  const data: unknown = JSON.parse(encoded)
  if (!isRecord(data) || !Array.isArray(data.entries))
    throw new TypeError('Invalid replay capture')
  return { entryCount: data.entries.length, captureSha256: sha256(encoded) }
}

function hasFields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  )
}

const basisHashes = [
  'bundleSha256',
  'runtimeSha256',
  'contractSha256',
  'configurationSha256',
  'inputSha256',
]
function validBasis(value: unknown): boolean {
  return (
    hasFields(value, ['runId', ...basisHashes]) &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    value.runId.length <= 256 &&
    basisHashes.every(
      (key) => typeof value[key] === 'string' && HEX.test(value[key]),
    )
  )
}

function validRequest(value: unknown): value is ReplayRequest {
  return (
    hasFields(value, ['kind', 'input']) &&
    typeof value.kind === 'string' &&
    requestKinds.some((kind) => kind === value.kind)
  )
}

/** Check trusted identity and seal before returning even the first recorded reply. */
export function inspectReplayCapture(
  offered: unknown,
  expectedBasis: ReplayBasis,
  trustedSeal: ReplayCaptureSeal,
): ReplayInspection {
  try {
    const encoded = canonicalJson(offered)
    const data: unknown = JSON.parse(encoded)
    const seal: unknown = JSON.parse(canonicalJson(trustedSeal))
    const expected = canonicalJson(expectedBasis)
    // Work from canonical snapshots, not mutable references in the offered input.
    if (
      !hasFields(data, ['version', 'basis', 'entries'], ['terminal']) ||
      data.version !== 1 ||
      !Array.isArray(data.entries) ||
      data.entries.length < 1 ||
      data.entries.length > MAX_STEPS ||
      !validBasis(data.basis)
    ) {
      return { status: 'invalid', reason: 'invalid_trace' }
    }
    if (
      !validBasis(JSON.parse(expected)) ||
      canonicalJson(data.basis) !== expected
    ) {
      return { status: 'invalid', reason: 'basis_mismatch' }
    }
    if (
      !hasFields(seal, ['entryCount', 'captureSha256']) ||
      data.entries.length !== seal.entryCount ||
      sha256(encoded) !== seal.captureSha256
    ) {
      return { status: 'invalid', reason: 'seal_mismatch' }
    }
    if ('terminal' in data && !hasFields(data.terminal, ['output']))
      return { status: 'invalid', reason: 'invalid_trace' }

    const pairs: ReplayObservation[] = []
    const seen = new Map<string, number>()
    for (const [ordinal, entry] of data.entries.entries()) {
      if (
        !hasFields(
          entry,
          ['ordinal', 'occurrence', 'request'],
          ['completion'],
        ) ||
        entry.ordinal !== ordinal ||
        !validRequest(entry.request)
      ) {
        return { status: 'invalid', reason: 'invalid_trace' }
      }
      const requestSha256 = captureValueSha256(entry.request)
      const occurrence = seen.get(requestSha256) ?? 0
      if (entry.occurrence !== occurrence)
        return { status: 'invalid', reason: 'invalid_trace' }
      seen.set(requestSha256, occurrence + 1)
      const frontier =
        ordinal === data.entries.length - 1 && !('terminal' in data)
      if (!('completion' in entry)) {
        return frontier
          ? { status: 'eligible_observations', stop: 'missing_result', pairs }
          : { status: 'invalid', reason: 'invalid_trace' }
      }
      const completion = entry.completion
      if (!isRecord(completion) || completion.requestSha256 !== requestSha256)
        return { status: 'invalid', reason: 'invalid_trace' }
      if (completion.kind === 'uncertain') {
        return frontier && hasFields(completion, ['kind', 'requestSha256'])
          ? { status: 'eligible_observations', stop: 'uncertain_effect', pairs }
          : { status: 'invalid', reason: 'invalid_trace' }
      }
      if (
        completion.kind !== 'recorded' ||
        !hasFields(completion, ['kind', 'requestSha256', 'result'])
      ) {
        return { status: 'invalid', reason: 'invalid_trace' }
      }
      pairs.push({
        ordinal,
        occurrence,
        request: entry.request,
        requestSha256,
        result: completion.result as JSONValue,
      })
    }
    return 'terminal' in data
      ? {
          status: 'eligible_observations',
          stop: 'terminal',
          pairs,
          terminal: data.terminal as { output: JSONValue },
        }
      : { status: 'eligible_observations', stop: 'terminal_missing', pairs }
  } catch {
    return { status: 'invalid', reason: 'invalid_trace' }
  }
}

type WitnessReason =
  | InvalidReason
  | Exclude<ObservationStop, 'terminal'>
  | 'invalid_witness'
  | 'yield_missing'
  | 'yield_diverged'
  | 'unexpected_yield'
  | 'terminal_diverged'
export type ReplayVerification =
  | { status: 'verified'; verifiedSteps: number; liveReplayPermitted: false }
  | {
      status: 'unavailable'
      reason: WitnessReason
      verifiedSteps: number
      liveReplayPermitted: false
    }

/** Compare an independently reconstructed, effect-free witness to the sealed observations. */
export function verifyReplayWitness(
  capture: unknown,
  expectedBasis: ReplayBasis,
  trustedSeal: ReplayCaptureSeal,
  witness: ReplayWitness,
): ReplayVerification {
  let verifiedSteps = 0
  const stop = (reason: WitnessReason): ReplayVerification => ({
    status: 'unavailable',
    reason,
    verifiedSteps,
    liveReplayPermitted: false,
  })
  const inspection = inspectReplayCapture(capture, expectedBasis, trustedSeal)
  if (inspection.status === 'invalid') return stop(inspection.reason)
  try {
    const actual: unknown = JSON.parse(canonicalJson(witness))
    if (
      !hasFields(actual, ['requests'], ['terminal']) ||
      !Array.isArray(actual.requests)
    )
      return stop('invalid_witness')
    for (const pair of inspection.pairs) {
      if (verifiedSteps >= actual.requests.length) return stop('yield_missing')
      const request: unknown = actual.requests[verifiedSteps]
      if (
        !validRequest(request) ||
        captureValueSha256(request) !== pair.requestSha256
      )
        return stop('yield_diverged')
      verifiedSteps++
    }
    if (actual.requests.length !== verifiedSteps)
      return stop('unexpected_yield')
    if (inspection.stop !== 'terminal') return stop(inspection.stop)
    if (
      !hasFields(actual.terminal, ['output']) ||
      captureValueSha256(actual.terminal) !==
        captureValueSha256(inspection.terminal)
    ) {
      return stop('terminal_diverged')
    }
    return { status: 'verified', verifiedSteps, liveReplayPermitted: false }
  } catch {
    return stop('invalid_witness')
  }
}
