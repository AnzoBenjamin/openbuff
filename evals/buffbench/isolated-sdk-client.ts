import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { withEvaluationEnvironment } from './evaluation-environment'
import type { OpenbuffClient } from '@openbuff/sdk'
import type { AgentDefinition } from '@openbuff/sdk'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import {
  createEvaluationExecution,
  deriveEvaluationExecution,
  prepareEvaluationCommand,
} from './execution'

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
        const stderrPath = path.join(root, 'stderr')
        const stderrFd = fs.openSync(stderrPath, 'wx')
        fs.writeFileSync(
          request,
          JSON.stringify({ ...payload, input: { ...payload.input, env } }),
          { flag: 'wx' },
        )
        fs.writeFileSync(events, '', { flag: 'wx' })
        try {
          signal?.throwIfAborted()
          const dispatch = await prepareEvaluationCommand(
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
              stdio: ['ignore', stderrFd, stderrFd],
              detached: process.platform !== 'win32',
              execution,
              branchId: 'supplemental.evaluator.isolated-worker',
            },
          )
          const child = dispatch()
          let escalation: ReturnType<typeof setTimeout> | undefined
          let evidenceError: Error | undefined
          let eventOffset = 0
          let eventsReplayed = 0
          let pendingEvent = ''
          const decoder = new StringDecoder('utf8')
          const eventFd = fs.openSync(events, 'r')
          const kill = (termination: NodeJS.Signals) => {
            try {
              if (process.platform !== 'win32' && child.pid)
                process.kill(-child.pid, termination)
              else child.kill(termination)
            } catch {
              /* already exited */
            }
          }
          const abort = () => {
            kill('SIGTERM')
            escalation ??= setTimeout(() => kill('SIGKILL'), 250)
          }
          // Replay complete prefixes while running, including paid finish events.
          // Bounds describe evidence transport, not OS resource confinement.
          const drain = () => {
            if (evidenceError) return
            try {
              const available = fs.fstatSync(eventFd).size
              const limit = 8 * 1024 * 1024
              const buffer = Buffer.alloc(64 * 1024)
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
              if (fs.statSync(stderrPath).size > limit)
                throw new Error('Isolated SDK stderr exceeds 8 MiB')
            } catch (error) {
              evidenceError =
                error instanceof Error ? error : new Error(String(error))
              abort()
            }
          }
          const polling = setInterval(drain, 20)
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
          let launchError: Error | undefined
          const exitCode = await new Promise<number | null>((resolve) => {
            child.once('error', (error) => {
              launchError = error
            })
            child.once('close', resolve)
          })
          signal?.removeEventListener('abort', abort)
          if (escalation) clearTimeout(escalation)
          clearInterval(polling)
          drain()
          fs.closeSync(eventFd)
          if (escalation) clearTimeout(escalation)
          const evidence = {
            adapterScope: 'child_process_replacement_environment',
            pid: child.pid,
            cwd: root,
            home: env.HOME,
            exitCode,
            cancelled: Boolean(signal?.aborted),
            eventBytes: eventOffset,
            eventsReplayed,
            evidenceError: evidenceError?.message,
          }
          if (fs.existsSync(response)) {
            if (fs.statSync(response).size > 8 * 1024 * 1024) {
              observations.push({
                ...evidence,
                evidenceError: 'Isolated SDK response exceeds 8 MiB',
              })
              throw new Error('Isolated SDK response exceeds 8 MiB')
            }
            const output = JSON.parse(fs.readFileSync(response, 'utf8'))
            observations.push({ ...evidence, ...output.observation })
            signal?.throwIfAborted()
            if (evidenceError) throw evidenceError
            if (output.error) throw new Error(output.error)
            if (exitCode !== 0)
              throw new Error(`Isolated SDK worker exited ${exitCode}`)
            return output.result
          }
          observations.push(evidence)
          signal?.throwIfAborted()
          if (evidenceError) throw evidenceError
          throw (
            launchError ??
            new Error(
              `Isolated SDK worker exited ${exitCode}: ${fs.readFileSync(stderrPath, 'utf8').slice(0, 2000)}`,
            )
          )
        } finally {
          fs.closeSync(stderrFd)
          fs.rmSync(root, { recursive: true, force: true })
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
