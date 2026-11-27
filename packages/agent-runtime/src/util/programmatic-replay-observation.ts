import { createHash } from 'node:crypto'

import type { JournalWriter } from '@codebuff/common/types/contracts/agent-runtime'
import {
  captureValueSha256,
  snapshotReplayValue,
} from './recorded-replay-prefix'

const VALUE_BYTES = 64 * 1024
const TRACE_BYTES = 2 * 1024 * 1024
const YIELD_LIMIT = 1024
const hashSource = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')
const contractSha256 = captureValueSha256({
  version: 1,
  records: ['basis', 'yield', 'next_input', 'generator_return', 'gap'],
  nextInputScope: 'explicit arguments only; excludes live agent state',
})

type Pending = { ordinal: number; occurrence: number; requestSha256: string }

export type ProgrammaticReplayRecorder = {
  runId: string
  agentId: string
  writer: JournalWriter
  yielded(stepNumber: number, value: unknown): Promise<void>
  beforeNext(stepNumber: number, values: Record<string, unknown>): Promise<void>
  returned(stepNumber: number, value: unknown): Promise<void>
  gap(stepNumber: number, reason: 'invalid_yield' | 'exception'): Promise<void>
}

function dataHash(value: unknown): string | null {
  try {
    return snapshotReplayValue(value, VALUE_BYTES).sha256
  } catch {
    return null
  }
}

/**
 * Capture the executed artifact identity and what crossed the iterator's
 * explicit boundary. This is diagnostic evidence, not a bundle closure:
 * arbitrary JS can still consult mutable agent state, imports, or host I/O
 * that never cross it. Nothing that consumes these rows may admit live replay.
 */
export async function beginProgrammaticReplayObservation(params: {
  writer: JournalWriter
  runId: string
  agentId: string
  templateId: string
  stepNumber: number
  program: unknown
  runtimeSource: string
  configuration: unknown
  input: unknown
}): Promise<ProgrammaticReplayRecorder | undefined> {
  const { writer, runId } = params
  if (writer.captureProgrammaticReplay !== true || !writer.appendDurable)
    return undefined
  const write = writer.appendDurable.bind(writer)
  let active = true
  let bytes = 0
  let ordinal = 0
  let pending: Pending | undefined
  const occurrences = new Map<string, number>()
  const append = async (
    stepNumber: number,
    payload: Record<string, unknown>,
  ) => {
    try {
      await write(runId, {
        eventType: 'programmatic_observation',
        stepNumber,
        payload: { ...payload, replayPermitted: false },
      })
    } catch {
      // A recording failure cannot synthesize evidence or authorize a retry.
      active = false
    }
  }
  const gap = async (
    stepNumber: number,
    reason: 'invalid_yield' | 'exception' | 'unrecordable_data' | 'capacity',
  ) => {
    if (!active) return
    active = false
    await append(stepNumber, {
      kind: 'gap',
      reason,
      ...(pending ?? { ordinal }),
      replayPermitted: false,
    })
  }
  const emit = async (stepNumber: number, payload: Record<string, unknown>) => {
    if (!active) return
    bytes += Buffer.byteLength(JSON.stringify(payload))
    if (bytes > TRACE_BYTES) {
      await gap(stepNumber, 'capacity')
      return
    }
    await append(stepNumber, payload)
  }
  const snapshot = async (stepNumber: number, value: unknown) => {
    try {
      return snapshotReplayValue(value, VALUE_BYTES)
    } catch {
      await gap(stepNumber, 'unrecordable_data')
      return undefined
    }
  }

  await emit(params.stepNumber, {
    kind: 'basis',
    version: 1,
    replayPermitted: false,
    agentId: params.agentId,
    templateId: params.templateId,
    artifact:
      typeof params.program === 'string'
        ? {
            kind: 'serialized_handle_steps',
            sourceSha256: hashSource(params.program),
            byteLength: Buffer.byteLength(params.program),
          }
        : { kind: 'opaque_callable' },
    runtime: {
      componentSha256: hashSource(params.runtimeSource),
      engine: process.versions.bun
        ? `bun/${process.versions.bun}`
        : `node/${process.versions.node}`,
      platform: process.platform,
      arch: process.arch,
    },
    contractSha256,
    configurationSha256: dataHash(params.configuration),
    inputSha256: dataHash(params.input),
    limitations: [
      'runtime_component_not_bundle_closure',
      'live_agent_state_and_host_io_not_captured',
    ],
  })
  if (!active) return undefined
  return {
    runId,
    agentId: params.agentId,
    writer,
    async yielded(stepNumber, value) {
      if (!active) return
      if (ordinal >= YIELD_LIMIT) return gap(stepNumber, 'capacity')
      const captured = await snapshot(stepNumber, value)
      if (!captured) return
      const occurrence = occurrences.get(captured.sha256) ?? 0
      occurrences.set(captured.sha256, occurrence + 1)
      pending = {
        ordinal: ordinal++,
        occurrence,
        requestSha256: captured.sha256,
      }
      await emit(stepNumber, {
        kind: 'yield',
        ...pending,
        value: captured.value,
      })
    },
    async beforeNext(stepNumber, values) {
      if (!active || !pending) return // The first next() has no prior yield.
      const captured = await snapshot(stepNumber, {
        ...Object.fromEntries(
          Object.entries(values).filter(([, value]) => value !== undefined),
        ),
        undefinedKeys: Object.keys(values).filter(
          (key) => values[key] === undefined,
        ),
      })
      if (!captured) return
      const previous = pending
      pending = undefined
      // Offered input, not a claim that the iterator consumed it or that an
      // external effect was confirmed. Its authoritative receipts are separate.
      await emit(stepNumber, {
        kind: 'next_input',
        ...previous,
        value: captured.value,
        valueSha256: captured.sha256,
      })
    },
    async returned(stepNumber, value) {
      if (!active) return
      const captured = await snapshot(
        stepNumber,
        value === undefined ? { kind: 'undefined' } : { kind: 'value', value },
      )
      if (!captured) return
      await emit(stepNumber, {
        kind: 'generator_return',
        observedYields: ordinal,
        value: captured.value,
        valueSha256: captured.sha256,
      })
      active = false
    },
    gap,
  }
}
