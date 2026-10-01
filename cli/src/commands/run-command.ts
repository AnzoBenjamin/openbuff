import { getProjectRoot } from '../project-files'
import { getCodebuffClient } from '../utils/codebuff-client'

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
  }
}
