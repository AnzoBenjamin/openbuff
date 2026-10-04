import { getProjectRoot } from '../project-files'
import { getCodebuffClient } from '../utils/codebuff-client'
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
 * (defaults to 'base'), and an optional wall-clock deadline in seconds.
 */
export type RunCommandArgs = {
  prompt: string
  json: boolean
  agentId?: string
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

  // P2-T7: open the run journal lazily (only when a run actually starts, so
  // `--help`-style invocations never create an empty db) and wire it into
  // the SDK run for crash-safe resume + `openbuff dash`/replay. Fail-open by
  // contract: an unopenable journal means the run proceeds WITHOUT
  // journaling, never a failed run (the default opener warns via writeStderr
  // and returns undefined; a throwing opener is caught here too).
  let journal: CreatedRunJournal | undefined
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
  const flushStdout = (): void => {
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
    }
  }

  const handleEvent = (event: PrintModeEvent): void => {
    if (args.json) {
      queueStdout(JSON.stringify(event) + '\n')
      return
    }
    if (event.type === 'text') {
      queueStdout(event.text)
    }
  }

  writeStderr(
    `openbuff run: running agent ${args.agentId ?? 'base'} (project root ${projectRoot})`,
  )

  // Optional wall-clock deadline (`--timeout <seconds>`, default none so the
  // previous behavior is preserved). When set, the run is aborted after the
  // deadline; the abort rejects client.run, which the catch below turns into
  // a clean error event and exit code 1 — the run can never hang forever.
  let timedOut = false
  let timeoutSeconds: number | undefined
  let timeoutController: AbortController | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let forwardExternalAbort: (() => void) | undefined
  if (typeof args.timeout === 'number' && args.timeout > 0) {
    const seconds = args.timeout
    timeoutSeconds = seconds
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
        forwardExternalAbort = () => timeoutController?.abort(externalSignal.reason)
        externalSignal.addEventListener('abort', forwardExternalAbort, {
          once: true,
        })
      }
    }
    runSignal = timeoutController.signal
  }

  try {
    const client = await getClient()
    await client.run({
      agent: args.agentId ?? 'base',
      prompt: args.prompt,
      cwd: projectRoot,
      handleEvent,
      // P2-T7: the live run journals into the shared run journal. The SAME
      // object serves writer and reader (one connection, one file).
      ...(journal ? { journalWriter: journal, journalReader: journal } : {}),
      ...(runSignal ? { signal: runSignal } : {}),
    })
    flushStdout()
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
      writeStdout(JSON.stringify({ type: 'error', message }) + '\n')
    }
    writeStderr(`openbuff run: ${message}`)
    return 1
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
    }
    if (forwardExternalAbort && externalSignal) {
      externalSignal.removeEventListener('abort', forwardExternalAbort)
    }
    if (journal) {
      // P2-T7: the run's promise-chain end is the journal's cleanup seam.
      // Best-effort (the exit code is already decided): a close failure is
      // logged, never thrown.
      void journal.close().catch((closeError) => {
        writeStderr(
          `openbuff run: run journal close failed: ${
            closeError instanceof Error ? closeError.message : String(closeError)
          }`,
        )
      })
    }
  }
}
