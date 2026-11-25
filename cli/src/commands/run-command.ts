import { getProjectRoot } from '../project-files'
import { runFailureMessage } from '@codebuff/common/types/run-outcome'
import { captureRunDeadline, projectRunOutcomes } from '@openbuff/sdk'
import { getCodebuffClient } from '../utils/codebuff-client'
import { AGENT_MODE_TO_ID } from '../utils/constants'
import { readRunOutputSchema } from '../utils/run-output-schema'
import { getOpenbuffProviderReadiness } from '../utils/openbuff-provider'
import { loadAgentDefinitions } from '../utils/local-agent-registry'
import {
  createHeadlessSessionStore,
  type HeadlessSessionLease,
  type HeadlessSessionStore,
} from '../utils/headless-sessions'
import {
  readHeadlessPrompt,
  type HeadlessPromptInput,
} from '../utils/headless-prompt'
import {
  openRunJournalForRun,
  resolveRunJournalPath,
} from '../utils/run-journal-path'

import type { CreatedRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import type { OpenbuffClient, PrintModeEvent } from '@openbuff/sdk'

/**
 * The parsed `openbuff run` invocation (mirrors `ParsedArgs.run`): the joined
 * positional prompt, whether to emit the machine-readable ndjson event stream
 * (`json`) or a plain text stream, an optional agent id override
 * (defaults to 'base2'), and an optional wall-clock deadline in seconds.
 */
export type RunCommandArgs = {
  prompt: string
  readFromStdin?: boolean
  json: boolean
  agentId?: string
  /** Captured primary routing override for this run; configuration is not modified. */
  model?: string
  /** Explicit file holding the root run's JSON object result contract. */
  outputSchema?: string
  /** Start a new turn using an explicitly selected or last saved headless conversation. */
  continue?: boolean
  continueId?: string
  /**
   * Optional wall-clock deadline in seconds (`openbuff run --timeout <n>`).
   * Undefined (the default) preserves the previous no-timeout behavior. When
   * set, the client run is aborted after the deadline and the command exits
   * non-zero with a clean `{ "type": "error", ... }` ndjson line in --json
   * mode.
   */
  timeout?: number
}

/**
 * Fully-injectable seams for `runHeadlessCommand`. Every dependency defaults
 * to the real CLI implementation, so production callers pass nothing and
 * tests inject hermetic stubs (never touching a real client or stdio).
 */
export type RunHeadlessDeps = {
  getClient?: () => Promise<OpenbuffClient>
  writeStdout?: (chunk: string) => void
  writeStderr?: (line: string) => void
  projectRoot?: string
  signal?: AbortSignal
  stdin?: HeadlessPromptInput
  stdinIsTTY?: boolean
  /** Injected clients own readiness/storage unless they explicitly supply these seams. */
  getProviderReadiness?: (input: {
    agentId: string
    model?: string
  }) => { ok: true } | { ok: false; message: string }
  sessionStore?: HeadlessSessionStore
  /**
   * P2-T7: how to open the run journal for this run. Fail-open by contract:
   * returning undefined runs WITHOUT journaling instead of failing the run.
   * Defaults to the real fail-open opener at the shared journal path; tests
   * inject a stub.
   */
  openRunJournal?: (path: string) => CreatedRunJournal | undefined
  /** Journal db location; defaults to the shared resolveRunJournalPath(). */
  journalPath?: string
}

class HeadlessAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The `openbuff run` entry the CLI dispatches BEFORE the TUI. It builds the
 * real `OpenbuffClient` and runs the agent non-interactively on the prompt,
 * streaming events as it goes.
 *
 * stdout is the machine-readable wire in --json mode: each `PrintModeEvent`
 * is written as exactly one `JSON.stringify(event) + '\n'` ndjson line and
 * NOTHING else touches stdout; every human/diagnostic line goes to stderr via
 * `writeStderr`. Without --json only `text` events' text streams to stdout.
 * Writes are BATCHED (flushed every 32 events or 64 KiB) so a fast event
 * stream does not issue one synchronous stdout write per event; content,
 * ordering, and ndjson line integrity are unchanged — only the write
 * granularity is.
 *
 * The returned number is the process exit code (the caller owns
 * `process.exit` / `process.exitCode`): 0 on success, 1 on failure. On a
 * thrown error a single `{ "type": "error", "message": <message> }` ndjson
 * line is written to stdout in --json mode (and the message to stderr), then
 * 1 is returned — this function never throws for a failed run.
 */
export async function runHeadlessCommand(
  args: RunCommandArgs,
  deps?: RunHeadlessDeps,
): Promise<number> {
  const getClient = deps?.getClient ?? (() => getCodebuffClient())
  const writeStdout =
    deps?.writeStdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))
  // Resolve getProjectRoot() lazily here (after initializeApp has run in
  // index.tsx), never at module load; tests that inject projectRoot never call it.
  const projectRoot = deps?.projectRoot ?? getProjectRoot()
  let agentId = args.agentId ?? AGENT_MODE_TO_ID.DEFAULT
  let session: HeadlessSessionLease | undefined
  const readiness =
    deps?.getProviderReadiness ??
    (deps?.getClient
      ? () => ({ ok: true as const })
      : (input: { agentId: string; model?: string }) =>
          getOpenbuffProviderReadiness({
            agent:
              loadAgentDefinitions().find(
                (agent) => agent.id === input.agentId,
              ) ?? input.agentId,
            agentMode: 'DEFAULT',
            model: input.model,
          }))

  // P2-T7: open the run journal lazily (only when a run actually starts, so
  // `--help`-style invocations never create an empty db) and wire it into
  // the SDK run for crash-safe resume + `openbuff dash`/replay. Fail-open by
  // contract: an unopenable journal means the run proceeds WITHOUT
  // journaling, never a failed run (the default opener warns via writeStderr
  // and returns undefined; a throwing opener is caught here too).
  let journal: CreatedRunJournal | undefined
  const openJournal = () => {
    try {
      const openJournalPath = deps?.journalPath ?? resolveRunJournalPath()
      if (deps?.openRunJournal) {
        journal = deps.openRunJournal(openJournalPath)
        if (!journal) {
          // Fail-open contract covers the INJECTED opener too: returning no
          // journal means the run proceeds WITHOUT journaling — warn once to
          // stderr, never throw. (A throwing opener is handled by the catch
          // below; the default opener warns through its own callback, so
          // neither path double-warns.)
          writeStderr(
            'openbuff run: run journal unavailable, continuing without journaling (the opener returned no journal)',
          )
        }
      } else {
        journal = openRunJournalForRun({
          path: openJournalPath,
          warn: (message) => writeStderr(`openbuff run: ${message}`),
        })
      }
    } catch (error) {
      writeStderr(
        `openbuff run: run journal unavailable, continuing without journaling (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  // Batched stdout writes: buffering events and flushing in chunks avoids one
  // synchronous stdout write per event (a slow pipe would stall the agent loop
  // on backpressure for every event). Flushes fire every
  // STDOUT_FLUSH_EVERY_EVENTS events or once the buffer exceeds
  // STDOUT_FLUSH_AT_CHARS, and whole lines always move together — ndjson line
  // integrity is preserved byte-for-byte; only write granularity changes.
  const STDOUT_FLUSH_EVERY_EVENTS = 32
  const STDOUT_FLUSH_AT_CHARS = 64 * 1024
  let stdoutBuffer = ''
  let bufferedEvents = 0
  let stdoutTimer: ReturnType<typeof setTimeout> | undefined
  const flushStdout = (): void => {
    if (stdoutTimer !== undefined) clearTimeout(stdoutTimer)
    stdoutTimer = undefined
    if (stdoutBuffer.length === 0) return
    writeStdout(stdoutBuffer)
    stdoutBuffer = ''
    bufferedEvents = 0
  }
  const queueStdout = (chunk: string): void => {
    stdoutBuffer += chunk
    bufferedEvents += 1
    if (
      bufferedEvents >= STDOUT_FLUSH_EVERY_EVENTS ||
      stdoutBuffer.length >= STDOUT_FLUSH_AT_CHARS
    ) {
      flushStdout()
    } else if (stdoutTimer === undefined) {
      // Sparse NDJSON events must be visible while a slow provider/tool is pending too.
      stdoutTimer = setTimeout(flushStdout, 50)
    }
  }

  const handleEvent = (event: PrintModeEvent): void => {
    if (args.json) {
      queueStdout(JSON.stringify(event) + '\n')
      return
    }
    if (!args.outputSchema && event.type === 'text') {
      queueStdout(event.text)
    }
  }

  // Optional wall-clock deadline (`--timeout <seconds>`, default none so the
  // previous behavior is preserved). When set, the run is aborted after the
  // deadline; the abort rejects client.run, which the catch below turns into
  // a clean error event and exit code 1 — the run can never hang forever.
  let timedOut = false
  let timeoutSeconds: number | undefined
  let timeoutController: AbortController | undefined
  let runDeadline: ReturnType<typeof captureRunDeadline> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let forwardExternalAbort: (() => void) | undefined
  if (typeof args.timeout === 'number' && args.timeout > 0) {
    const seconds = args.timeout
    timeoutSeconds = seconds
    runDeadline = captureRunDeadline(seconds * 1000)
    timeoutController = new AbortController()
    timeoutTimer = setTimeout(() => {
      timedOut = true
      timeoutController?.abort(
        new Error(`run timed out after ${seconds} seconds (--timeout)`),
      )
    }, seconds * 1000)
  }

  // The signal handed to client.run: the injected deps.signal when present,
  // otherwise the timeout controller's signal. When both exist, the external
  // abort is forwarded onto the timeout controller so a single signal carries
  // both cancellation sources.
  const externalSignal = deps?.signal
  let runSignal: AbortSignal | undefined = externalSignal
  if (timeoutController) {
    if (externalSignal) {
      if (externalSignal.aborted) {
        timeoutController.abort(externalSignal.reason)
      } else {
        forwardExternalAbort = () =>
          timeoutController?.abort(externalSignal.reason)
        externalSignal.addEventListener('abort', forwardExternalAbort, {
          once: true,
        })
      }
    }
    runSignal = timeoutController.signal
  }

  try {
    if (runDeadline && !runDeadline.ok) throw new Error(runDeadline.cause)
    const prompt = args.readFromStdin
      ? await readHeadlessPrompt({
          input: deps?.stdin ?? process.stdin,
          isTTY: deps?.stdinIsTTY ?? process.stdin.isTTY,
          signal: runSignal,
        })
      : args.prompt
    if (!prompt.trim())
      throw new Error(
        'A prompt is required; pass text, -p <prompt>, or pipe text to stdin.',
      )
    if (runSignal?.aborted) throw runSignal.reason
    const outputContract =
      args.outputSchema !== undefined
        ? await readRunOutputSchema(args.outputSchema)
        : undefined
    if (runSignal?.aborted) throw runSignal.reason
    let sessionStore: HeadlessSessionStore | undefined
    const selectStore = () =>
      (sessionStore ??=
        deps?.sessionStore ??
        (deps?.getClient
          ? undefined
          : createHeadlessSessionStore({ projectRoot })))
    if (args.continue) {
      try {
        const store = selectStore()
        if (!store)
          throw new Error(
            'The injected host did not provide headless conversation storage.',
          )
        session = await store.acquire({
          continue: true,
          continueId: args.continueId,
          signal: runSignal,
        })
        agentId = args.agentId ?? session.agentId ?? AGENT_MODE_TO_ID.DEFAULT
      } catch (error) {
        if (runSignal?.aborted) throw runSignal.reason
        throw new HeadlessAdmissionError(
          'headless_session_unavailable',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const ready = readiness({ agentId, model: args.model })
    if (!ready.ok)
      throw new HeadlessAdmissionError('provider_unavailable', ready.message)
    if (runSignal?.aborted) throw runSignal.reason
    if (!args.continue) {
      try {
        session = await selectStore()?.acquire({ signal: runSignal })
      } catch (error) {
        if (runSignal?.aborted) throw runSignal.reason
        writeStderr(
          `openbuff run: conversation storage unavailable; this run will not be continuable (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    writeStderr(
      `openbuff run: running agent ${agentId} (project root ${projectRoot})`,
    )
    if (session)
      writeStderr(
        `openbuff run: session ${session.sessionId}${args.continue ? ' (continuing with a new turn)' : ''}`,
      )
    openJournal()
    const client = await getClient()
    if (runSignal?.aborted) throw runSignal.reason
    const result = projectRunOutcomes(
      await client.run({
        agent: agentId,
        prompt,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(outputContract ? { outputSchema: outputContract.schema } : {}),
        cwd: projectRoot,
        projectContextMode: 'paths',
        ...(session?.previousRun ? { previousRun: session.previousRun } : {}),
        // Conversation continuation deliberately does not enable interrupted effect replay.
        handleEvent,
        // Fresh runs share one journal port. Disk conversation continuation
        // must not admit the legacy reader's interrupted-effect re-drive path.
        ...(journal ? { journalWriter: journal } : {}),
        ...(session?.previousRun
          ? { journalReader: undefined }
          : journal
            ? { journalReader: journal }
            : {}),
        ...(runSignal ? { signal: runSignal } : {}),
        ...(runDeadline?.ok ? { runDeadline: runDeadline.value } : {}),
      }),
    )
    if (session && result.sessionState) {
      try {
        await session.save(result, agentId)
      } catch (error) {
        const message = `Conversation state could not be saved: ${error instanceof Error ? error.message : String(error)}`
        if (args.continue)
          throw new HeadlessAdmissionError(
            'headless_session_persist_failed',
            message,
          )
        writeStderr(
          `openbuff run: ${message}; this result is not saved for continuation.`,
        )
      }
    }
    flushStdout()
    const message = timedOut
      ? `timed out after ${timeoutSeconds} seconds (--timeout); the run was aborted`
      : runFailureMessage(result)
    if (message) {
      const runOutcome = timedOut
        ? {
            termination: 'deadline_exhausted',
            cause: { code: 'run_timeout', message },
          }
        : result.runOutcome
      if (args.json) {
        writeStdout(
          JSON.stringify({
            type: 'error',
            message,
            runOutcome,
            taskAcceptance: result.taskAcceptance,
          }) + '\n',
        )
      }
      writeStderr(`openbuff run: ${message}`)
      return 1
    }
    if (outputContract) {
      if (
        result.output.type !== 'structuredOutput' ||
        !outputContract.validator.safeParse(result.output.value).success
      )
        throw new Error(
          'Run output did not match the selected output schema; no validated result was delivered.',
        )
      writeStdout(
        JSON.stringify(
          args.json
            ? {
                type: 'result',
                output: result.output.value,
                runOutcome: result.runOutcome,
                taskAcceptance: result.taskAcceptance,
              }
            : result.output.value,
        ) + '\n',
      )
    }
    return 0
  } catch (error) {
    // Flush the batched events BEFORE the error line so it lands last.
    flushStdout()
    const message = timedOut
      ? `timed out after ${timeoutSeconds} seconds (--timeout); the run was aborted`
      : error instanceof Error
        ? error.message
        : String(error)
    if (args.json) {
      // Keep stdout strictly ndjson: the failure is one machine-readable line.
      writeStdout(
        JSON.stringify({
          type: 'error',
          message,
          runOutcome: {
            termination: timedOut
              ? 'deadline_exhausted'
              : runSignal?.aborted
                ? 'cancelled'
                : 'failed',
            cause: {
              code: timedOut
                ? 'run_timeout'
                : runSignal?.aborted
                  ? 'run_cancelled'
                  : error instanceof HeadlessAdmissionError
                    ? error.code
                    : 'run_error',
              message,
            },
          },
          taskAcceptance: { status: 'unknown' },
        }) + '\n',
      )
    }
    writeStderr(`openbuff run: ${message}`)
    return 1
  } finally {
    if (stdoutTimer !== undefined) clearTimeout(stdoutTimer)
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
    }
    if (forwardExternalAbort && externalSignal) {
      externalSignal.removeEventListener('abort', forwardExternalAbort)
    }
    if (session) {
      try {
        await session.close()
      } catch (error) {
        writeStderr(
          `openbuff run: session release failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (journal) {
      // Join the writer's flush/close before this command returns.
      try {
        await journal.close()
      } catch (closeError) {
        writeStderr(
          `openbuff run: run journal close failed: ${
            closeError instanceof Error
              ? closeError.message
              : String(closeError)
          }`,
        )
      }
    }
  }
}
