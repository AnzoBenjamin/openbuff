import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { AcpSessionData, runServe } from '@openbuff/sdk'

import { getProjectRoot } from './project-files'
import { getCodebuffClient } from './utils/codebuff-client'

import type { ServeBridgeClient } from '@openbuff/sdk'

/**
 * The parsed `openbuff serve` transport selection (mirrors
 * `ParsedArgs.serve`): stdio serves ACP over the process stdio streams, and
 * socket serves it over a SEC-4-authenticated unix domain socket with an
 * optional caller-supplied token.
 */
export type ServeCommandArgs =
  | { transport: 'stdio' }
  | { transport: 'socket'; socketPath: string; token?: string }

/**
 * Fully-injectable seams for `runAcpServeCommand`. Every dependency defaults
 * to the real CLI/SDK implementation, so production callers pass nothing and
 * tests inject hermetic stubs (never touching a real client, socket, or fs).
 */
export type RunAcpServeDeps = {
  getClient?: () => Promise<ServeBridgeClient>
  makeSessionData?: (opts: { journalDir: string }) => AcpSessionData
  runServeImpl?: typeof runServe
  generateToken?: () => string
  writeStderr?: (line: string) => void
  journalDir?: string
  signal?: AbortSignal
}

/**
 * The `openbuff serve` entry the CLI dispatches BEFORE the TUI. It builds the
 * journal-backed `AcpSessionData` and the real `OpenbuffClient`, then starts
 * the ACP bridge on the chosen transport and returns its `{ close }`.
 *
 * stdout is the ACP protocol wire in serve mode, so EVERY human-readable line
 * goes to stderr via `writeStderr` — nothing is ever written to stdout here.
 * For socket mode the token is generated when the user did not pass one and
 * printed (with the socket path) to stderr so a client can connect. The
 * journal directory makes ACP sessions restore across process restarts.
 */
export async function runAcpServeCommand(
  args: ServeCommandArgs,
  deps?: RunAcpServeDeps,
): Promise<{ close: () => Promise<void> }> {
  const getClient = deps?.getClient ?? (() => getCodebuffClient())
  const makeSessionData =
    deps?.makeSessionData ??
    (({ journalDir }: { journalDir: string }) =>
      new AcpSessionData({ journalDir }))
  const runServeImpl = deps?.runServeImpl ?? runServe
  const generateToken =
    deps?.generateToken ?? (() => randomBytes(32).toString('hex'))
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))
  // Resolve getProjectRoot() lazily here (after initializeApp has run in
  // index.tsx), never at module load; tests that inject journalDir never call it.
  const journalDir =
    deps?.journalDir ??
    path.join(getProjectRoot(), '.openbuff', 'acp-journal')

  const sessionData = makeSessionData({ journalDir })
  const client = await getClient()

  if (args.transport === 'stdio') {
    // Human line to STDERR only — stdout is the ACP protocol wire.
    writeStderr('openbuff serve: ACP v1 over stdio')
    return runServeImpl({
      client,
      sessionData,
      transport: { kind: 'stdio' },
      signal: deps?.signal,
    })
  }

  const token = args.token ?? generateToken()
  const listener = runServeImpl({
    client,
    sessionData,
    transport: { kind: 'socket', socketPath: args.socketPath, token },
    signal: deps?.signal,
  })
  // Connection info to STDERR so a client can connect; token never hits stdout.
  writeStderr(`openbuff serve: ACP v1 over unix socket ${args.socketPath}`)
  writeStderr(`openbuff serve token: ${token}`)
  return listener
}
