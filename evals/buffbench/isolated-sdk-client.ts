import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { withEvaluationEnvironment } from './evaluation-environment'
import type { OpenbuffClient } from '@openbuff/sdk'
import type { AgentDefinition } from '@openbuff/sdk'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import {
  captureEvaluationCommand,
  createEvaluationExecution,
  deriveEvaluationExecution,
  retainEvaluationRootUntilCleanup,
} from './execution'
import type { EvaluationCaptureResult } from './execution'
import type { OwnedProcessScope } from '@codebuff/common/types/contracts/process-scope'

const isolatedClients = new WeakSet<object>()
const isolatedClientMarker = Symbol('isolated SDK adapter')
export function isIsolatedEvaluationClient(client: unknown): boolean {
  return Boolean(
    client &&
    typeof client === 'object' &&
    (isolatedClients.has(client) ||
      (client as any)[isolatedClientMarker] === true),
  )
}

function requireSerializable(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (value === undefined || value === null) return
  if (
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  )
    throw new Error(
      'Isolated SDK execution refuses nonserializable callbacks or definitions',
    )
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Isolated SDK input must be finite')
  if (typeof value === 'object') {
    if (ancestors.has(value))
      throw new Error('Isolated SDK execution refuses cyclic input')
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('Isolated SDK execution requires plain JSON input')
    ancestors.add(value)
    for (const entry of Object.values(value))
      requireSerializable(entry, ancestors)
    ancestors.delete(value)
  }
}

/** Source-SDK adapter. Isolation covers process env/home, not OS access or network. */
export function createIsolatedEvaluationClient(
  options: {
    agentDefinitions?: AgentDefinition[]
    /** Fixture-only fetch refusal; this is not OS/network confinement. */
    refuseFetchForFixture?: boolean
    /** Host-only callback; never serialized into the worker request. */
    executionForRun?: (
      input: Parameters<OpenbuffClient['run']>[0],
    ) => ExecutionAdapterContext
  } = {},
) {
  const { executionForRun, ...serializedOptions } = options
  requireSerializable(serializedOptions)
  const observations: Record<string, unknown>[] = []
  const run: OpenbuffClient['run'] = async (input) => {
    const execution = deriveEvaluationExecution(
      executionForRun?.(input) ??
        createEvaluationExecution({
          cwd: input.cwd ?? process.cwd(),
          env: input.env,
          inheritEnv: false,
          signal: input.signal,
        }),
      'evaluator.worker',
    )
    const { handleEvent, signal, ...serialized } = input
    for (const name of [
      'overrideTools',
      'mcpServers',
      'requestApproval',
      'handleStreamChunk',
      'fsSource',
      'spawnSource',
      'getUserInput',
      'onFilesChanged',
      'onFilesystemMutation',
    ]) {
      if ((serialized as Record<string, unknown>)[name] !== undefined)
        throw new Error(`Isolated SDK execution refuses host seam ${name}`)
    }
    requireSerializable(serialized)
    const definitions = new Map(
      (input.agentDefinitions ?? []).map((definition) => [
        definition.id,
        definition,
      ]),
    )
    for (const definition of options.agentDefinitions ?? [])
      definitions.set(definition.id, definition)
    const payload = {
      input: { ...serialized, agentDefinitions: [...definitions.values()] },
      refuseFetchForFixture: options.refuseFetchForFixture === true,
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024)
      throw new Error('Isolated SDK request exceeds 2 MiB')
    return withEvaluationEnvironment(
      'key_free_environment',
      input.env,
      async (env) => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), 'buffbench-sdk-worker-'),
        )
        const request = path.join(root, 'request.json')
        const response = path.join(root, 'response.json')
        const events = path.join(root, 'events.jsonl')
        fs.writeFileSync(
          request,
          JSON.stringify({ ...payload, input: { ...payload.input, env } }),
          { flag: 'wx' },
        )
        fs.writeFileSync(events, '', { flag: 'wx' })
        let retained = false
        let scope: OwnedProcessScope | undefined
        let pid: number | undefined
        let eventFd: number | undefined
        let polling: ReturnType<typeof setInterval> | undefined
        let evidenceError: Error | undefined
        let eventOffset = 0
        let eventSeenBytes = 0
        let eventsReplayed = 0
        let pendingEvent = ''
        const decoder = new StringDecoder('utf8')
        const buffer = Buffer.alloc(64 * 1024)
        const limit = 8 * 1024 * 1024
        // The source worker refuses event lines before writing past 8 MiB.
        // Keep sampling and dropping after failure until scope cleanup ends.
        const drain = () => {
          if (eventFd === undefined) return
          try {
            const available = fs.fstatSync(eventFd).size
            eventSeenBytes = Math.max(eventSeenBytes, available)
            while (eventOffset < Math.min(available, limit)) {
              const count = fs.readSync(
                eventFd,
                buffer,
                0,
                Math.min(
                  buffer.length,
                  available - eventOffset,
                  limit - eventOffset,
                ),
                eventOffset,
              )
              if (!count) break
              eventOffset += count
              if (evidenceError) continue
              pendingEvent += decoder.write(buffer.subarray(0, count))
              let newline: number
              while ((newline = pendingEvent.indexOf('\n')) >= 0) {
                const line = pendingEvent.slice(0, newline)
                pendingEvent = pendingEvent.slice(newline + 1)
                if (line) {
                  handleEvent?.(JSON.parse(line))
                  eventsReplayed++
                }
              }
            }
            if (available > limit)
              throw new Error('Isolated SDK event evidence exceeds 8 MiB')
          } catch (error) {
            evidenceError ??=
              error instanceof Error ? error : new Error(String(error))
            pendingEvent = ''
            void scope?.requestStop('output-limit')
          }
        }
        const stopMonitoring = () => {
          if (polling !== undefined) clearInterval(polling)
          drain()
          if (eventFd !== undefined) {
            fs.closeSync(eventFd)
            eventFd = undefined
          }
        }
        try {
          signal?.throwIfAborted()
          eventFd = fs.openSync(events, 'r')
          const pending = captureEvaluationCommand(
            process.execPath,
            [
              '--no-env-file',
              path.join(__dirname, 'isolated-sdk-worker.ts'),
              request,
              response,
              events,
            ],
            {
              cwd: root,
              env: { ...env, OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
              signal,
              execution,
              captureLimitBytes: limit,
              branchId: 'supplemental.evaluator.isolated-worker',
              onProcessScope: (owned, child) => {
                scope = owned
                pid = child.pid
              },
            },
          ).then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
          polling = setInterval(drain, 20)
          const settled = await pending
          drain()
          const capture: EvaluationCaptureResult | undefined =
            'value' in settled
              ? settled.value
              : settled.error.processCleanup
                ? settled.error
                : undefined
          const captureError: Error | undefined =
            'error' in settled ? settled.error : undefined
          const withCapture = (error: Error) =>
            Object.assign(error, capture ?? {})
          const evidence = {
            adapterScope: 'child_process_replacement_environment',
            pid,
            cwd: root,
            home: env.HOME,
            exitCode: capture?.commandExitCode ?? null,
            cancelled: Boolean(
              signal?.aborted || captureError?.name === 'AbortError',
            ),
            eventBytes: eventOffset,
            eventSeenBytes,
            eventsReplayed,
            eventIncomplete: pendingEvent.length > 0,
            evidenceError: evidenceError?.message,
            processCleanup: capture?.processCleanup,
            outputCapture: capture?.outputCapture,
          }
          if (capture?.processCleanup.status !== 'complete') {
            observations.push(evidence)
            throw withCapture(
              captureError ??
                new Error('Isolated SDK worker cleanup was not observed'),
            )
          }
          if (fs.existsSync(response)) {
            if (fs.statSync(response).size > limit) {
              observations.push({
                ...evidence,
                evidenceError: 'Isolated SDK response exceeds 8 MiB',
              })
              throw withCapture(
                new Error('Isolated SDK response exceeds 8 MiB'),
              )
            }
            const output = JSON.parse(fs.readFileSync(response, 'utf8'))
            observations.push({ ...output.observation, ...evidence })
            if (signal?.aborted)
              throw withCapture(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error(
                      String(
                        signal.reason ?? 'Isolated SDK worker was aborted',
                      ),
                    ),
              )
            if (evidenceError) throw withCapture(evidenceError)
            if (output.error) throw withCapture(new Error(output.error))
            if (captureError) throw withCapture(captureError)
            return output.result
          }
          observations.push(evidence)
          if (signal?.aborted)
            throw withCapture(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(
                    String(signal.reason ?? 'Isolated SDK worker was aborted'),
                  ),
            )
          if (evidenceError) throw withCapture(evidenceError)
          throw withCapture(
            captureError ??
              new Error(
                `Isolated SDK worker exited ${capture.commandExitCode}: ${capture.stderr.slice(0, 2_000)}`,
              ),
          )
        } catch (error) {
          retained = retainEvaluationRootUntilCleanup(error, () => {
            stopMonitoring()
            fs.rmSync(root, { recursive: true, force: true })
          })
          if (retained && error && typeof error === 'object') {
            try {
              Object.assign(error, { retainedWorkerRoot: root })
            } catch {
              /* preserve original failure */
            }
          }
          throw error
        } finally {
          if (!retained) {
            stopMonitoring()
            fs.rmSync(root, { recursive: true, force: true })
          }
        }
      },
    )
  }
  const client = {
    run,
    [isolatedClientMarker]: true,
  } as unknown as OpenbuffClient
  isolatedClients.add(client)
  return { client, observations }
}
