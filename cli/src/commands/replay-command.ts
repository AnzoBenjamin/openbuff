import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'

import { resolveRunJournalPath } from '../utils/run-journal-path'

import type {
  JournalEvent,
  JournalReader,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@openbuff/sdk'

/**
 * The parsed `openbuff replay` invocation (mirrors `ParsedArgs.replay`): the
 * run id to replay, an optional step boundary to replay from (`fromStep`), an
 * optional model override for the replayed run (`model`), and whether to emit
 * the machine-readable ndjson event stream (`json`) or a human-readable trace.
 */
export type ReplayCommandArgs = {
  runId: string
  fromStep?: number
  model?: string
  json: boolean
}

/**
 * Fully-injectable seams for `runReplayCommand`. Every dependency defaults to
 * the real CLI implementation, so production callers pass nothing and tests
 * inject hermetic stubs (never touching a real journal or stdio). `openJournal`
 * is the ONLY way the journal is obtained: it defaults to the same
 * `createRunJournal` seam the runtime uses, so the CLI never opens sqlite
 * directly. `journalPath` defaults to the harness-state run-journal location.
 */
export type RunReplayDeps = {
  openJournal?: (path: string) => JournalReader & { close?: () => void }
  journalPath?: string
  writeStdout?: (chunk: string) => void
  writeStderr?: (line: string) => void
}

/**
 * The default on-disk location of the P2-T2 run journal (WAL sqlite).
 * Resolved lazily (never at module load) so tests that inject `journalPath`
 * never touch the real config directory. Now SHARED with the live-run and
 * dash wiring (cli/src/utils/run-journal-path.ts); re-exported here so the
 * replay command's public surface is unchanged.
 */
export { resolveRunJournalPath }

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Map one journaled event to the `PrintModeEvent` the replay stream emits for
 * it, or `null` when the event is structural (an `llm_request`, `spawn`, or
 * `step_boundary` has no PrintModeEvent analogue — those records are consumed
 * by `--from-step`, not emitted). Payloads are `unknown` in the journal, so
 * every field is read defensively and the mapping never throws on a
 * partially-shaped payload.
 */
function journalEventToPrintModeEvent(
  event: JournalEvent & { seq: number },
): PrintModeEvent | null {
  const payload = asRecord(event.payload)
  // A journaled tool_call/tool_result pair shares a correlation; when it is
  // absent fall back to the gap-free seq so the emitted id is still stable.
  const toolCallId = event.correlation ?? `seq-${event.seq}`
  switch (event.eventType) {
    case 'tool_call': {
      const toolName =
        typeof payload.toolName === 'string' ? payload.toolName : 'unknown'
      return {
        type: 'tool_call',
        toolCallId,
        toolName,
        input: asRecord(payload.input),
      }
    }
    case 'tool_result': {
      const toolName =
        typeof payload.toolName === 'string' ? payload.toolName : 'unknown'
      const output: ToolResultOutput[] = Array.isArray(payload.result)
        ? payload.result
        : []
      return { type: 'tool_result', toolCallId, toolName, output }
    }
    case 'llm_response': {
      const text =
        typeof payload.text === 'string'
          ? payload.text
          : typeof payload.message === 'string'
            ? payload.message
            : ''
      return { type: 'text', text }
    }
    case 'error': {
      const message =
        typeof payload.message === 'string' ? payload.message : 'replay error'
      return { type: 'error', message }
    }
    default:
      return null
  }
}

/** Human-readable replay trace (non-json mode): one line per journaled event. */
function formatHumanTrace(
  args: ReplayCommandArgs,
  events: Array<JournalEvent & { seq: number }>,
): string {
  const lines: string[] = []
  lines.push(
    `replay run ${args.runId}` +
      (args.fromStep !== undefined ? ` from step ${args.fromStep}` : '') +
      (args.model ? ` (model ${args.model})` : ''),
  )
  for (const event of events) {
    lines.push(
      `[step ${event.stepNumber} seq ${event.seq}] ${event.eventType}` +
        (event.correlation ? ` (${event.correlation})` : ''),
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * The `openbuff replay` entry the CLI dispatches BEFORE the TUI (P2-T3). It
 * opens the run journal through the injected `createRunJournal` seam, reads
 * the named run's journaled event stream, applies `--from-step`, and re-emits
 * the stream deterministically. The replay NEVER re-executes a side-effecting
 * tool: it re-emits journaled results, and any live re-drive on resume stays
 * the runtime's job via the `toolResultForInput` short-circuit (P2-T2-DESIGN
 * §5), which this command does not bypass. `--model` is honored as the replay
 * fork's model override; because this slice is a deterministic re-emission of
 * the journaled stream (no live LLM pass), it annotates the fork rather than
 * altering the stream.
 *
 * stdout contract: in --json mode stdout carries ONLY the machine-readable
 * ndjson stream (one `JSON.stringify(event) + '\n'` line per emitted
 * PrintModeEvent) — the emitted stream doubles as an eval-fixture export — and
 * every human/diagnostic line goes to stderr. Without --json the human-readable
 * replay trace goes to stdout.
 *
 * The returned number is the process exit code (the caller owns
 * `process.exit` / `process.exitCode`): 0 on success, 1 on an unknown run id,
 * an unavailable journal, or a replay error. This function never throws for a
 * failed replay.
 */
export async function runReplayCommand(
  args: ReplayCommandArgs,
  deps?: RunReplayDeps,
): Promise<number> {
  const writeStdout =
    deps?.writeStdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))
  const journalPath = deps?.journalPath ?? resolveRunJournalPath()
  const openJournal =
    deps?.openJournal ??
    ((journalFile: string) => createRunJournal({ path: journalFile }))

  writeStderr(
    `openbuff replay: replaying run ${args.runId}` +
      (args.fromStep !== undefined ? ` from step ${args.fromStep}` : '') +
      (args.model ? ` with model ${args.model}` : '') +
      ` (journal ${journalPath})`,
  )

  const emitError = (message: string): void => {
    if (args.json) {
      // Keep stdout strictly ndjson: the failure is one machine-readable line.
      writeStdout(JSON.stringify({ type: 'error', message }) + '\n')
    }
    writeStderr(`openbuff replay: ${message}`)
  }

  let journal: (JournalReader & { close?: () => void }) | undefined
  try {
    journal = openJournal(journalPath)
  } catch (error) {
    // Journal unavailable (e.g. sqlite cannot be acquired): fail closed.
    emitError(
      `journal unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }

  try {
    const events = journal.events(args.runId)
    if (events.length === 0) {
      // Unknown (or empty) run id: fail closed with a clear error, never crash.
      emitError(`unknown run id ${args.runId}`)
      return 1
    }
    const fromStep = args.fromStep ?? 0
    const filtered =
      fromStep > 0
        ? events.filter((event) => event.stepNumber >= fromStep)
        : events

    if (args.json) {
      for (const event of filtered) {
        const out = journalEventToPrintModeEvent(event)
        if (out) {
          writeStdout(JSON.stringify(out) + '\n')
        }
      }
    } else {
      writeStdout(formatHumanTrace(args, filtered))
    }
    return 0
  } catch (error) {
    emitError(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    try {
      journal.close?.()
    } catch {
      // Best-effort close; the replay outcome is already decided.
    }
  }
}
