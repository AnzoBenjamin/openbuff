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
 * (`json`) or a plain text stream, and an optional agent id override
 * (defaults to 'base').
 */
export type RunCommandArgs = {
  prompt: string
  json: boolean
  agentId?: string
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

  const handleEvent = (event: PrintModeEvent): void => {
    if (args.json) {
      writeStdout(JSON.stringify(event) + '\n')
      return
    }
    if (event.type === 'text') {
      writeStdout(event.text)
    }
  }

  writeStderr(
    `openbuff run: running agent ${args.agentId ?? 'base'} (project root ${projectRoot})`,
  )

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
      ...(deps?.signal ? { signal: deps.signal } : {}),
    })
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (args.json) {
      // Keep stdout strictly ndjson: the failure is one machine-readable line.
      writeStdout(JSON.stringify({ type: 'error', message }) + '\n')
    }
    writeStderr(`openbuff run: ${message}`)
    return 1
  } finally {
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
