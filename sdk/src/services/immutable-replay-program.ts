import { createHash, randomBytes } from 'node:crypto'
import { types } from 'node:util'

/** Closed, data-only program: no executable modules, tools selected by a model, or callback functions. */
export type ReplayProgramPart = string | { input: string } | { result: string }
export type ReplayProgramOperation =
  | { id: string; kind: 'STEP' | 'STEP_ALL'; prompt: ReplayProgramPart[] }
  | {
      id: string
      kind: 'GENERATE_N'
      prompt: ReplayProgramPart[]
      count: number
    }
  | { id: string; kind: 'clock' | 'random' }
  | { id: string; kind: 'sha256'; value: ReplayProgramPart[] }
export type ReplayProgram = { version: 1; operations: ReplayProgramOperation[] }
export type ReplayProgramOutput = string | string[] | number
export type ReplayProgramModel = {
  endpoint: string
  name: string
  apiKey?: string
}
export type ReplayProgramRequest = {
  journalPath: string
  program: ReplayProgram
  inputs: Record<string, string>
  model: ReplayProgramModel
  resumeRunId?: string
  /** Voluntarily return at the next clean boundary after this operation. Not replay authority. */
  pauseAfter?: string
  signal?: AbortSignal
}
export type ReplayProgramResult =
  | {
      status: 'completed' | 'paused'
      runId: string
      agentId: string
      userInputId: string
      outputs: Record<string, ReplayProgramOutput>
      retainedAttempts: number
      newAttempts: number
    }
  | {
      status: 'replay_unavailable' | 'failed' | 'cancelled'
      reason: string
      runId?: string
    }
export type Attempt =
  | {
      id: string
      kind: 'model'
      operation: 'STEP' | 'STEP_ALL' | 'GENERATE_N'
      part: number
      body: {
        model: string
        messages: { role: 'user' | 'assistant'; content: string }[]
        n: number
        max_tokens: number
        stream: false
      }
    }
  | { id: string; kind: 'clock' | 'random' }
  | { id: string; kind: 'sha256'; value: string }
export type Reply =
  | number
  | string
  | { text: string; finish: 'stop' | 'length' }[]
export type ProgramOrigin = {
  runId: string
  agentId: string
  userInputId: string
  ownerPid: number
  basis: string
}

const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const bound = 16 * 1024
const operationsLimit = 16
export const traceLimit = 128
export const payloadLimit = 128 * 1024
const reserved = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
])
const goodId = (x: unknown): x is string =>
  typeof x === 'string' && identifier.test(x) && !reserved.has(x)
export const sha = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
export const freshId = () => randomBytes(16).toString('hex')
export const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x &&
  typeof x === 'object' &&
  !types.isProxy(x) &&
  (Object.getPrototypeOf(x) === Object.prototype ||
    Object.getPrototypeOf(x) === null)
const text = (x: unknown, limit = bound): x is string =>
  typeof x === 'string' &&
  Buffer.byteLength(x) <= limit &&
  // Well-formed scalar data is required for bytewise hashes and wire replies.
  Buffer.from(x).toString('utf8') === x
export const exact = (
  record: Record<string, unknown>,
  keys: readonly string[],
) =>
  Object.keys(record).length === keys.length &&
  keys.every((key) => Object.hasOwn(record, key))

/** Snapshot validated data without honoring getters, prototypes, sparse arrays or toJSON. */
export function copyData(value: unknown): unknown {
  let nodes = 0
  let bytes = 0
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 8)
      throw new Error('Replay input exceeds structural limits')
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v)
      if (bytes > 64 * 1024) throw new Error('Replay input exceeds byte limits')
      return v
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v
    if (types.isProxy(v) || (!Array.isArray(v) && !isRecord(v)))
      throw new Error('Replay requires plain immutable program data')
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 64 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        throw new Error('Replay requires a dense data array')
      return Array.from({ length: v.length }, (_, i) =>
        visit(plainMember(v, String(i)), depth + 1),
      )
    }
    return Object.fromEntries(
      Reflect.ownKeys(v).map((key) => {
        if (!goodId(key)) throw new Error('Invalid replay data key')
        return [key, visit(plainMember(v, key), depth + 1)]
      }),
    )
  }
  return visit(value, 0)
}
export function plainMember(object: object, key: string): unknown {
  const member = Object.getOwnPropertyDescriptor(object, key)
  if (!member || !member.enumerable || !('value' in member))
    throw new Error('Replay does not accept accessors or missing data')
  return member.value
}

export function validateProgram(raw: unknown, rawInputs: unknown) {
  const program = copyData(raw)
  const inputs = copyData(rawInputs)
  if (
    !isRecord(program) ||
    !exact(program, ['version', 'operations']) ||
    program.version !== 1 ||
    !Array.isArray(program.operations) ||
    !program.operations.length ||
    program.operations.length > operationsLimit ||
    !isRecord(inputs) ||
    !Object.values(inputs).every((value) => text(value))
  ) {
    throw new Error('Unsupported immutable replay program or inputs')
  }
  const seen = new Set<string>()
  const parts = (items: unknown) =>
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= 16 &&
    items.every(
      (item: unknown) =>
        text(item) ||
        (isRecord(item) &&
          ((exact(item, ['input']) &&
            goodId(item.input) &&
            Object.hasOwn(inputs, item.input)) ||
            (exact(item, ['result']) &&
              goodId(item.result) &&
              seen.has(item.result)))),
    )
  for (const op of program.operations as unknown[]) {
    if (!isRecord(op) || !goodId(op.id) || seen.has(op.id))
      throw new Error('Replay operation IDs must be unique')
    const valid =
      op.kind === 'STEP' || op.kind === 'STEP_ALL'
        ? exact(op, ['id', 'kind', 'prompt']) && parts(op.prompt)
        : op.kind === 'GENERATE_N'
          ? exact(op, ['id', 'kind', 'prompt', 'count']) &&
            parts(op.prompt) &&
            typeof op.count === 'number' &&
            op.count >= 2 &&
            op.count <= 4
          : op.kind === 'clock' || op.kind === 'random'
            ? exact(op, ['id', 'kind'])
            : op.kind === 'sha256' &&
              exact(op, ['id', 'kind', 'value']) &&
              parts(op.value)
    if (!valid)
      throw new Error('Unsupported recipe operation or unbound input/result')
    seen.add(op.id)
  }
  return {
    program: program as ReplayProgram,
    inputs: inputs as Record<string, string>,
  }
}

export function validateModel(raw: unknown): ReplayProgramModel {
  const model = copyData(raw)
  if (
    !isRecord(model) ||
    !(
      exact(model, ['endpoint', 'name']) ||
      exact(model, ['endpoint', 'name', 'apiKey'])
    ) ||
    !text(model.endpoint, 2048) ||
    !text(model.name, 256) ||
    !model.name.trim() ||
    (model.apiKey !== undefined &&
      (!text(model.apiKey, 2048) || /[\x00-\x20\x7f]/.test(model.apiKey)))
  ) {
    throw new Error(
      'Replay requires one explicit OpenAI-compatible model route',
    )
  }
  const endpoint = new URL(model.endpoint)
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.pathname.endsWith('/chat/completions') ||
    (endpoint.protocol === 'http:' &&
      !['127.0.0.1', '[::1]'].includes(endpoint.hostname))
  ) {
    throw new Error(
      'Replay model route must use HTTPS or literal HTTP loopback and /chat/completions',
    )
  }
  return {
    endpoint: endpoint.href,
    name: model.name,
    ...(typeof model.apiKey === 'string' ? { apiKey: model.apiKey } : {}),
  }
}

export function validateReply(attempt: Attempt, value: unknown): Reply {
  if (
    attempt.kind === 'clock' &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  )
    return value
  if (
    attempt.kind === 'random' &&
    typeof value === 'string' &&
    /^[a-f0-9]{32}$/.test(value)
  )
    return value
  if (attempt.kind === 'sha256' && value === sha(attempt.value)) return value
  if (
    attempt.kind === 'model' &&
    Array.isArray(value) &&
    value.length === attempt.body.n &&
    value.every(
      (v: unknown) =>
        isRecord(v) &&
        exact(v, ['text', 'finish']) &&
        text(v.text) &&
        (v.finish === 'stop' || v.finish === 'length'),
    )
  )
    return value
  throw new Error('Retained reply does not match the request contract')
}

/** This is the only interpreter. The same fresh iterator drives initial and resumed runs. */
export function* programIterator(
  program: ReplayProgram,
  inputs: Record<string, string>,
  model: string,
): Generator<Attempt, Record<string, ReplayProgramOutput>, Reply> {
  const outputs: Record<string, ReplayProgramOutput> = Object.create(null)
  const render = (parts: ReplayProgramPart[]) => {
    const value = parts
      .map((p) =>
        typeof p === 'string'
          ? p
          : 'input' in p
            ? inputs[p.input]
            : typeof outputs[p.result] === 'string'
              ? outputs[p.result]
              : JSON.stringify(outputs[p.result]),
      )
      .join('')
    if (!text(value))
      throw new Error('Rendered replay input exceeds its byte bound')
    return value
  }
  for (const op of program.operations) {
    if (op.kind === 'clock' || op.kind === 'random') {
      outputs[op.id] = (yield { id: op.id, kind: op.kind }) as string | number
    } else if (op.kind === 'sha256') {
      outputs[op.id] = (yield {
        id: op.id,
        kind: op.kind,
        value: render(op.value),
      }) as string
    } else if ('prompt' in op) {
      const messages: Extract<Attempt, { kind: 'model' }>['body']['messages'] =
        [{ role: 'user', content: render(op.prompt) }]
      const segments: string[] = []
      for (let part = 0; ; part++) {
        const candidates = (yield {
          id: op.id,
          kind: 'model',
          operation: op.kind,
          part,
          body: {
            model,
            messages: [...messages],
            n: op.kind === 'GENERATE_N' ? op.count : 1,
            max_tokens: 1024,
            stream: false,
          },
        }) as { text: string; finish: 'stop' | 'length' }[]
        if (op.kind === 'GENERATE_N') {
          outputs[op.id] = candidates.map((c) => c.text)
          break
        }
        const [first] = candidates
        segments.push(first!.text)
        if (op.kind === 'STEP' || first!.finish === 'stop') {
          outputs[op.id] = segments.join('')
          break
        }
        if (part === 2)
          throw new Error('STEP_ALL did not settle within three model attempts')
        messages.push(
          { role: 'assistant', content: first!.text },
          { role: 'user', content: 'Continue from the previous answer.' },
        )
      }
    }
  }
  return outputs
}
